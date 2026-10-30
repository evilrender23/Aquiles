import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUTA_RPC, type Evento } from "@aquiles/protocolo";
import { leer } from "../src/herramientas/leer";
import { guionDemo, ProveedorSimulado } from "../src/proveedores/simulado";
import { iniciarServidor, type Servidor } from "../src/servidor";

const TOKEN = "token-de-prueba-0123456789";
let servidor: Servidor;
let cwd = "";

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "aquiles-srv-"));
  await writeFile(join(cwd, "hola.txt"), "a\nb\nc\n");
  servidor = iniciarServidor({ puerto: 0, token: TOKEN, proveedor: new ProveedorSimulado(guionDemo()), herramientas: [leer], cwdPorDefecto: cwd, version: "0.0.0" });
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

function rpc(ws: WebSocket) {
  let n = 0;
  const pendientes = new Map<number, (r: any) => void>();
  const eventos: Evento[] = [];
  ws.onmessage = (m) => {
    const datos = JSON.parse(String(m.data));
    if (datos.method === "evento") eventos.push(datos.params);
    else pendientes.get(datos.id)?.(datos);
  };
  return {
    eventos,
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

test("turno completo por WebSocket", async () => {
  const ws = await conectar();
  const c = rpc(ws);
  expect((await c.llamar("nucleo.info", {})).result).toMatchObject({ proveedor: "simulado", protocolo: 1 });
  const { result: s } = await c.llamar("sesion.crear", {});
  expect(s.cwd).toBe(cwd);
  expect((await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "lee hola.txt" })).result).toEqual({ aceptado: true });
  // un segundo prompt mientras trabaja se rechaza
  expect((await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "otra" })).error.code).toBe(1002);

  for (let i = 0; i < 100 && !c.eventos.some((e) => e.tipo === "turno.fin"); i++) await Bun.sleep(10);
  const fin = c.eventos.find((e) => e.tipo === "turno.fin");
  expect(fin).toMatchObject({ motivo: "fin", texto: "He leído el fichero: tiene 3 líneas." });
  expect(c.eventos.some((e) => e.tipo === "herramienta.fin" && !e.error)).toBe(true);
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
