/**
 * Prueba de humo con un modelo real (gasta cuota de la cuenta del proveedor).
 *   bun packages/nucleo/scripts/probar-modelo.ts [--proveedor agy|claude|…] [--modelo ID]
 * Crea una carpeta temporal con un fichero, pide a Aquiles que lo lea y hace una segunda
 * pregunta en la misma sesión para comprobar que el proceso del CLI se reutiliza.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type EntornoTurno, ejecutarTurno } from "../src/bucle";
import { leer } from "../src/herramientas/leer";
import { crearProveedor } from "../src/proveedores/index";
import { sistemaBase } from "../src/sesiones";
import type { Mensaje } from "../src/tipos";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { proveedor: { type: "string", default: "agy" }, modelo: { type: "string" } },
});
const cwd = await mkdtemp(join(tmpdir(), "aquiles-humo-"));
const codigo = String(1000 + Math.floor(Math.random() * 9000));
await writeFile(join(cwd, "nota.txt"), `Instrucciones del almacén.\nEl código de la puerta es ${codigo}.\nNo lo compartas.\n`);

const proveedor = crearProveedor(values.proveedor, { modelo: values.modelo });
const mensajes: Mensaje[] = [];
const entorno: EntornoTurno = { lecturas: new Map(), estado: new Map(), permitidos: new Set(), modoAprobacion: "preguntar-ejecutar", steer: [] };
let fallos = 0;

for (const [pregunta, esperado] of [
  ["¿Qué código de puerta pone en nota.txt?", codigo],
  ["¿Y cuántas líneas tiene ese fichero? Responde solo el número.", "3"],
] as const) {
  mensajes.push({ rol: "usuario", texto: pregunta });
  const inicio = performance.now();
  let primerDelta = 0;
  const r = await ejecutarTurno({
    sesionId: "humo",
    cwd,
    sistema: sistemaBase(cwd),
    mensajes,
    proveedor,
    herramientas: [leer],
    senal: new AbortController().signal,
    entorno,
    emitir(ev) {
      if (ev.tipo === "mensaje.delta") {
        primerDelta ||= performance.now() - inicio;
        process.stdout.write(ev.texto);
      } else if (ev.tipo === "herramienta.inicio") console.log(`\n  [${ev.nombre}] ${JSON.stringify(ev.argumentos)}`);
      else if (ev.tipo === "herramienta.fin") console.log(`  [${ev.error ? "FALLO" : "ok"}]`);
    },
  });
  const ok = r.motivo === "fin" && r.texto.includes(esperado);
  if (!ok) fallos += 1;
  console.log(
    `\n[${ok ? "ok" : "FALLO"}] ${r.motivo} en ${((performance.now() - inicio) / 1000).toFixed(1)} s, primer texto a ${(primerDelta / 1000).toFixed(1)} s, ` +
      `tokens ${r.uso.entrada}/${r.uso.salida}${r.error ? `, error: ${r.error}` : ""}\n`,
  );
}

await proveedor.cerrar?.();
console.log(`historial: ${mensajes.map((m) => m.rol).join(" → ")}`);
process.exit(fallos ? 1 : 0);
