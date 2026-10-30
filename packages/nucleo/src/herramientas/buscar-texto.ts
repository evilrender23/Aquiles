import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { esBinario, rutaAbsoluta, rutaVisible } from "./ficheros";
import { definir, ErrorHerramienta } from "./herramienta";
import { filtroGlob, recorrer, reglasPara, type Entrada } from "./recorrer";

const MAX_TAMANO = 2 * 1024 * 1024;
const MAX_ANCHO = 300;
const MAX_SALIDA = 30_000;
const LOTE = 32;

export const buscarTexto = definir({
  nombre: "buscar_texto",
  descripcion:
    "Busca una expresión regular (sintaxis de JavaScript) línea a línea en los ficheros de una carpeta y devuelve 'ruta:línea: texto'. " +
    "Úsala para encontrar dónde se define o usa algo antes de leer ficheros. " +
    "Salta .git, node_modules, dist, target, .venv, __pycache__, lo del .gitignore, binarios y ficheros de más de 2 MB.",
  nivel: "lectura",
  parametros: z.object({
    patron: z.string().min(1).describe("Expresión regular, p. ej. 'function \\w+Usuario' (no cruza saltos de línea)"),
    ruta: z.string().optional().describe("Fichero o carpeta donde buscar; por defecto, la carpeta de trabajo"),
    glob: z
      .string()
      .optional()
      .describe("Filtra ficheros: sin '/' compara el nombre ('*.ts', '*.{ts,tsx}'); con '/' la ruta relativa ('src/**/*.ts')"),
    ignorar_mayusculas: z.boolean().optional(),
    contexto: z.number().int().min(0).max(10).optional().describe("Líneas de contexto antes y después de cada coincidencia"),
    max_resultados: z.number().int().min(1).max(1000).optional().describe("Máximo de líneas coincidentes (100 por defecto)"),
  }),
  resumen: ({ patron, ruta, glob }) => `/${patron}/${ruta ? ` en ${ruta}` : ""}${glob ? ` (${glob})` : ""}`,
  rutas: ({ ruta }, cwd) => [rutaAbsoluta(ruta ?? ".", cwd)],
  async ejecutar({ patron, ruta = ".", glob, ignorar_mayusculas = false, contexto = 0, max_resultados = 100 }, ctx) {
    let fuente = patron;
    let flags = ignorar_mayusculas ? "i" : "";
    if (fuente.startsWith("(?i)")) {
      fuente = fuente.slice(4);
      flags = "i";
    }
    let re: RegExp;
    try {
      re = new RegExp(fuente, flags);
    } catch (e) {
      throw new ErrorHerramienta(`Patrón no válido (${e instanceof Error ? e.message : String(e)}); usa sintaxis de RegExp de JavaScript.`);
    }

    const raiz = rutaAbsoluta(ruta, ctx.cwd);
    const info = await stat(raiz).catch(() => undefined);
    if (!info) throw new ErrorHerramienta(`No existe: ${ruta}`);

    let ficheros: AsyncIterable<Entrada> | Entrada[];
    if (info.isDirectory()) {
      const filtro = glob ? filtroGlob(glob) : () => true;
      const todos = recorrer(raiz, await reglasPara(raiz, ctx.cwd), ctx.senal);
      ficheros = (async function* () {
        for await (const e of todos) if (filtro(e)) yield e;
      })();
    } else {
      if (info.size > MAX_TAMANO) throw new ErrorHerramienta(`${ruta} ocupa más de 2 MB; busca en otro sitio o léelo por partes`);
      ficheros = [{ abs: raiz, rel: basename(raiz), nombre: basename(raiz) }];
    }

    const salida: string[] = [];
    let tam = 0;
    let coincidencias = 0;
    let revisados = 0;
    let truncado = false;

    const procesar = (e: Entrada, bytes: Uint8Array | undefined) => {
      if (!bytes || esBinario(bytes)) return;
      revisados++;
      const lineas = new TextDecoder().decode(bytes).split(/\r?\n/);
      const aciertos: number[] = [];
      for (let i = 0; i < lineas.length; i++) {
        if (re.test(lineas[i]!)) {
          aciertos.push(i);
          if (coincidencias + aciertos.length > max_resultados) break;
        }
      }
      if (aciertos.length === 0) return;
      if (coincidencias + aciertos.length > max_resultados) {
        aciertos.length = max_resultados - coincidencias;
        truncado = true;
      }
      coincidencias += aciertos.length;
      const visible = rutaVisible(e.abs, ctx.cwd);
      const esAcierto = new Set(aciertos);
      let ultima = -2;
      for (const a of aciertos) {
        const desde = Math.max(0, a - contexto, ultima + 1);
        const hasta = Math.min(lineas.length - 1, a + contexto);
        if (contexto > 0 && salida.length > 0 && desde > ultima + 1) salida.push("--");
        for (let i = desde; i <= hasta; i++) {
          const texto = recortarLinea(lineas[i]!);
          const fila = esAcierto.has(i) ? `${visible}:${i + 1}: ${texto}` : `${visible}-${i + 1}- ${texto}`;
          tam += fila.length + 1;
          salida.push(fila);
        }
        ultima = Math.max(ultima, hasta);
      }
      if (tam > MAX_SALIDA) truncado = true;
    };

    let lote: Entrada[] = [];
    const vaciar = async () => {
      const leidos = await Promise.all(
        lote.map(async (e) => {
          const f = Bun.file(e.abs);
          return f.size > MAX_TAMANO ? undefined : f.bytes().catch(() => undefined);
        }),
      );
      for (let i = 0; i < lote.length && !truncado; i++) procesar(lote[i]!, leidos[i]);
      lote = [];
    };
    for await (const e of ficheros) {
      lote.push(e);
      if (lote.length >= LOTE) await vaciar();
      if (truncado || ctx.senal.aborted) break;
    }
    if (!truncado) await vaciar();

    if (coincidencias === 0) {
      return `Sin coincidencias de /${patron}/ en ${rutaVisible(raiz, ctx.cwd)}${glob ? ` (${glob})` : ""} (${revisados} ficheros revisados).`;
    }
    let texto = salida.join("\n");
    if (texto.length > MAX_SALIDA) texto = `${texto.slice(0, MAX_SALIDA)}…`;
    if (truncado) texto += `\n[resultados truncados en ${coincidencias} coincidencias; afina el patrón o usa 'ruta'/'glob']`;
    return texto;
  },
});

function recortarLinea(l: string): string {
  return l.length > MAX_ANCHO ? `${l.slice(0, MAX_ANCHO)}…` : l;
}
