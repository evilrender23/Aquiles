import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUTA_RPC, type Evento } from "@aquiles/protocolo";
import { interpretar } from "../src/guardian";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { iniciarServidor, type Servidor } from "../src/servidor";
import type { PeticionModelo, RespuestaModelo } from "../src/tipos";
import { herramientaEco } from "./turno-prueba";

const TOKEN = "token-subagentes-0123456789";
let servidor: Servidor;
let cwd = "";

/** Un solo guion que hace de padre, de hijo y de guardián según lo que recibe. */
function guion(p: PeticionModelo): RespuestaModelo {
  if (p.sistema.includes("guardián")) {
    const pedido = p.mensajes[0]?.rol === "usuario" ? p.mensajes[0].texto : "";
    return { texto: pedido.includes("rm -rf") ? '{"decision":"preguntar","motivo":"borra"}' : '{"decision":"permitir","motivo":"inocuo"}', llamadas: [] };
  }
  const ultimo = p.mensajes.at(-1);
  const primero = p.mensajes[0]?.rol === "usuario" ? p.mensajes[0].texto : "";
  if (primero.startsWith("TAREA")) return { texto: `hecho: ${primero}`, llamadas: [] };
  if (primero.startsWith("eco")) {
    if (ultimo?.rol === "herramienta") return { texto: `eco ${ultimo.error ? "denegado" : "hecho"}`, llamadas: [] };
    return { texto: "", llamadas: [{ id: "e1", nombre: "eco", argumentos: { texto: primero.slice(4) } }] };
  }
  if (ultimo?.rol === "herramienta") {
    const resultados = p.mensajes.filter((m) => m.rol === "herramienta").map((m) => (m.rol === "herramienta" ? m.resultado : ""));
    return { texto: resultados.join(" | "), llamadas: [] };
  }
  if (primero.startsWith("reparte")) {
    return {
      texto: "",
      llamadas: [
        { id: "d1", nombre: "delegar", argumentos: { nombre: "uno", tarea: "TAREA uno" } },
        { id: "d2", nombre: "delegar", argumentos: { nombre: "dos", tarea: "TAREA dos", solo_lectura: true } },
      ],
    };
  }
  return { texto: `vale: ${primero}`, llamadas: [] };
}

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "aquiles-sub-"));
  const perfil = await mkdtemp(join(tmpdir(), "aquiles-sub-perfil-"));
  const proveedor = new ProveedorSimulado([guion], 2);
  servidor = iniciarServidor({
    puerto: 0, token: TOKEN, proveedor: "simulado", fabrica: () => proveedor, herramientas: [herramientaEco()],
    cwdPorDefecto: cwd, version: "0.0.0", perfil,
  });
});
afterAll(() => servidor.detener());

function cliente(decision: "permitir" | "denegar" = "denegar") {
  const ws = new WebSocket(`ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=${TOKEN}`);
  const eventos: Evento[] = [];
  const pedidas: any[] = [];
  const pendientes = new Map<number, (r: any) => void>();
  let n = 0;
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.method === "evento") eventos.push(d.params);
    else if (d.method === "aprobacion.pedir") {
      pedidas.push(d.params);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: d.id, result: { decision } }));
    } else pendientes.get(d.id)?.(d);
  };
  const abierto = new Promise((ok) => (ws.onopen = ok));
  const llamar = async (method: string, params: unknown = {}) => {
    await abierto;
    return new Promise<any>((ok) => {
      n += 1;
      pendientes.set(n, ok);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    });
  };
  const fin = async (sesionId: string) => {
    for (let i = 0; i < 500; i++) {
      const e = eventos.find((x) => x.tipo === "turno.fin" && x.sesionId === sesionId);
      if (e) return e;
      await Bun.sleep(10);
    }
    throw new Error("sin turno.fin");
  };
  return { ws, eventos, pedidas, llamar, fin };
}

test("delegar lanza subagentes en paralelo, con su sesión y su origen", async () => {
  const c = cliente();
  const { result: s } = await c.llamar("sesion.crear", {});
  await c.llamar("prompt.enviar", { sesionId: s.sesionId, texto: "reparte el trabajo" });
  const fin = await c.fin(s.sesionId);
  expect(fin).toMatchObject({ motivo: "fin" });
  expect((fin as { texto: string }).texto).toBe("hecho: TAREA uno | hecho: TAREA dos");

  const inicios = c.eventos.filter((e) => e.tipo === "subagente.inicio");
  const fines = c.eventos.filter((e) => e.tipo === "subagente.fin");
  expect(inicios).toHaveLength(2);
  expect(fines).toHaveLength(2);
  // Los dos empezaron antes de que acabara ninguno.
  expect(c.eventos.indexOf(inicios[1]!)).toBeLessThan(c.eventos.indexOf(fines[0]!));
  const hijas = (await c.llamar("sesion.listar")).result.sesiones.filter((x: any) => x.origen?.tipo === "subagente");
  expect(hijas.map((h: any) => h.titulo).sort()).toEqual(["dos · subagente", "uno · subagente"]);
  expect(hijas.every((h: any) => h.origen.padre === s.sesionId)).toBe(true);
  c.ws.close();
});

test("guardián: aprueba lo inocuo sin preguntar y deja pasar al usuario lo dudoso", async () => {
  const c = cliente("denegar");
  await c.llamar("ajustes.guardar", { herramientas: { guardian: { activo: true } } });
  const { result: s1 } = await c.llamar("sesion.crear", {});
  await c.llamar("prompt.enviar", { sesionId: s1.sesionId, texto: "eco hola" });
  expect(await c.fin(s1.sesionId)).toMatchObject({ texto: "eco hecho" });
  expect(c.pedidas).toHaveLength(0);
  expect(c.eventos.some((e) => e.tipo === "herramienta.progreso" && e.texto.startsWith("Permitido por el guardián"))).toBe(true);

  const { result: s2 } = await c.llamar("sesion.crear", {});
  await c.llamar("prompt.enviar", { sesionId: s2.sesionId, texto: "eco rm -rf x" });
  expect(await c.fin(s2.sesionId)).toMatchObject({ texto: "eco denegado" });
  expect(c.pedidas).toHaveLength(1);
  await c.llamar("ajustes.guardar", { herramientas: { guardian: { activo: false } } });
  c.ws.close();
});

test("Motor: turno sin interfaz con origen y permisos denegados", async () => {
  const r = await servidor.motor.turno({ nueva: { titulo: "Programada · prueba", origen: { tipo: "cron", tareaId: "t1" } }, texto: "eco algo" });
  expect(r.resultado).toMatchObject({ motivo: "fin", texto: "eco denegado" });
  expect(servidor.motor.existeSesion(r.sesionId)).toBe(true);
  const r2 = await servidor.motor.turno({ sesionId: r.sesionId, texto: "eco otra", aprobar: async () => "permitir" });
  expect(r2.resultado.texto).toBe("eco hecho");
});

test("interpretar la respuesta del guardián", () => {
  expect(interpretar('Vale: {"decision":"permitir","motivo":"tests"}')).toEqual({ decision: "permitir", motivo: "tests" });
  expect(interpretar("no sé")).toMatchObject({ decision: "preguntar" });
  expect(interpretar('{"decision":"borrar"}')).toMatchObject({ decision: "preguntar" });
});
