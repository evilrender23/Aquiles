import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  codificar,
  contarLineas,
  decodificar,
  exigirLeido,
  lineas,
  registrarHuella,
  rutaAbsoluta,
  rutaVisible,
  type Texto,
} from "./ficheros";
import { definir, ErrorHerramienta } from "./herramienta";

export const escribir = definir({
  nombre: "escribir",
  descripcion:
    "Crea un fichero de texto o lo sustituye entero por 'contenido', creando las carpetas que falten. " +
    "Para sobrescribir uno que ya existe, léelo antes en esta sesión. Para cambios parciales usa editar.",
  nivel: "escritura",
  parametros: z.object({
    ruta: z.string().min(1).describe("Ruta del fichero (relativa a la carpeta de trabajo o absoluta)"),
    contenido: z.string().describe("Contenido completo del fichero"),
  }),
  resumen: ({ ruta }) => ruta,
  rutas: ({ ruta }, cwd) => [rutaAbsoluta(ruta, cwd)],
  async ejecutar({ ruta, contenido }, ctx) {
    const abs = rutaAbsoluta(ruta, ctx.cwd);
    const visible = rutaVisible(abs, ctx.cwd);
    const info = await stat(abs).catch(() => undefined);
    if (info?.isDirectory()) throw new ErrorHerramienta(`${visible} es una carpeta`);
    const anterior: Texto | undefined = info ? decodificar(await exigirLeido(ctx, abs, visible, "sobrescribirlo")) : undefined;

    // Respeta los finales de línea CRLF de un fichero que ya los usaba.
    const texto = anterior?.crlf && !contenido.includes("\r\n") ? contenido.replace(/\n/g, "\r\n") : contenido;
    const bytes = codificar(texto, anterior?.bom ?? false);
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
    } catch (e) {
      throw new ErrorHerramienta(`No se pudo escribir ${visible}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await registrarHuella(ctx, abs, bytes);

    const n = lineas(contarLineas(contenido));
    if (!anterior) return `Escrito ${visible} (${n})`;
    const { anadidas, quitadas } = contarCambios(partir(anterior.texto), partir(contenido));
    return `Escrito ${visible} (${n}, +${anadidas} -${quitadas})`;
  },
});

function partir(texto: string): string[] {
  const l = texto.replace(/\r\n/g, "\n").split("\n");
  if (l.at(-1) === "") l.pop();
  return l;
}

/** Líneas añadidas y quitadas (LCS sobre la parte que cambia; aproximado si es enorme). */
export function contarCambios(antes: readonly string[], despues: readonly string[]): { anadidas: number; quitadas: number } {
  let ini = 0;
  while (ini < antes.length && ini < despues.length && antes[ini] === despues[ini]) ini++;
  let fa = antes.length;
  let fd = despues.length;
  while (fa > ini && fd > ini && antes[fa - 1] === despues[fd - 1]) {
    fa--;
    fd--;
  }
  const a = antes.slice(ini, fa);
  const d = despues.slice(ini, fd);
  if (a.length === 0 || d.length === 0) return { anadidas: d.length, quitadas: a.length };

  let comunes = 0;
  if (a.length * d.length <= 4_000_000) {
    let previa = new Int32Array(d.length + 1);
    let actual = new Int32Array(d.length + 1);
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= d.length; j++) {
        actual[j] = a[i - 1] === d[j - 1] ? previa[j - 1]! + 1 : Math.max(previa[j]!, actual[j - 1]!);
      }
      [previa, actual] = [actual, previa];
    }
    comunes = previa[d.length]!;
  } else {
    const cuenta = new Map<string, number>();
    for (const l of a) cuenta.set(l, (cuenta.get(l) ?? 0) + 1);
    for (const l of d) {
      const c = cuenta.get(l) ?? 0;
      if (c > 0) {
        comunes++;
        cuenta.set(l, c - 1);
      }
    }
  }
  return { anadidas: d.length - comunes, quitadas: a.length - comunes };
}
