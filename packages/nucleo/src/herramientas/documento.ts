import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { z } from "zod";
import { markdownADocx } from "../documentos";
import { escribir } from "./escribir";
import { claveRuta, hashDe, registrarHuella, rutaAbsoluta, rutaVisible } from "./ficheros";
import { definir, ErrorHerramienta } from "./herramienta";

export const escribirDocumento = definir({
  nombre: "escribir_documento",
  descripcion:
    "Crea un documento de Word (.docx) o Markdown (.md) a partir de 'contenido' en markdown: títulos, negrita y cursiva, " +
    "enlaces, listas (también anidadas), tablas, citas y bloques de código. Úsala cuando te pidan un documento de Word o un " +
    ".docx. El .md se escribe tal cual. Sustituye el documento entero; para otros ficheros usa escribir.",
  nivel: "escritura",
  parametros: z.object({
    ruta: z.string().min(1).describe("Ruta del documento, terminada en .docx o .md (relativa a la carpeta de trabajo o absoluta)"),
    contenido: z.string().describe("Contenido completo del documento, en markdown"),
  }),
  resumen: ({ ruta }) => ruta,
  rutas: ({ ruta }, cwd) => [rutaAbsoluta(ruta, cwd)],
  async ejecutar({ ruta, contenido }, ctx) {
    const ext = extname(ruta).toLowerCase();
    // Un .md es texto: lo mismo que escribir (exige haberlo leído para sustituirlo, respeta CRLF y BOM…).
    if (ext === ".md" || ext === ".markdown") return escribir.ejecutar({ ruta, contenido }, ctx);
    if (ext !== ".docx") throw new ErrorHerramienta(`escribir_documento escribe .docx y .md, y ${ruta} no es ninguno de los dos. Para otros ficheros usa escribir.`);

    const abs = rutaAbsoluta(ruta, ctx.cwd);
    const visible = rutaVisible(abs, ctx.cwd);
    const info = await stat(abs).catch(() => undefined);
    if (info?.isDirectory()) throw new ErrorHerramienta(`${visible} es una carpeta`);
    if (info) {
      // Un .docx no se puede leer con leer, así que solo se sustituye el que escribiste en esta sesión y sigue igual.
      const previa = ctx.lecturas.get(claveRuta(abs));
      if (!previa || hashDe(await Bun.file(abs).bytes()) !== previa.hash)
        throw new ErrorHerramienta(
          `${visible} ya existe y no es el que escribiste en esta sesión: sustituirlo perdería su formato y sus imágenes. ` +
            "Escribe el documento con otro nombre o, si el usuario quiere sustituirlo, pregúntale antes.",
        );
    }

    const bytes = await markdownADocx(contenido);
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
    } catch (e) {
      throw new ErrorHerramienta(`No se pudo escribir ${visible}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await registrarHuella(ctx, abs, bytes);
    return `Escrito ${visible} (documento de Word, ${Math.max(1, Math.round(bytes.length / 1024))} KB)`;
  },
});
