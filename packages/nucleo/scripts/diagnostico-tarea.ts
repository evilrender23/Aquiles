/** Diagnóstico: ejecuta un encargo con agy en una carpeta y muestra el texto y las llamadas del modelo.
 *   bun packages/nucleo/scripts/diagnostico-tarea.ts <carpeta> <fichero-con-el-encargo> */
import { ejecutarTarea } from "../src/agente";
import { crearProveedor } from "../src/proveedores/index";
const [cwd, encargo] = process.argv.slice(2);
const r = await ejecutarTarea({
  proveedor: crearProveedor("agy"), cwd: cwd!, prompt: await Bun.file(encargo!).text(), maxIteraciones: 10,
  alEvento: (e) => { if (e.tipo === "herramienta.inicio") console.log(`\n[${e.nombre}] ${JSON.stringify(e.argumentos)}`); },
});
for (const m of r.mensajes) console.log(`--- ${m.rol}: ${(m.rol === "herramienta" ? m.resultado : m.texto).slice(0, 1500)}${m.rol === "asistente" && m.llamadas.length ? ` ${JSON.stringify(m.llamadas)}` : ""}`);
console.log(`\n${r.motivo} ${r.error ?? ""}`);
