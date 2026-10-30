import { stat } from "node:fs/promises";
import { z } from "zod";
import { rutaAbsoluta, rutaVisible } from "./ficheros";
import { definir, ErrorHerramienta } from "./herramienta";
import { filtroGlob, recorrer, reglasPara } from "./recorrer";

const MAX_FICHEROS = 200;

export const buscarFicheros = definir({
  nombre: "buscar_ficheros",
  descripcion:
    "Busca ficheros por nombre con un patrón glob y los devuelve del más reciente al más antiguo (máximo 200). " +
    "Sin '/' el patrón compara solo el nombre en cualquier subcarpeta ('*.ts', 'README*'); con '/' compara la ruta relativa a 'ruta' ('src/**/*.test.ts'). " +
    "Salta .git, node_modules, dist, target, .venv, __pycache__ y lo del .gitignore, salvo que 'ruta' apunte dentro.",
  nivel: "lectura",
  parametros: z.object({
    patron: z.string().min(1).describe("Patrón glob: *, **, ?, [abc], {a,b}"),
    ruta: z.string().optional().describe("Carpeta donde buscar; por defecto, la carpeta de trabajo"),
  }),
  resumen: ({ patron, ruta }) => (ruta ? `${patron} en ${ruta}` : patron),
  rutas: ({ ruta }, cwd) => [rutaAbsoluta(ruta ?? ".", cwd)],
  async ejecutar({ patron, ruta = "." }, ctx) {
    const raiz = rutaAbsoluta(ruta, ctx.cwd);
    const info = await stat(raiz).catch(() => undefined);
    if (!info) throw new ErrorHerramienta(`No existe: ${ruta}`);
    if (!info.isDirectory()) throw new ErrorHerramienta(`${ruta} no es una carpeta`);

    const coincide = filtroGlob(patron);
    const encontrados: string[] = [];
    for await (const e of recorrer(raiz, await reglasPara(raiz, ctx.cwd), ctx.senal)) {
      if (coincide(e)) encontrados.push(e.abs);
    }
    if (encontrados.length === 0) return `Ningún fichero coincide con ${patron} en ${rutaVisible(raiz, ctx.cwd)}.`;

    const fechas = new Map<string, number>();
    for (let i = 0; i < encontrados.length; i += 64) {
      await Promise.all(
        encontrados.slice(i, i + 64).map(async (abs) => fechas.set(abs, (await stat(abs).catch(() => undefined))?.mtimeMs ?? 0)),
      );
    }
    encontrados.sort((a, b) => fechas.get(b)! - fechas.get(a)!);
    const lista = encontrados.slice(0, MAX_FICHEROS).map((abs) => rutaVisible(abs, ctx.cwd));
    if (encontrados.length > MAX_FICHEROS) {
      lista.push(`[${encontrados.length} ficheros; se muestran los ${MAX_FICHEROS} más recientes. Afina el patrón o la ruta]`);
    }
    return lista.join("\n");
  },
});
