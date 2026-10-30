/**
 * Prueba de subagentes con un modelo real (gasta cuota):
 *   bun packages/nucleo/scripts/probar-subagentes.ts [--proveedor claude] [--modelo haiku]
 * Pide dos tareas independientes y comprueba que Aquiles las reparte con `delegar`, que los subagentes
 * corren a la vez y que el resultado junta lo de los dos.
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
const cwd = await mkdtemp(join(tmpdir(), "aquiles-sub-real-"));
await writeFile(join(cwd, "ventas.csv"), "mes,importe\nenero,120\nfebrero,80\nmarzo,200\n");
await writeFile(join(cwd, "gastos.csv"), "mes,importe\nenero,50\nfebrero,70\nmarzo,40\n");
const perfil = await mkdtemp(join(tmpdir(), "aquiles-sub-perfil-"));
const TOKEN = "prueba-subagentes-0123456789";
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
  if (d.method === "evento") {
    const e = d.params as Evento;
    eventos.push(e);
    if (e.tipo === "subagente.inicio") console.log(`  [inicio ${e.subId.slice(0, 8)}] ${e.tarea.replace(/\s+/g, " ").slice(0, 100)}`);
    if (e.tipo === "subagente.fin") console.log(`  [fin ${e.subId.slice(0, 8)}] ${e.motivo}: ${e.texto.replace(/\s+/g, " ").slice(0, 100)}`);
    if (e.tipo === "herramienta.inicio") console.log(`  (${e.sesionId.slice(0, 8)}) ${e.nombre} ${e.resumen ?? ""}`);
  } else if (d.method === "aprobacion.pedir") ws.send(JSON.stringify({ jsonrpc: "2.0", id: d.id, result: { decision: "permitir" } }));
  else if (d.method === "pregunta.hacer") ws.send(JSON.stringify({ jsonrpc: "2.0", id: d.id, result: { respuesta: "Decide tú." } }));
  else pendientes.get(d.id)?.(d.result);
};
const llamar = (method: string, params: unknown = {}) =>
  new Promise<any>((ok) => {
    n += 1;
    pendientes.set(n, ok);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
  });

try {
  const { sesionId } = await llamar("sesion.crear", {});
  await llamar("prompt.enviar", {
    sesionId,
    texto:
      "Usa dos subagentes en paralelo (herramienta delegar, las dos llamadas en el mismo mensaje): uno que sume los importes de ventas.csv " +
      "y otro que sume los importes de gastos.csv. Después dime las dos sumas y la diferencia.",
  });
  let fin: Evento | undefined;
  while (!(fin = eventos.find((e) => e.tipo === "turno.fin" && e.sesionId === sesionId))) await Bun.sleep(200);
  const texto = fin.tipo === "turno.fin" ? fin.texto : "";
  console.log(`\n< ${texto}\n`);
  const inicios = eventos.filter((e) => e.tipo === "subagente.inicio");
  const fines = eventos.filter((e) => e.tipo === "subagente.fin");
  const paralelos = inicios.length >= 2 && eventos.indexOf(inicios[1]!) < eventos.indexOf(fines[0]!);
  const bien = texto.includes("400") && texto.includes("160") && texto.includes("240");
  console.log(`${paralelos && bien ? "[ok]" : "[FALLO]"} subagentes: ${inicios.length}, a la vez: ${paralelos}, sumas correctas: ${bien}`);
  process.exitCode = paralelos && bien ? 0 : 1;
} finally {
  ws.close();
  await servidor.detener();
}
