/**
 * P3 de la fase 0: tiempo hasta `AQUILES_READY` del ejecutable compilado y FTS5 en el SQLite de Bun.
 *   bun packages/nucleo/scripts/medir-arranque.ts [ruta-del-exe]
 */
import { Database } from "bun:sqlite";
import { LINEA_LISTO } from "@aquiles/protocolo";
import { lineas } from "../src/proveedores/agy";

const exe = process.argv[2] ?? "apps/escritorio/src-tauri/binaries/aquiles-nucleo-x86_64-pc-windows-msvc.exe";
const tiempos: number[] = [];
for (let i = 0; i < 5; i++) {
  const inicio = performance.now();
  const p = Bun.spawn([exe, "--proveedor", "simulado", "--puerto", "0"], {
    env: { ...process.env, AQUILES_TOKEN: "medicion" },
    stdout: "pipe",
    stderr: "ignore",
  });
  for await (const linea of lineas(p.stdout)) {
    if (linea.startsWith(LINEA_LISTO)) break;
  }
  tiempos.push(performance.now() - inicio);
  p.kill();
  await p.exited;
}
tiempos.sort((a, b) => a - b);
console.log(`arranque hasta READY: mediana ${tiempos[2]!.toFixed(0)} ms (min ${tiempos[0]!.toFixed(0)}, max ${tiempos[4]!.toFixed(0)})`);

const db = new Database(":memory:");
db.run("CREATE VIRTUAL TABLE t USING fts5(texto, tokenize = 'unicode61 remove_diacritics 2')");
db.run("INSERT INTO t VALUES ('El código de la puerta está en nota.txt'), ('otra cosa')");
const fila = db.query("SELECT texto FROM t WHERE t MATCH 'codigo AND puerta'").get() as { texto: string } | null;
console.log(`FTS5: ${fila ? "disponible" : "NO"} (versión SQLite ${(db.query("select sqlite_version() v").get() as { v: string }).v}); búsqueda sin tildes: ${fila?.texto ?? "-"}`);
