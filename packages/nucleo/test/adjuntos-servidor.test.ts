import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codigosError, type Evento, RUTA_RPC } from "@aquiles/protocolo";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { iniciarServidor, type Servidor } from "../src/servidor";
import type { Mensaje } from "../src/tipos";
import { png } from "./ficheros-prueba";

const TOKEN = "token-de-prueba-adjuntos-0123";
let servidor: Servidor;
let raiz = "";
let perfil = "";
/** Último mensaje del usuario que recibió el modelo. */
let recibido: Mensaje | undefined;
const imagen = png(3, 3, [0, 128, 255]);

beforeAll(async () => {
  raiz = await mkdtemp(join(tmpdir(), "aquiles-srv-adjuntos-"));
  perfil = join(raiz, "perfil");
  await writeFile(join(raiz, "nota.txt"), "contenido de la nota");
  const proveedor = new ProveedorSimulado([
    (p) => {
      recibido = p.mensajes.findLast((m) => m.rol === "usuario");
      return { texto: "visto", llamadas: [] };
    },
  ]);
  servidor = iniciarServidor({
    puerto: 0, token: TOKEN, proveedor: "simulado", fabrica: () => proveedor, herramientas: [],
    cwdPorDefecto: raiz, version: "0.0.0", perfil,
  });
});
afterAll(async () => {
  await servidor.detener();
  await rm(raiz, { recursive: true, force: true });
});

async function conectar() {
  const ws = new WebSocket(`ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=${TOKEN}`);
  await new Promise((ok, mal) => {
    ws.onopen = ok;
    ws.onerror = mal;
  });
  let n = 0;
  const pendientes = new Map<number, (r: any) => void>();
  const eventos: Evento[] = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.method === "evento") eventos.push(d.params);
    else pendientes.get(d.id)?.(d);
  };
  return {
    ws,
    eventos,
    llamar: (method: string, params?: unknown) =>
      new Promise<any>((ok) => {
        pendientes.set(++n, ok);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
      }),
    esperarFin: async (sesionId: string) => {
      for (let i = 0; i < 300 && !eventos.some((e) => e.tipo === "turno.fin" && e.sesionId === sesionId); i++) await Bun.sleep(10);
      return eventos.find((e) => e.tipo === "turno.fin" && e.sesionId === sesionId);
    },
  };
}

test("prompt.enviar con adjuntos: se guardan, el modelo los recibe, quedan en el historial y se pueden leer", async () => {
  const c = await conectar();
  const { result: s } = await c.llamar("sesion.crear", {});
  const enviado = await c.llamar("prompt.enviar", {
    sesionId: s.sesionId,
    texto: "",
    adjuntos: [
      { nombre: "nota.txt", ruta: join(raiz, "nota.txt") },
      { nombre: "captura", tipo: "image/png", datos: imagen.toString("base64") },
    ],
  });
  expect(enviado.result).toEqual({ aceptado: true });
  expect(await c.esperarFin(s.sesionId)).toMatchObject({ motivo: "fin", texto: "visto" });

  // El modelo recibe el mensaje con los adjuntos ya guardados y el texto extraído.
  expect(recibido?.rol).toBe("usuario");
  const [nota, captura] = recibido?.rol === "usuario" ? (recibido.adjuntos ?? []) : [];
  expect(nota).toMatchObject({ nombre: "nota.txt", clase: "texto", texto: "contenido de la nota" });
  expect(captura).toMatchObject({ nombre: "captura", tipo: "image/png", clase: "imagen", bytes: imagen.length });
  const dir = join(perfil, "adjuntos", s.sesionId);
  expect(nota!.ruta.startsWith(dir)).toBe(true);
  expect(readFileSync(captura!.ruta).equals(imagen)).toBe(true);
  // En el JSONL va tal cual, con el texto.
  expect(readFileSync(join(perfil, "sesiones", `${s.sesionId}.jsonl`), "utf8")).toContain('"texto":"contenido de la nota"');

  // El historial, sin el texto extraído: solo cuántos caracteres son.
  const { result: r } = await c.llamar("sesion.reanudar", { sesionId: s.sesionId });
  expect(r.titulo).toBe("nota.txt, captura");
  expect(r.historial[0]).toEqual({
    rol: "usuario",
    texto: "",
    adjuntos: [
      { id: nota!.id, nombre: "nota.txt", tipo: "text/plain", bytes: 20, clase: "texto", caracteres: 20, ruta: nota!.ruta },
      { id: captura!.id, nombre: "captura", tipo: "image/png", bytes: imagen.length, clase: "imagen", ruta: captura!.ruta },
    ],
  });

  expect((await c.llamar("adjuntos.leer", { sesionId: s.sesionId, id: captura!.id })).result).toEqual({ tipo: "image/png", datos: imagen.toString("base64") });
  // Solo los de esa sesión.
  const { result: otra } = await c.llamar("sesion.crear", {});
  expect((await c.llamar("adjuntos.leer", { sesionId: otra.sesionId, id: captura!.id })).error.code).toBe(codigosError.paramsInvalidos);
  expect((await c.llamar("adjuntos.leer", { sesionId: s.sesionId, id: "../../x" })).error.code).toBe(codigosError.paramsInvalidos);

  // Al borrar la sesión se van sus adjuntos.
  await c.llamar("sesion.borrar", { sesionId: s.sesionId });
  expect(existsSync(dir)).toBe(false);
  c.ws.close();
});

test("un adjunto que no vale: -32602 con el motivo y el turno no empieza", async () => {
  const c = await conectar();
  const { result: s } = await c.llamar("sesion.crear", {});
  const malo = await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "mira", adjuntos: [{ nombre: "../fuera.txt", datos: "aG9sYQ==" }] });
  expect(malo.error.code).toBe(codigosError.paramsInvalidos);
  expect(malo.error.message).toContain("sin rutas");
  const noExiste = await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "mira", adjuntos: [{ nombre: "x.txt", ruta: join(raiz, "no-existe.txt") }] });
  expect(noExiste.error.message).toContain("No existe");
  // Ni texto ni adjuntos: lo rechaza el protocolo.
  expect((await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: " " })).error.code).toBe(codigosError.paramsInvalidos);
  await Bun.sleep(50);
  // Ningún evento de turno (deltas, fin…) en esa sesión.
  expect(c.eventos.some((e) => (e as { sesionId?: string }).sesionId === s.sesionId)).toBe(false);
  expect((await c.llamar("sesion.reanudar", { sesionId: s.sesionId })).result.historial).toEqual([]);
  c.ws.close();
});

test("el motor también acepta adjuntos (para los canales)", async () => {
  const { sesionId, resultado } = await servidor.motor.turno({ texto: "de un canal", adjuntos: [{ nombre: "nota.txt", ruta: join(raiz, "nota.txt") }] });
  expect(resultado.motivo).toBe("fin");
  expect(recibido).toMatchObject({ rol: "usuario", texto: "de un canal", adjuntos: [{ nombre: "nota.txt", texto: "contenido de la nota" }] });
  expect(existsSync(join(perfil, "adjuntos", sesionId))).toBe(true);
  await expect(servidor.motor.turno({ sesionId, texto: "x", adjuntos: [{ nombre: "a/b.txt", datos: "" }] })).rejects.toThrow("sin rutas");
});
