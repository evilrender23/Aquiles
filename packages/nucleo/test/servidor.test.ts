import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUTA_RPC, VERSION_PROTOCOLO, type Evento } from "@aquiles/protocolo";
import { leer } from "../src/herramientas/leer";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { iniciarServidor, type Servidor } from "../src/servidor";
import { herramientaEco } from "./turno-prueba";

const TOKEN = "token-de-prueba-0123456789";
let servidor: Servidor;
let cwd = "";
let perfil = "";
/** System prompt de la última llamada al modelo. */
let ultimoSistema = "";

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "aquiles-srv-"));
  perfil = await mkdtemp(join(tmpdir(), "aquiles-perfil-"));
  await writeFile(join(cwd, "hola.txt"), "a\nb\nc\n");
  // Guion: si el último mensaje es del usuario y pide "eco", llama a eco; si pide "lee", llama a leer; si hay resultado, contesta.
  const proveedor = new ProveedorSimulado([
    (p) => {
      ultimoSistema = p.sistema;
      const ultimo = p.mensajes.at(-1);
      if (ultimo?.rol === "herramienta") return { texto: `resultado: ${ultimo.resultado.split("\n").length} líneas, error=${ultimo.error}`, llamadas: [] };
      const pide = ultimo?.rol === "usuario" ? ultimo.texto : "";
      if (pide.includes("eco")) return { texto: "", llamadas: [{ id: "e1", nombre: "eco", argumentos: { texto: "rm -rf x" } }] };
      return { texto: "Leo.", llamadas: [{ id: "l1", nombre: "leer", argumentos: { ruta: "hola.txt" } }] };
    },
  ]);
  servidor = iniciarServidor({
    puerto: 0, token: TOKEN, proveedor: "simulado", fabrica: () => proveedor, herramientas: [leer, herramientaEco()],
    cwdPorDefecto: cwd, version: "0.0.0", perfil, incluirSimulado: true,
  });
});
afterAll(() => servidor.detener());

const url = (token = TOKEN) => `ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=${token}`;

function conectar(token = TOKEN): Promise<WebSocket> {
  return new Promise((ok, mal) => {
    const ws = new WebSocket(url(token));
    ws.onopen = () => ok(ws);
    ws.onerror = () => mal(new Error("rechazado"));
  });
}

function rpc(ws: WebSocket, alPedir?: (metodo: string, params: any) => unknown) {
  let n = 0;
  const pendientes = new Map<number, (r: any) => void>();
  const eventos: Evento[] = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.method === "evento") eventos.push(d.params);
    else if (d.method && typeof d.id === "string") ws.send(JSON.stringify({ jsonrpc: "2.0", id: d.id, result: alPedir?.(d.method, d.params) }));
    else pendientes.get(d.id)?.(d);
  };
  const esperarFin = async () => {
    for (let i = 0; i < 200 && !eventos.some((e) => e.tipo === "turno.fin"); i++) await Bun.sleep(10);
    return eventos.find((e) => e.tipo === "turno.fin");
  };
  return {
    eventos,
    esperarFin,
    llamar: (method: string, params?: unknown) =>
      new Promise<any>((ok) => {
        n += 1;
        pendientes.set(n, ok);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
      }),
  };
}

test("rechaza token malo y origen ajeno", async () => {
  expect((await fetch(url("malo").replace("ws:", "http:"))).status).toBe(401);
  const ajeno = await fetch(url().replace("ws:", "http:"), { headers: { origin: "https://evil.example" } });
  expect(ajeno.status).toBe(403);
  await expect(conectar("malo")).rejects.toThrow();
});

test("turno completo, persistencia y reanudar", async () => {
  const ws = await conectar();
  const c = rpc(ws);
  expect((await c.llamar("nucleo.info", {})).result).toMatchObject({ proveedor: "simulado", protocolo: VERSION_PROTOCOLO });
  const { result: s } = await c.llamar("sesion.crear", {});
  expect(s).toMatchObject({ cwd, modoAprobacion: "preguntar-ejecutar" });
  expect((await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "lee hola.txt" })).result).toEqual({ aceptado: true });
  expect((await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "otra" })).error.code).toBe(1002);
  expect(await c.esperarFin()).toMatchObject({ motivo: "fin", texto: "resultado: 3 líneas, error=false" });

  const lista = (await c.llamar("sesion.listar", {})).result.sesiones;
  expect(lista.find((x: any) => x.sesionId === s.sesionId)).toMatchObject({ titulo: "lee hola.txt", mensajes: 4 });
  const r = (await c.llamar("sesion.reanudar", { sesionId: s.sesionId })).result;
  expect(r.historial.map((m: any) => m.rol)).toEqual(["usuario", "asistente", "herramienta", "asistente"]);
  expect((await c.llamar("prompt.steer", { sesionId: s.sesionId, texto: "x" })).error.code).toBe(1003);
  ws.close();
});

test("el núcleo pide aprobación a la interfaz y respeta la respuesta", async () => {
  const pedidas: any[] = [];
  const ws = await conectar();
  const c = rpc(ws, (metodo, params) => {
    pedidas.push({ metodo, params });
    return { decision: "denegar" };
  });
  const { result: s } = await c.llamar("sesion.crear", {});
  await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "haz eco" });
  expect(await c.esperarFin()).toMatchObject({ motivo: "fin", texto: "resultado: 1 líneas, error=true" });
  expect(pedidas[0]).toMatchObject({ metodo: "aprobacion.pedir", params: { sesionId: s.sesionId, herramienta: "eco", resumen: "eco rm -rf x" } });
  ws.close();
});

test("ajustes, ajustar, renombrar, borrar y sesion.actualizada", async () => {
  const ws = await conectar();
  const c = rpc(ws);
  expect((await c.llamar("ajustes.leer", {})).result).toEqual({
    proveedor: "simulado", modoAprobacion: "preguntar-ejecutar", carpeta: cwd,
    aprendizaje: { activo: true, cadaHerramientas: 10, cadaMensajes: 10, aplicarSinPreguntar: false },
    herramientas: { navegador: false, terminal: { entorno: "local", imagen: "oven/bun:debian" }, guardian: { activo: false } },
  });
  const otra = await mkdtemp(join(tmpdir(), "aquiles-otra-"));
  expect((await c.llamar("ajustes.guardar", { carpeta: otra, modoAprobacion: "libre-proyecto" })).result).toMatchObject({ carpeta: otra });
  const { result: s } = await c.llamar("sesion.crear", {});
  expect(s).toMatchObject({ cwd: otra, modoAprobacion: "libre-proyecto", proveedor: "simulado", trabajando: false });

  const a = (await c.llamar("sesion.ajustar", { sesionId: s.sesionId, modoAprobacion: "preguntar-siempre", modelo: "x" })).result;
  expect(a).toMatchObject({ modoAprobacion: "preguntar-siempre", modelo: "x" });
  expect((await c.llamar("sesion.renombrar", { sesionId: s.sesionId, titulo: "Mi sesión" })).result.titulo).toBe("Mi sesión");
  expect(c.eventos.filter((e) => e.tipo === "sesion.actualizada").length).toBeGreaterThanOrEqual(3);

  const reabierta = (await c.llamar("sesion.reanudar", { sesionId: s.sesionId })).result;
  expect(reabierta).toMatchObject({ titulo: "Mi sesión", modelo: "x", modoAprobacion: "preguntar-siempre" });
  expect((await c.llamar("sesion.borrar", { sesionId: s.sesionId })).result).toEqual({ borrada: true });
  expect((await c.llamar("sesion.reanudar", { sesionId: s.sesionId })).error.code).toBe(1001);
  expect((await c.llamar("proveedores.listar", {})).result.proveedores.some((p: any) => p.id === "simulado" && p.disponible)).toBe(true);
  expect((await c.llamar("ajustes.clave", { proveedor: "simulado", clave: "x" })).error.code).toBe(-32602);
  await c.llamar("ajustes.guardar", { carpeta: cwd, modoAprobacion: "preguntar-ejecutar" });
  ws.close();
});

test("errores JSON-RPC", async () => {
  const ws = await conectar();
  const c = rpc(ws);
  expect((await c.llamar("no.existe", {})).error.code).toBe(-32601);
  expect((await c.llamar("prompt.enviar", { sesionId: "" })).error.code).toBe(-32602);
  expect((await c.llamar("prompt.enviar", { sesionId: "x", texto: "hola" })).error.code).toBe(1001);
  // Carpeta de trabajo que no existe, relativa o que es un fichero: se rechaza al crear la sesión.
  for (const malo of [join(cwd, "no-existe"), "relativa", join(perfil, "ajustes.json")]) {
    const r = await c.llamar("sesion.crear", { cwd: malo });
    expect(r.error?.code).toBe(-32602);
  }
  expect((await c.llamar("sesion.crear", { cwd })).result.cwd).toBe(cwd);
  ws.close();
});

test("memoria, skills y búsqueda: lo guardado entra en la sesión siguiente", async () => {
  const ws = await conectar();
  const c = rpc(ws);
  const guardado = (await c.llamar("memoria.guardar", { destino: "usuario", entradas: ["Prefiere respuestas cortas"] })).result;
  expect(guardado).toMatchObject({ entradas: ["Prefiere respuestas cortas"], limite: 1400 });
  expect(guardado.usados).toBeGreaterThan(0);
  expect(c.eventos).toContainEqual({ tipo: "memoria.actualizada", destino: "usuario" });
  expect((await c.llamar("memoria.guardar", { destino: "usuario", entradas: ["x".repeat(2000)] })).error.code).toBe(-32602);
  expect((await c.llamar("memoria.guardar", { destino: "proyecto", entradas: ["sin carpeta"] })).error.code).toBe(-32602);
  await c.llamar("memoria.guardar", { destino: "proyecto", cwd, entradas: ["Los tests van con bun test"] });
  expect((await c.llamar("memoria.alma", { texto: "Tono seco." })).result).toEqual({ texto: "Tono seco." });
  const leida = (await c.llamar("memoria.leer", { cwd })).result;
  expect(leida).toMatchObject({ alma: "Tono seco.", proyecto: { cwd, entradas: ["Los tests van con bun test"] } });

  await mkdir(join(perfil, "skills", "probar-cosas"), { recursive: true });
  await writeFile(join(perfil, "skills", "probar-cosas", "SKILL.md"), "---\nname: probar-cosas\ndescription: Cómo probar cosas.\n---\n\n1. Probar.\n");
  expect((await c.llamar("skills.listar", { cwd })).result.skills).toMatchObject([{ nombre: "probar-cosas", origen: "manual", activa: true }]);

  const { result: s } = await c.llamar("sesion.crear", {});
  await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "lee la receta de cebolleta" });
  await c.esperarFin();
  for (const parte of ["Prefiere respuestas cortas", "Los tests van con bun test", "Tono seco.", "probar-cosas — Cómo probar cosas."]) {
    expect(ultimoSistema).toContain(parte);
  }
  const resultados = (await c.llamar("buscar.sesiones", { consulta: "cebolleta" })).result.resultados;
  expect(resultados[0]).toMatchObject({ sesionId: s.sesionId, rol: "usuario" });
  expect(resultados[0].fragmento).toContain("«cebolleta»");

  expect((await c.llamar("skills.ajustar", { nombre: "probar-cosas", activa: false, cwd })).result.activa).toBe(false);
  expect(c.eventos).toContainEqual({ tipo: "skills.actualizadas" });
  expect((await c.llamar("skills.leer", { nombre: "no-existe" })).error.code).toBe(-32602);
  await c.llamar("sesion.borrar", { sesionId: s.sesionId });
  expect((await c.llamar("buscar.sesiones", { consulta: "cebolleta" })).result.resultados).toEqual([]);
  ws.close();
});

test("aprendizaje: ajustes anidados, /aprender revisa la conversación y la cola empieza vacía", async () => {
  const ws = await conectar();
  const c = rpc(ws);
  const a = (await c.llamar("ajustes.guardar", { aprendizaje: { cadaMensajes: 3 } })).result;
  expect(a.aprendizaje).toEqual({ activo: true, cadaHerramientas: 10, cadaMensajes: 3, aplicarSinPreguntar: false });
  expect((await c.llamar("aprendizaje.listar", {})).result).toEqual({ propuestas: [] });
  const { result: s } = await c.llamar("sesion.crear", {});
  await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "lee hola.txt" });
  await c.esperarFin();
  c.eventos.length = 0;
  expect((await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "/aprender" })).result).toEqual({ aceptado: true });
  const fin = await c.esperarFin();
  expect(fin).toMatchObject({ motivo: "fin" });
  expect(c.eventos.filter((e) => e.tipo === "aprendizaje.revision").map((e) => (e as { estado: string }).estado)).toEqual(["inicio", "fin"]);
  const r = (await c.llamar("sesion.reanudar", { sesionId: s.sesionId })).result;
  expect(r.historial.slice(-2).map((m: any) => m.rol)).toEqual(["usuario", "asistente"]);
  // Lo que hay viene de las ediciones a mano del test anterior.
  expect((await c.llamar("aprendizaje.historial", {})).result.entradas.every((e: any) => e.origen.tipo === "manual")).toBe(true);
  await c.llamar("ajustes.guardar", { aprendizaje: { cadaMensajes: 10 } });
  ws.close();
});
