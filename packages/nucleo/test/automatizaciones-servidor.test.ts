import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUTA_RPC, type Evento } from "@aquiles/protocolo";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { iniciarServidor, type Servidor } from "../src/servidor";

const TOKEN = "token-automatizaciones-012345";
let servidor: Servidor;

beforeAll(async () => {
  const cwd = await mkdtemp(join(tmpdir(), "aquiles-auto-"));
  const perfil = await mkdtemp(join(tmpdir(), "aquiles-auto-perfil-"));
  const proveedor = new ProveedorSimulado([(p) => ({ texto: `Informe: ${p.mensajes.at(-1)?.rol === "usuario" ? "listo" : "?"}`, llamadas: [] })]);
  servidor = iniciarServidor({
    puerto: 0, token: TOKEN, proveedor: "simulado", fabrica: () => proveedor, herramientas: [], cwdPorDefecto: cwd, version: "0", perfil,
  });
});
afterAll(() => servidor.detener());

test("tareas programadas por RPC: interpretar, crear, ejecutar y entregar en el escritorio", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=${TOKEN}`);
  const eventos: Evento[] = [];
  const pendientes = new Map<number, (r: any) => void>();
  let n = 0;
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.method === "evento") eventos.push(d.params);
    else pendientes.get(d.id)?.(d);
  };
  await new Promise((ok) => (ws.onopen = ok));
  const llamar = (method: string, params: unknown = {}) =>
    new Promise<any>((ok) => {
      n += 1;
      pendientes.set(n, ok);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    });

  const i = (await llamar("cron.interpretar", { cuando: "cada lunes 9:00" })).result;
  expect(i).toMatchObject({ descripcion: "cada lunes a las 9:00", repite: true });
  expect(i.proximas).toHaveLength(5);
  expect((await llamar("cron.interpretar", { cuando: "cuando quieras" })).error.code).toBe(-32602);

  const tarea = (await llamar("cron.crear", { nombre: "Resumen", prompt: "Resume el día", cuando: "cada día 8:00", entrega: [{ canal: "escritorio" }] })).result;
  expect(tarea).toMatchObject({ nombre: "Resumen", activa: true, entrega: [{ canal: "escritorio" }] });
  expect((await llamar("cron.listar")).result.tareas).toHaveLength(1);

  await llamar("cron.ejecutar", { id: tarea.id });
  for (let k = 0; k < 300 && !eventos.some((e) => e.tipo === "notificacion"); k++) await Bun.sleep(10);
  expect(eventos.find((e) => e.tipo === "notificacion")).toMatchObject({ titulo: "Resumen", texto: "Informe: listo" });
  for (let k = 0; k < 300; k++) {
    const [ultima] = (await llamar("cron.ejecuciones", { id: tarea.id })).result.ejecuciones;
    if (ultima?.estado !== "en-curso") break;
    await Bun.sleep(10);
  }
  const [ejecucion] = (await llamar("cron.ejecuciones", { id: tarea.id })).result.ejecuciones;
  expect(ejecucion).toMatchObject({ estado: "ok", entregas: [{ canal: "escritorio", ok: true }] });
  const sesion = (await llamar("sesion.listar")).result.sesiones.find((s: any) => s.sesionId === ejecucion.sesionId);
  expect(sesion).toMatchObject({ titulo: "Programada · Resumen", origen: { tipo: "cron", tareaId: tarea.id } });

  const canales = (await llamar("canales.listar")).result.canales;
  expect(canales.map((c: any) => c.id).sort()).toEqual(["correo", "discord", "escritorio", "slack", "telegram", "terminal"]);
  expect((await llamar("canales.emparejar", { canal: "telegram" })).result.codigo).toMatch(/^\d{6}$/);
  expect((await llamar("cron.borrar", { id: tarea.id })).result).toEqual({ borrada: true });
  ws.close();
});
