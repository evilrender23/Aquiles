import { stat } from "node:fs/promises";
import { z } from "zod";
import { esBinario, registrarHuella, rutaAbsoluta } from "./ficheros";
import { definir, ErrorHerramienta } from "./herramienta";

const MAX_LINEAS = 2000;
const MAX_BYTES = 256 * 1024;
const MAX_ANCHO = 2000;

export const leer = definir({
  nombre: "leer",
  descripcion:
    "Lee un fichero de texto y lo devuelve con números de línea. La ruta puede ser relativa a la carpeta de trabajo. " +
    `Usa 'desde' y 'lineas' para ficheros largos (máximo ${MAX_LINEAS} líneas por lectura). ` +
    "Hay que leer un fichero antes de editarlo o sobrescribirlo.",
  nivel: "lectura",
  parametros: z.object({
    ruta: z.string().min(1).describe("Ruta del fichero"),
    desde: z.number().int().min(1).optional().describe("Primera línea (empieza en 1)"),
    lineas: z.number().int().min(1).max(MAX_LINEAS).optional().describe("Cuántas líneas leer"),
  }),
  resumen: ({ ruta, desde, lineas }) =>
    desde || lineas ? `${ruta}:${desde ?? 1}${lineas ? `-${(desde ?? 1) + lineas - 1}` : ""}` : ruta,
  rutas: ({ ruta }, cwd) => [rutaAbsoluta(ruta, cwd)],
  async ejecutar({ ruta, desde = 1, lineas = MAX_LINEAS }, ctx) {
    const completa = rutaAbsoluta(ruta, ctx.cwd);
    const info = await stat(completa).catch(() => undefined);
    if (!info) throw new ErrorHerramienta(`No existe: ${ruta}`);
    if (info.isDirectory()) throw new ErrorHerramienta(`${ruta} es una carpeta, no un fichero`);
    if (info.size > 20 * 1024 * 1024) throw new ErrorHerramienta(`${ruta} ocupa ${info.size} bytes; demasiado para leerlo como texto`);

    const bytes = await Bun.file(completa).bytes();
    if (esBinario(bytes)) throw new ErrorHerramienta(`${ruta} parece binario`);
    await registrarHuella(ctx, completa, bytes);

    const todas = new TextDecoder().decode(bytes).replace(/\r\n/g, "\n").split("\n");
    if (todas.length > 1 && todas.at(-1) === "") todas.pop();
    if (desde > todas.length && todas.length > 0) {
      throw new ErrorHerramienta(`${ruta} tiene ${todas.length} líneas; 'desde' (${desde}) se pasa`);
    }

    const salida: string[] = [];
    let tam = 0;
    let fin = desde - 1;
    for (let i = desde - 1; i < Math.min(todas.length, desde - 1 + lineas); i++) {
      const linea = (todas[i] ?? "").length > MAX_ANCHO ? `${(todas[i] ?? "").slice(0, MAX_ANCHO)}…` : (todas[i] ?? "");
      const fila = `${i + 1}\t${linea}`;
      tam += fila.length + 1;
      if (tam > MAX_BYTES) break;
      salida.push(fila);
      fin = i + 1;
    }
    if (fin < todas.length) {
      salida.push(`[líneas ${desde}-${fin} de ${todas.length}; sigue con desde=${fin + 1}]`);
    }
    return salida.join("\n") || "[fichero vacío]";
  },
});
