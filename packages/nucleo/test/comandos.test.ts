import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Evento, type InfoComando, RUTA_RPC } from "@aquiles/protocolo";
import { analizarComando, instruccionObjetivo, instruccionSkill } from "../src/comandos";
import { leer } from "../src/herramientas/leer";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { iniciarServidor, type Servidor } from "../src/servidor";
import type { Proveedor } from "../src/tipos";

const TOKEN = "token-de-prueba-comandos-0123";
let servidor: Servidor;
let cwd = "";
let proyecto = "";
let perfil = "";

/** Guion: resume si se lo piden, contesta al juez con JSON, lee si le dicen «lee» y si no, «vale». */
function guion(): ProveedorSimulado {
  let n = 0;
  return new ProveedorSimulado([
    (p) => {
      const ultimo = p.mensajes.at(-1);
      if (p.sistema.includes("juez de objetivos")) return { texto: '{"cumplido":true,"motivo":"Está hecho"}', llamadas: [] };
      if (ultimo?.rol === "herramienta") return { texto: "hecho", llamadas: [] };
      const pide = ultimo?.rol === "usuario" ? ultimo.texto : "";
      if (pide.startsWith("Resume la conversación")) return { texto: "Resumen de prueba.", llamadas: [] };
      if (pide.startsWith("lee")) return { texto: "", llamadas: [{ id: `l${++n}`, nombre: "leer", argumentos: { ruta: "hola.txt" } }] };
      return { texto: "vale", llamadas: [] };
    },
  ]);
}

async function skill(raiz: string, nombre: string, descripcion: string): Promise<void> {
  await mkdir(join(raiz, nombre), { recursive: true });
  await writeFile(join(raiz, nombre, "SKILL.md"), `---\nname: ${nombre}\ndescription: ${descripcion}\n---\n\n# ${nombre}\n\nPasos.\n`);
}

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "aquiles-cmd-"));
  proyecto = await mkdtemp(join(tmpdir(), "aquiles-cmd-proyecto-"));
  perfil = await mkdtemp(join(tmpdir(), "aquiles-cmd-perfil-"));
  await writeFile(join(cwd, "hola.txt"), "a\nb\nc\n");
  await writeFile(join(proyecto, "hola.txt"), "a\n");
  await skill(join(perfil, "skills"), "resumir-informes", "Resume informes\n  largos en una página.");
  await skill(join(perfil, "skills"), "apagada", "Una skill desactivada.");
  // Se llama como un comando de Aquiles: gana el de Aquiles.
  await skill(join(perfil, "skills"), "aprender", "Una skill que se llama igual que /aprender.");
  await skill(join(proyecto, ".aquiles", "skills"), "de-proyecto", "Solo en la carpeta del proyecto.");
  const proveedor = guion();
  // Un modelo que guarda su propia conversación (como agy o claude): no se puede compactar.
  const propia: Proveedor = Object.assign(guion(), { nombre: "propia", conversacionPropia: true });
  servidor = iniciarServidor({
    puerto: 0, token: TOKEN, proveedor: "simulado", fabrica: (nombre) => (nombre === "propia" ? propia : proveedor), herramientas: [leer],
    cwdPorDefecto: cwd, version: "0.0.0", perfil,
  });
});
afterAll(() => servidor.detener());

async function cliente() {
  const ws = await new Promise<WebSocket>((ok, mal) => {
    const w = new WebSocket(`ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=${TOKEN}`);
    w.onopen = () => ok(w);
    w.onerror = () => mal(new Error("rechazado"));
  });
  let n = 0;
  const pendientes = new Map<number, (r: any) => void>();
  const eventos: Evento[] = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.method === "evento") eventos.push(d.params);
    else if (d.method && typeof d.id === "string") ws.send(JSON.stringify({ jsonrpc: "2.0", id: d.id, result: { decision: "permitir" } }));
    else pendientes.get(d.id)?.(d);
  };
  const llamar = (method: string, params?: unknown) =>
    new Promise<any>((ok) => {
      n += 1;
      pendientes.set(n, ok);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    });
  /** Primer evento desde `desde` que cumple `si` (espera hasta 3 s). */
  const esperar = async <T extends Evento>(si: (e: Evento) => e is T, desde = 0): Promise<T> => {
    for (let i = 0; i < 300; i++) {
      const e = eventos.slice(desde).find(si);
      if (e) return e;
      await Bun.sleep(10);
    }
    throw new Error("no llegó el evento");
  };
  /** Envía y espera su turno.fin; devuelve el fin y el historial de la sesión. */
  const enviar = async (sesionId: string, texto: string) => {
    const desde = eventos.length;
    const r = await llamar("prompt.enviar", { sesionId, texto });
    expect(r.result).toEqual({ aceptado: true });
    const fin = await esperar((e): e is Extract<Evento, { tipo: "turno.fin" }> => e.tipo === "turno.fin" && e.sesionId === sesionId, desde);
    // El turno.fin sale antes de soltar la sesión en los turnos del modelo.
    for (let i = 0; i < 100 && (await llamar("sesion.reanudar", { sesionId })).result.trabajando; i++) await Bun.sleep(10);
    const { historial } = (await llamar("sesion.reanudar", { sesionId })).result;
    return { fin, historial: historial as { rol: string; texto?: string }[], desde };
  };
  return { ws, eventos, llamar, esperar, enviar };
}

const nombres = (l: InfoComando[]) => l.map((c) => c.nombre);

test("analizarComando: nombre y argumentos, y lo que no es un comando", () => {
  expect(analizarComando("/aprender")).toEqual({ nombre: "aprender", argumentos: "" });
  expect(analizarComando("  /aprender   C:\\docs\\api  ")).toEqual({ nombre: "aprender", argumentos: "C:\\docs\\api" });
  expect(analizarComando("/objetivo\nque pasen los tests")).toEqual({ nombre: "objetivo", argumentos: "que pasen los tests" });
  expect(analizarComando("/usr/bin/ls -la")).toBeUndefined();
  expect(analizarComando("mira /aprender")).toBeUndefined();
  expect(analizarComando("/")).toBeUndefined();
});

test("comandos.listar: los de Aquiles, uno por skill activa, y compactar solo si se puede", async () => {
  const c = await cliente();
  await c.llamar("skills.ajustar", { nombre: "apagada", activa: false });

  // Sin sesión: no hay nada que compactar; las skills son las de la carpeta por defecto.
  const sin: InfoComando[] = (await c.llamar("comandos.listar", {})).result.comandos;
  expect(nombres(sin)).toEqual(["aprender", "objetivo", "resumir-informes"]);
  expect(sin.find((x) => x.nombre === "aprender")).toEqual({
    nombre: "aprender", argumentos: "[fuente]", descripcion: expect.stringContaining("URL"), origen: "aquiles",
  });
  expect(sin.find((x) => x.nombre === "resumir-informes")).toEqual({
    nombre: "resumir-informes", argumentos: "[texto]", descripcion: "Resume informes largos en una página.", origen: "skill",
  });

  // Con sesión en otra carpeta: también sus skills de proyecto, y compactar.
  const s = (await c.llamar("sesion.crear", { cwd: proyecto })).result;
  const con: InfoComando[] = (await c.llamar("comandos.listar", { sesionId: s.sesionId })).result.comandos;
  expect(nombres(con)).toEqual(["aprender", "compactar", "objetivo", "de-proyecto", "resumir-informes"]);
  expect(con.find((x) => x.nombre === "compactar")).toMatchObject({ origen: "aquiles" });
  expect(con.find((x) => x.nombre === "compactar")?.argumentos).toBeUndefined();

  // Un modelo con su propia conversación no se deja compactar.
  const p = (await c.llamar("sesion.crear", { proveedor: "propia" })).result;
  expect(nombres((await c.llamar("comandos.listar", { sesionId: p.sesionId })).result.comandos)).not.toContain("compactar");

  expect((await c.llamar("comandos.listar", { sesionId: "no-existe" })).error.code).toBe(1001);
  c.ws.close();
});

test("/skill lanza un turno que pide cargarla; una desactivada o un comando desconocido van como texto", async () => {
  const c = await cliente();
  const s = (await c.llamar("sesion.crear", { cwd: proyecto })).result;

  let r = await c.enviar(s.sesionId, "/resumir-informes el de marzo");
  expect(r.fin).toMatchObject({ motivo: "fin", texto: "vale" });
  expect(r.historial.at(-2)).toEqual({ rol: "usuario", texto: instruccionSkill("resumir-informes", "el de marzo") });
  expect(instruccionSkill("resumir-informes", "el de marzo")).toContain("ver_skill");
  // La sesión se titula empezando por lo que escribió el usuario.
  expect((await c.llamar("sesion.reanudar", { sesionId: s.sesionId })).result.titulo).toStartWith("/resumir-informes el de marzo");

  r = await c.enviar(s.sesionId, "/de-proyecto");
  expect(r.historial.at(-2)?.texto).toBe(instruccionSkill("de-proyecto", ""));

  r = await c.enviar(s.sesionId, "/apagada algo");
  expect(r.historial.at(-2)).toEqual({ rol: "usuario", texto: "/apagada algo" });

  r = await c.enviar(s.sesionId, "/noexiste hola");
  expect(r.historial.at(-2)).toEqual({ rol: "usuario", texto: "/noexiste hola" });

  // Una skill de proyecto no vale en una sesión de otra carpeta.
  const otra = (await c.llamar("sesion.crear", {})).result;
  r = await c.enviar(otra.sesionId, "/de-proyecto");
  expect(r.historial.at(-2)).toEqual({ rol: "usuario", texto: "/de-proyecto" });
  c.ws.close();
});

test("/aprender con fuente estudia la fuente; sin nada, revisa la conversación", async () => {
  const c = await cliente();
  const s = (await c.llamar("sesion.crear", {})).result;
  let r = await c.enviar(s.sesionId, "/aprender docs/api");
  expect(r.fin).toMatchObject({ motivo: "fin" });
  expect(r.historial.at(-2)?.texto).toStartWith("Aprende de esta fuente: docs/api");

  r = await c.enviar(s.sesionId, "/aprender");
  expect(r.fin).toMatchObject({ motivo: "fin" });
  expect(c.eventos.slice(r.desde).filter((e) => e.tipo === "aprendizaje.revision").map((e) => (e as { estado: string }).estado)).toEqual(["inicio", "fin"]);
  expect(r.historial.slice(-2).map((m) => m.rol)).toEqual(["usuario", "asistente"]);
  expect(r.historial.at(-2)?.texto).toBe("/aprender");
  c.ws.close();
});

test("/objetivo fija el objetivo y trabaja en él; sin texto lo quita", async () => {
  const c = await cliente();
  const s = (await c.llamar("sesion.crear", {})).result;
  const r = await c.enviar(s.sesionId, "/objetivo que pasen los tests");
  expect(r.historial.at(-2)?.texto).toBe(instruccionObjetivo("que pasen los tests"));
  const evaluado = await c.esperar((e): e is Extract<Evento, { tipo: "objetivo.evaluado" }> => e.tipo === "objetivo.evaluado" && e.sesionId === s.sesionId, r.desde);
  expect(evaluado.objetivo).toMatchObject({ texto: "que pasen los tests", estado: "cumplido", motivo: "Está hecho" });
  expect((await c.llamar("sesion.reanudar", { sesionId: s.sesionId })).result.objetivo).toMatchObject({ texto: "que pasen los tests" });

  let q = await c.enviar(s.sesionId, "/objetivo");
  expect(q.fin).toMatchObject({ motivo: "fin", texto: "He quitado el objetivo: que pasen los tests" });
  expect((await c.llamar("sesion.reanudar", { sesionId: s.sesionId })).result.objetivo).toBeUndefined();
  q = await c.enviar(s.sesionId, "/objetivo");
  expect(q.fin.texto).toStartWith("Esta sesión no tiene objetivo");
  c.ws.close();
});

test("/compactar resume la parte antigua; en una conversación corta o con un modelo con su propia conversación, lo dice", async () => {
  const c = await cliente();
  const s = (await c.llamar("sesion.crear", {})).result;
  let r = await c.enviar(s.sesionId, "/compactar");
  expect(r.fin).toMatchObject({ motivo: "fin", texto: "La conversación aún es corta: no hay nada que compactar." });

  for (let i = 0; i < 4; i++) await c.enviar(s.sesionId, `lee hola.txt ${i}`);
  r = await c.enviar(s.sesionId, "/compactar");
  expect(r.fin).toMatchObject({ motivo: "fin" });
  expect(r.fin.texto).toStartWith("He compactado la conversación (resumen)");
  expect(r.historial[0]).toEqual({ rol: "resumen", texto: "Resumen de prueba." });
  expect(r.historial.slice(-2)).toEqual([
    { rol: "usuario", texto: "/compactar" },
    { rol: "asistente", texto: r.fin.texto },
  ]);
  expect(c.eventos.slice(r.desde)).toContainEqual(expect.objectContaining({ tipo: "contexto.uso", sesionId: s.sesionId }));

  const p = (await c.llamar("sesion.crear", { proveedor: "propia" })).result;
  r = await c.enviar(p.sesionId, "/compactar");
  expect(r.fin.texto).toBe("propia lleva su propia conversación: Aquiles no puede compactarla.");
  c.ws.close();
});
