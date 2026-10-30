/**
 * Diff por líneas (algoritmo de Myers) agrupado en bloques con contexto, para mostrar
 * en la interfaz qué cambió una herramienta de escritura.
 */
import type { Diff } from "@aquiles/protocolo";

type Op = { tipo: "+" | "-" | " "; texto: string };

const CONTEXTO = 3;
const MAX_LINEAS_DIFF = 400;
/** Por encima de esto no se calcula el diff fino (sería caro); se marca como reemplazo completo. */
const MAX_TRABAJO = 4_000_000;

export function lineas(texto: string): string[] {
  if (texto === "") return [];
  const l = texto.replace(/\r\n/g, "\n").split("\n");
  if (l.at(-1) === "") l.pop();
  return l;
}

/** Secuencia mínima de operaciones de a → b (Myers, O((N+M)·D)). */
export function operaciones(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const desplazamiento = max;
  let v = new Int32Array(2 * max + 2);
  const traza: Int32Array[] = [];
  let fin = -1;
  for (let d = 0; d <= max && fin < 0; d++) {
    traza.push(v.slice());
    if (d * (n + m) > MAX_TRABAJO) return [...a.map((t) => ({ tipo: "-" as const, texto: t })), ...b.map((t) => ({ tipo: "+" as const, texto: t }))];
    const nueva = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[desplazamiento + k - 1]! < v[desplazamiento + k + 1]!) ? v[desplazamiento + k + 1]! : v[desplazamiento + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      nueva[desplazamiento + k] = x;
      if (x >= n && y >= m) {
        fin = d;
        break;
      }
    }
    v = nueva;
  }
  // Reconstrucción hacia atrás con las trazas guardadas.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = fin; d > 0; d--) {
    const vd = traza[d]!;
    const k = x - y;
    const kPrevio = k === -d || (k !== d && vd[desplazamiento + k - 1]! < vd[desplazamiento + k + 1]!) ? k + 1 : k - 1;
    const xPrevio = vd[desplazamiento + kPrevio]!;
    const yPrevio = xPrevio - kPrevio;
    while (x > xPrevio && y > yPrevio) ops.push({ tipo: " ", texto: a[--x]! }) && y--;
    if (x === xPrevio) ops.push({ tipo: "+", texto: b[--y]! });
    else ops.push({ tipo: "-", texto: a[--x]! });
  }
  while (x > 0 && y > 0) ops.push({ tipo: " ", texto: a[--x]! }) && y--;
  return ops.reverse();
}

export function calcularDiff(ruta: string, antes: string | undefined, despues: string): Diff {
  const ops = operaciones(lineas(antes ?? ""), lineas(despues));
  const diff: Diff = { ruta, nuevo: antes === undefined, anadidas: 0, quitadas: 0, bloques: [] };
  let la = 1;
  let ld = 1;
  let bloque: Diff["bloques"][number] | undefined;
  let iguales = 0;
  let total = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.tipo === " ") {
      if (bloque) {
        iguales++;
        // ¿Viene otro cambio cerca? Si no, se cierra el bloque tras el contexto.
        const siguienteCambio = ops.findIndex((o, j) => j > i && o.tipo !== " ");
        if (siguienteCambio < 0 || siguienteCambio - i > CONTEXTO * 2) {
          if (iguales <= CONTEXTO) bloque.lineas.push(op);
          if (iguales >= CONTEXTO) bloque = undefined;
        } else bloque.lineas.push(op);
      }
      la++;
      ld++;
      continue;
    }
    if (!bloque) {
      const inicio = Math.max(0, i - CONTEXTO);
      const previas = ops.slice(inicio, i).filter((o) => o.tipo === " ");
      bloque = { lineaAntes: la - previas.length, lineaDespues: ld - previas.length, lineas: [...previas] };
      diff.bloques.push(bloque);
    }
    iguales = 0;
    if (total < MAX_LINEAS_DIFF) bloque.lineas.push(op);
    else diff.truncado = true;
    total++;
    if (op.tipo === "+") {
      diff.anadidas++;
      ld++;
    } else {
      diff.quitadas++;
      la++;
    }
  }
  return diff;
}
