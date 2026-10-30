/**
 * Prueba con un modelo real de lo que trabaja sin nadie delante (gasta cuota):
 *   bun packages/nucleo/scripts/probar-automatico.ts [--proveedor claude] [--modelo haiku]
 * 1. Objetivo con juez: una sesión con objetivo; el juez debe darlo por cumplido.
 * 2. Tarea programada: se ejecuta ahora y entrega en el escritorio (evento `notificacion`).
 * Perfil y carpeta temporales; escribir dentro de la carpeta no pide permiso.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RUTA_RPC, type Evento } from "@aquiles/protocolo";
import { herramientasPorDefecto } from "../src/herramientas/index";
import { iniciarServidor } from "../src/servidor";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { proveedor: { type: "string", default: "claude" }, modelo: { type: "string", default: "haiku" } },
});
const cwd = await mkdtemp(join(tmpdir(), "aquiles-auto-real-"));
await writeFile(join(cwd, "datos.txt"), "Aquiles es un agente personal.\nTiene memoria, skills y tareas programadas.\nCorre en Windows con Tauri.\n");
const perfil = await mkdtemp(join(tmpdir(), "aquiles-auto-real-perfil-"));
const TOKEN = "prueba-automatico-0123456789";
const servidor = iniciarServidor({
  puerto: 0, token: TOKEN, proveedor: values.proveedor, modelo: values.modelo, herramientas: herramientasPorDefecto(),
  cwdPorDefecto: cwd, version: "prueba", perfil,
});
const ws = new WebSocket(`ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=${TOKEN}`);
await new Promise((ok) => (ws.onopen = ok));
const eventos: Evento[] = [];
const pendientes = new Map<number, (r: any) => void>();
let n = 0;
ws.onmessage = (m) => {
  const d = JSON.parse(String(m.data));
  if (d.method === "evento") eventos.push(d.params);
  else if (d.method === "aprobacion.pedir") ws.send(JSON.stringify({ jsonrpc: "2.0", id: d.id, result: { decision: "permitir" } }));
  else pendientes.get(d.id)?.(d);
};
const llamar = (method: string, params: unknown = {}) =>
  new Promise<any>((ok) => {
    n += 1;
    pendientes.set(n, ok);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
  }).then((r) => {
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  });
const esperar = async (cond: () => boolean | Promise<boolean>, segundos = 240) => {
  for (let i = 0; i < segundos * 5; i++) {
    if (await cond()) return true;
    await Bun.sleep(200);
  }
  return false;
};
const resultados: [string, boolean][] = [];

try {
  // 1. Objetivo con juez
  const s = await llamar("sesion.crear", {});
  await llamar("sesion.objetivo", {
    sesionId: s.sesionId,
    objetivo: "Que exista resumen.md con exactamente tres viñetas, una por cada línea de datos.txt.",
    maxIntentos: 3,
  });
  await llamar("prompt.enviar", { sesionId: s.sesionId, texto: "Haz el resumen de datos.txt en resumen.md." });
  await esperar(() =>
    eventos.some((e) => e.tipo === "objetivo.evaluado" && e.sesionId === s.sesionId && e.objetivo.estado !== "activo"),
  );
  const veredictos = eventos.filter((e) => e.tipo === "objetivo.evaluado" && e.sesionId === s.sesionId);
  const ultimo = veredictos.at(-1);
  console.log(`objetivo: ${veredictos.length} evaluaciones, estado ${ultimo?.tipo === "objetivo.evaluado" ? `${ultimo.objetivo.estado} (${ultimo.objetivo.motivo})` : "?"}`);
  resultados.push(["objetivo", ultimo?.tipo === "objetivo.evaluado" && ultimo.objetivo.estado === "cumplido"]);

  // 2. Tarea programada que entrega en el escritorio
  const tarea = await llamar("cron.crear", {
    nombre: "Recuento",
    prompt: "Cuenta las líneas de datos.txt y responde solo con el número.",
    cuando: "cada día 9:00",
    entrega: [{ canal: "escritorio" }],
  });
  await llamar("cron.ejecutar", { id: tarea.id });
  await esperar(() => eventos.some((e) => e.tipo === "notificacion" && e.titulo === "Recuento"));
  const aviso = eventos.find((e) => e.tipo === "notificacion" && e.titulo === "Recuento");
  console.log(`cron: notificación ${aviso?.tipo === "notificacion" ? JSON.stringify(aviso.texto) : "ninguna"}`);
  resultados.push(["cron", aviso?.tipo === "notificacion" && aviso.texto.includes("3")]);

  for (const [nombre, ok] of resultados) console.log(`${ok ? "[ok]" : "[FALLO]"} ${nombre}`);
  process.exitCode = resultados.every(([, ok]) => ok) ? 0 : 1;
} finally {
  ws.close();
  await servidor.detener();
}
