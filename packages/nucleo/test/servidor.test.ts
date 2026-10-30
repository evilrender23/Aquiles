import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUTA_RPC, type Evento } from "@aquiles/protocolo";
import { leer } from "../src/herramientas/leer";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { iniciarServidor, type Servidor } from "../src/servidor";
import { herramientaEco } from "./turno-prueba";

const TOKEN = "token-de-prueba-0123456789";
let servidor: Servidor;
let cwd = "";
let perfil = "";

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "aquiles-srv-"));
  perfil = await mkdtemp(join(tmpdir(), "aquiles-perfil-"));
  await writeFile(join(cwd, "hola.txt"), "a\nb\nc\n");
  // Guion: si el último mensaje es del usuario y pide "eco", llama a eco; si pide "lee", llama a leer; si hay resultado, contesta.
  const proveedor = new ProveedorSimulado([
    (p) => {
      const ultimo = p.mensajes.at(-1);
      if (ultimo?.rol === "herramienta") return { texto: `resultado: ${ultimo.resultado.split("\n").length} líneas, error=${ultimo.error}`, llamadas: [] };
      const pide = ultimo?.rol === "usuario" ? ultimo.texto : "";
      if (pide.includes("eco")) return { texto: "", llamadas: [{ id: "e1", nombre: "eco", argumentos: { texto: "rm -rf x" } }] };
      return { texto: "Leo.", llamadas: [{ id: "l1", nombre: "leer", argumentos: { ruta: "hola.txt" } }] };
    },
  ]);
  servidor = iniciarServidor({ puerto: 0, token: TOKEN, proveedor, herramientas: [leer, herramientaEco()], cwdPorDefecto: cwd, version: "0.0.0", perfil });
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
  expect((await c.llamar("nucleo.info", {})).result).toMatchObject({ proveedor: "simulado", protocolo: 2 });
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

test("errores JSON-RPC", async () => {
  const ws = await conectar();
  const c = rpc(ws);
  expect((await c.llamar("no.existe", {})).error.code).toBe(-32601);
  expect((await c.llamar("prompt.enviar", { sesionId: "" })).error.code).toBe(-32602);
  expect((await c.llamar("prompt.enviar", { sesionId: "x", texto: "hola" })).error.code).toBe(1001);
  ws.close();
});
