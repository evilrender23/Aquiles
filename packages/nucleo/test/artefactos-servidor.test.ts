import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codigosError, RUTA_RPC } from "@aquiles/protocolo";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { iniciarServidor, type Servidor } from "../src/servidor";

const TOKEN = "token-de-prueba-artefactos-01";
let servidor: Servidor;
let raiz = "";
let sistema = "";
const creados: string[] = [];

beforeAll(async () => {
  raiz = await mkdtemp(join(tmpdir(), "aquiles-srv-artefactos-"));
  servidor = iniciarServidor({
    puerto: 0, token: TOKEN, proveedor: "simulado", herramientas: [], cwdPorDefecto: raiz, version: "0.0.0", perfil: join(raiz, "perfil"),
    fabrica: (nombre, modelo, esfuerzo) => {
      creados.push(`${nombre}|${modelo ?? ""}|${esfuerzo ?? ""}`);
      return new ProveedorSimulado([
        (p) => {
          sistema = p.sistema;
          return { texto: "hecho", llamadas: [] };
        },
      ]);
    },
  });
});
afterAll(async () => {
  await servidor.detener();
  await rm(raiz, { recursive: true, force: true });
});

async function llamar(method: string, params?: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=${TOKEN}`);
  await new Promise((ok, mal) => {
    ws.onopen = ok;
    ws.onerror = mal;
  });
  const r = await new Promise<any>((ok) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id === 1) ok(d);
    };
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
  ws.close();
  return r;
}

test("vista de un artefacto: se sirve sin token, con CSP sandbox, y no da acceso al RPC", async () => {
  const { result } = await llamar("artefactos.vista", { tipo: "html", contenido: "<h1>Hola</h1>" });
  const r = await fetch(`http://127.0.0.1:${servidor.puerto}${result.ruta}`);
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("<h1>Hola</h1>");
  expect(r.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts");
  expect((await fetch(`http://127.0.0.1:${servidor.puerto}/vista/inventada`)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${servidor.puerto}${RUTA_RPC}`)).status).toBe(401);
});

test("guardar un artefacto en la carpeta de la sesión; si existe, yaExiste", async () => {
  const s = (await llamar("sesion.crear", {})).result;
  const ok = await llamar("artefactos.guardar", { sesionId: s.sesionId, nombre: "pagina.html", contenido: "<p>1</p>" });
  expect(ok.result.ruta).toBe(join(raiz, "pagina.html"));
  const repetido = await llamar("artefactos.guardar", { sesionId: s.sesionId, nombre: "pagina.html", contenido: "<p>2</p>" });
  expect(repetido.error.code).toBe(codigosError.yaExiste);
  await llamar("artefactos.guardar", { sesionId: s.sesionId, nombre: "pagina.html", contenido: "<p>2</p>", sobrescribir: true });
  expect(readFileSync(join(raiz, "pagina.html"), "utf8")).toBe("<p>2</p>");
  expect((await llamar("artefactos.guardar", { sesionId: s.sesionId, nombre: "../fuera.html", contenido: "x" })).error.code).toBe(
    codigosError.paramsInvalidos,
  );
});

test("las sesiones de la app llevan las instrucciones de artefactos", async () => {
  const s = (await llamar("sesion.crear", {})).result;
  await llamar("prompt.enviar", { sesionId: s.sesionId, texto: "hola" });
  for (let i = 0; i < 50 && !sistema; i++) await Bun.sleep(20);
  expect(sistema).toContain('<artefacto id="identificador-corto"');
});

test("un nivel de esfuerzo que el proveedor no declara se ignora", async () => {
  const s = (await llamar("sesion.crear", { esfuerzo: "max" })).result;
  expect(s.esfuerzo).toBeUndefined();
  const ajustada = (await llamar("sesion.ajustar", { sesionId: s.sesionId, esfuerzo: "high" })).result;
  expect(ajustada.esfuerzo).toBeUndefined();
  expect((await llamar("ajustes.guardar", { esfuerzo: "high" })).result.esfuerzo).toBeFalsy();
  expect(creados.every((c) => c.endsWith("|"))).toBe(true);
});
