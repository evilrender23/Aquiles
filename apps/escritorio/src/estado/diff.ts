/**
 * Diff por líneas en el cliente, con la misma forma (`Diff`) que mandan las herramientas del núcleo,
 * para pintar con VistaDiff lo que cambiaría una propuesta de skill.
 */
import type { Diff } from "@aquiles/protocolo";

type Linea = Diff["bloques"][number]["lineas"][number];

const CONTEXTO = 3;
const MAX_LINEAS = 400;
/** Tamaño máximo de la tabla de la LCS; por encima se pinta como sustitución completa. */
const MAX_CELDAS = 4_000_000;

function lineas(texto: string): string[] {
  if (texto === "") return [];
  const l = texto.replace(/\r\n/g, "\n").split("\n");
  if (l.at(-1) === "") l.pop();
  return l;
}

/** Operaciones mínimas de `a` a `b` (subsecuencia común más larga). */
function operaciones(a: string[], b: string[]): Linea[] {
  // Lo común al principio y al final no entra en la tabla.
  let ini = 0;
  while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini++;
  let fa = a.length;
  let fb = b.length;
  while (fa > ini && fb > ini && a[fa - 1] === b[fb - 1]) {
    fa--;
    fb--;
  }
  const medioA = a.slice(ini, fa);
  const medioB = b.slice(ini, fb);
  const n = medioA.length;
  const m = medioB.length;
  const medio: Linea[] = [];
  if ((n + 1) * (m + 1) > MAX_CELDAS) {
    for (const t of medioA) medio.push({ tipo: "-", texto: t });
    for (const t of medioB) medio.push({ tipo: "+", texto: t });
  } else {
    // lcs[i][j] = LCS de medioA[i..] y medioB[j..]
    const ancho = m + 1;
    const lcs = new Uint32Array((n + 1) * ancho);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * ancho + j] = medioA[i] === medioB[j] ? lcs[(i + 1) * ancho + j + 1]! + 1 : Math.max(lcs[(i + 1) * ancho + j]!, lcs[i * ancho + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && medioA[i] === medioB[j]) {
        medio.push({ tipo: " ", texto: medioA[i]! });
        i++;
        j++;
      } else if (i < n && (j === m || lcs[(i + 1) * ancho + j]! >= lcs[i * ancho + j + 1]!)) medio.push({ tipo: "-", texto: medioA[i++]! });
      else medio.push({ tipo: "+", texto: medioB[j++]! });
    }
  }
  return [...a.slice(0, ini).map((texto) => ({ tipo: " " as const, texto })), ...medio, ...a.slice(fa).map((texto) => ({ tipo: " " as const, texto }))];
}

export function calcularDiff(ruta: string, antes: string | undefined, despues: string): Diff {
  const ops = operaciones(lineas(antes ?? ""), lineas(despues));
  const diff: Diff = { ruta, nuevo: antes === undefined, anadidas: 0, quitadas: 0, bloques: [] };
  const cambios = ops.flatMap((o, i) => (o.tipo === " " ? [] : [i]));
  for (const i of cambios) {
    if (ops[i]!.tipo === "+") diff.anadidas++;
    else diff.quitadas++;
  }

  // Tramos [desde, hasta) con contexto; dos cambios a menos de 2·CONTEXTO líneas van en el mismo bloque.
  const tramos: [number, number][] = [];
  for (const i of cambios) {
    const desde = Math.max(0, i - CONTEXTO);
    const hasta = Math.min(ops.length, i + 1 + CONTEXTO);
    const ultimo = tramos.at(-1);
    if (ultimo && desde <= ultimo[1]) ultimo[1] = hasta;
    else tramos.push([desde, hasta]);
  }

  // Número de línea antes / después al principio de cada operación.
  let la = 1;
  let ld = 1;
  const posiciones = ops.map((o) => {
    const p = [la, ld] as const;
    if (o.tipo !== "+") la++;
    if (o.tipo !== "-") ld++;
    return p;
  });

  let total = 0;
  for (const [desde, hasta] of tramos) {
    if (total >= MAX_LINEAS) {
      diff.truncado = true;
      break;
    }
    const [lineaAntes, lineaDespues] = posiciones[desde]!;
    const lineasBloque = ops.slice(desde, Math.min(hasta, desde + MAX_LINEAS - total));
    if (lineasBloque.length < hasta - desde) diff.truncado = true;
    total += lineasBloque.length;
    diff.bloques.push({ lineaAntes, lineaDespues, lineas: lineasBloque });
  }
  return diff;
}
