import { stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { codificar, decodificar, esBinario, exigirLeido, registrarHuella, rutaAbsoluta, rutaVisible } from "./ficheros";
import { definir, ErrorHerramienta } from "./herramienta";

const CONTEXTO = 2;
const MAX_FRAGMENTOS = 5;

export const editar = definir({
  nombre: "editar",
  descripcion:
    "Sustituye un texto exacto de un fichero por otro. Lee el fichero antes en esta sesión. " +
    "'buscar' debe aparecer una sola vez (añade líneas de alrededor para que sea único) salvo con 'todas'; " +
    "cópialo tal cual, con su sangría y sin los números de línea de leer. Para crear ficheros usa escribir.",
  nivel: "escritura",
  parametros: z.object({
    ruta: z.string().min(1).describe("Ruta del fichero"),
    buscar: z.string().min(1).describe("Texto exacto que hay ahora"),
    reemplazar: z.string().describe("Texto nuevo (vacío para borrar)"),
    todas: z.boolean().optional().describe("Sustituye todas las apariciones"),
  }),
  resumen: ({ ruta }) => ruta,
  rutas: ({ ruta }, cwd) => [rutaAbsoluta(ruta, cwd)],
  async ejecutar({ ruta, buscar, reemplazar, todas = false }, ctx) {
    const abs = rutaAbsoluta(ruta, ctx.cwd);
    const visible = rutaVisible(abs, ctx.cwd);
    const info = await stat(abs).catch(() => undefined);
    if (!info) throw new ErrorHerramienta(`No existe ${visible}; para crear ficheros usa escribir.`);
    if (info.isDirectory()) throw new ErrorHerramienta(`${visible} es una carpeta, no un fichero`);
    const bytes = await exigirLeido(ctx, abs, visible, "editarlo");
    if (esBinario(bytes)) throw new ErrorHerramienta(`${visible} parece binario; no se puede editar como texto`);

    const { texto: crudo, bom, crlf } = decodificar(bytes);
    const lf = (s: string) => (crlf ? s.replace(/\r\n/g, "\n") : s);
    const texto = lf(crudo);
    const b = lf(buscar);
    const r = lf(reemplazar);
    if (b === r) throw new ErrorHerramienta("'buscar' y 'reemplazar' son iguales; no hay nada que cambiar.");

    const posiciones: number[] = [];
    for (let i = texto.indexOf(b); i >= 0; i = texto.indexOf(b, i + b.length)) posiciones.push(i);
    if (posiciones.length === 0) throw new ErrorHerramienta(`No se encontró 'buscar' en ${visible}. ${pistaSinCoincidencias(texto, b)}`);
    if (posiciones.length > 1 && !todas) {
      const nums = lineasDe(texto, posiciones.slice(0, 20)).map((l) => l + 1);
      throw new ErrorHerramienta(
        `'buscar' aparece ${posiciones.length} veces en ${visible} (líneas ${nums.join(", ")}${posiciones.length > 20 ? ", …" : ""}). ` +
          "Incluye más líneas de alrededor para que sea único, o usa todas: true para cambiarlas todas.",
      );
    }

    const trozos: string[] = [];
    const inicios: number[] = [];
    let previo = 0;
    let largo = 0;
    for (const p of posiciones) {
      trozos.push(texto.slice(previo, p));
      largo += p - previo;
      inicios.push(largo);
      trozos.push(r);
      largo += r.length;
      previo = p + b.length;
    }
    trozos.push(texto.slice(previo));
    const nuevo = trozos.join("");

    const salida = codificar(crlf ? nuevo.replace(/\n/g, "\r\n") : nuevo, bom);
    try {
      await writeFile(abs, salida);
    } catch (e) {
      throw new ErrorHerramienta(`No se pudo escribir ${visible}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await registrarHuella(ctx, abs, salida);

    const n = posiciones.length;
    return `Editado ${visible} (${n} ${n === 1 ? "cambio" : "cambios"}):\n${fragmentos(nuevo, inicios, r)}`;
  },
});

/** Línea (desde 0) de cada posición; `posiciones` va en orden creciente. */
function lineasDe(texto: string, posiciones: readonly number[]): number[] {
  const salida: number[] = [];
  let n = 0;
  let i = texto.indexOf("\n");
  for (const p of posiciones) {
    while (i >= 0 && i < p) {
      n++;
      i = texto.indexOf("\n", i + 1);
    }
    salida.push(n);
  }
  return salida;
}

const lineaDe = (texto: string, pos: number) => lineasDe(texto, [pos])[0]!;

/** Líneas cambiadas con números y ±CONTEXTO líneas alrededor; rangos solapados se juntan. */
function fragmentos(nuevo: string, inicios: readonly number[], reemplazo: string): string {
  const lineas = nuevo.split("\n");
  const altoReemplazo = reemplazo.replace(/\n$/, "").split("\n").length - 1;
  const rangos: [number, number][] = [];
  for (const ini of lineasDe(nuevo, inicios)) {
    const desde = Math.max(0, ini - CONTEXTO);
    const hasta = Math.min(lineas.length - 1, ini + altoReemplazo + CONTEXTO);
    const ultimo = rangos.at(-1);
    if (ultimo && desde <= ultimo[1] + 1) ultimo[1] = Math.max(ultimo[1], hasta);
    else rangos.push([desde, hasta]);
  }
  const bloques = rangos.slice(0, MAX_FRAGMENTOS).map(([desde, hasta]) => {
    const filas: string[] = [];
    for (let i = desde; i <= hasta; i++) filas.push(`${i + 1}\t${lineas[i] ?? ""}`);
    return filas.join("\n");
  });
  if (rangos.length > MAX_FRAGMENTOS) bloques.push(`[y ${rangos.length - MAX_FRAGMENTOS} zonas más]`);
  return bloques.join("\n…\n");
}

const normalizarEspacios = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .join("\n");

function pistaSinCoincidencias(texto: string, buscar: string): string {
  const lineasBuscar = buscar.split("\n").filter((l) => l.trim());
  if (lineasBuscar.length > 0 && lineasBuscar.every((l) => /^\s*\d+\t/.test(l))) {
    return "Parece que incluye los números de línea de la salida de leer; quítalos y deja solo el texto.";
  }

  const textoNorm = normalizarEspacios(texto);
  const buscarNorm = normalizarEspacios(buscar).trim();
  const enNorm = buscarNorm ? textoNorm.indexOf(buscarNorm) : -1;
  if (enNorm >= 0) {
    const tabs = (texto.match(/^\t/gm) ?? []).length;
    const espacios = (texto.match(/^ {2}/gm) ?? []).length;
    const sangria = tabs > espacios ? "tabulaciones" : espacios > 0 ? "espacios" : "";
    return (
      `Sí aparece si se ignoran espacios y tabulaciones (línea ${lineaDe(textoNorm, enNorm) + 1}): ` +
      `revisa la sangría${sangria ? ` (el fichero usa ${sangria})` : ""} y los espacios al final de línea, y copia el texto exacto de leer.`
    );
  }

  const lineas = texto.split("\n");
  const primera = lineasBuscar[0]?.trim();
  if (primera) {
    const iguales = lineas.flatMap((l, i) => (l.trim() === primera ? [i + 1] : []));
    if (iguales.length > 0) {
      return `La primera línea de 'buscar' está en la línea ${iguales.slice(0, 5).join(", ")}, pero lo que sigue no coincide; vuelve a leer esa zona.`;
    }
    const parecidas = lineas
      .map((l, i) => ({ i, l, p: parecido(primera, l.trim()) }))
      .filter((x) => x.p >= 0.6)
      .sort((a, b) => b.p - a.p)
      .slice(0, 3)
      .sort((a, b) => a.i - b.i);
    if (parecidas.length > 0) {
      const lista = parecidas.map((x) => `${x.i + 1}: ${x.l.trim().slice(0, 160)}`).join("\n");
      return `Líneas parecidas a la primera de 'buscar':\n${lista}\nVuelve a leer el fichero y copia el texto exacto.`;
    }
  }
  return "Vuelve a leer el fichero y copia el texto exacto (espacios, tabulaciones y saltos de línea incluidos).";
}

/** Coeficiente de Dice sobre pares de caracteres (0–1). */
function parecido(a: string, b: string): number {
  if (!a || !b) return 0;
  a = a.slice(0, 300);
  b = b.slice(0, 300);
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pares = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const p = a.slice(i, i + 2);
    pares.set(p, (pares.get(p) ?? 0) + 1);
  }
  let comunes = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const p = b.slice(i, i + 2);
    const c = pares.get(p) ?? 0;
    if (c > 0) {
      comunes++;
      pares.set(p, c - 1);
    }
  }
  return (2 * comunes) / (a.length - 1 + b.length - 1);
}
