/**
 * Análisis de los resultados del banco: agrupar repeticiones por tarea, detectar ejecuciones rotas y comparar dos
 * ejecuciones. Sin el agente ni el sistema de ficheros, para poder probarlo.
 */

export interface TokensBanco {
  entrada: number;
  salida: number;
  razonamiento: number;
  total: number;
}

/** Lo que importa aquí de cada resultado (los JSON antiguos no traen `repeticion` ni `sospechosa`). */
export interface ResultadoTarea {
  id: string;
  ok: boolean;
  fin: string | null;
  segundos: number;
  tokens: TokensBanco;
  llamadas: number;
  repeticion?: number;
}

/** Termina «bien» sin haber usado ninguna herramienta: lo normal es que el modelo no llegara a poder usarlas. */
export const esSospechosa = (r: Pick<ResultadoTarea, "fin" | "llamadas">) => r.fin === "fin" && r.llamadas === 0;

export interface ResumenTarea {
  id: string;
  repeticiones: number;
  aprobadas: number;
  /** Aprobadas / repeticiones, de 0 a 1. */
  tasa: number;
  tokensMedia: number;
  segundosMedia: number;
  /** Desviación típica de los segundos (0 con una sola repetición). */
  segundosDesv: number;
  sospechosas: number;
}

const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const desviacion = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = media(xs);
  return Math.sqrt(media(xs.map((x) => (x - m) ** 2)));
};
const redondear = (x: number, decimales = 1) => Math.round(x * 10 ** decimales) / 10 ** decimales;

/** Una fila por tarea, en el orden en que aparecen, con todas sus repeticiones juntas. */
export function porTarea(resultados: readonly ResultadoTarea[]): ResumenTarea[] {
  const grupos = new Map<string, ResultadoTarea[]>();
  for (const r of resultados) grupos.set(r.id, [...(grupos.get(r.id) ?? []), r]);
  return [...grupos].map(([id, rs]) => {
    const aprobadas = rs.filter((r) => r.ok).length;
    return {
      id,
      repeticiones: rs.length,
      aprobadas,
      tasa: rs.length ? aprobadas / rs.length : 0,
      tokensMedia: Math.round(media(rs.map((r) => r.tokens.total))),
      segundosMedia: redondear(media(rs.map((r) => r.segundos))),
      segundosDesv: redondear(desviacion(rs.map((r) => r.segundos))),
      sospechosas: rs.filter(esSospechosa).length,
    };
  });
}

export interface ResumenEjecucion {
  /** Aprobadas por repetición: media y desviación típica. */
  aprobadasMedia: number;
  aprobadasDesv: number;
  tareas: number;
  repeticiones: number;
  sospechosas: number;
  /** Más de la mitad de las tareas terminaron sin usar herramientas: la ejecución probablemente no mide el motor. */
  probablementeRota: boolean;
  /** Tokens gastados por tarea aprobada (null si no aprobó ninguna). */
  tokensPorAprobada: number | null;
}

export function resumir(resultados: readonly ResultadoTarea[]): ResumenEjecucion {
  const reps = new Map<number, ResultadoTarea[]>();
  for (const r of resultados) reps.set(r.repeticion ?? 1, [...(reps.get(r.repeticion ?? 1) ?? []), r]);
  const aprobadasPorRep = [...reps.values()].map((rs) => rs.filter((r) => r.ok).length);
  const sospechosas = resultados.filter(esSospechosa).length;
  const aprobadas = resultados.filter((r) => r.ok).length;
  const tokens = resultados.reduce((s, r) => s + r.tokens.total, 0);
  return {
    aprobadasMedia: redondear(media(aprobadasPorRep)),
    aprobadasDesv: redondear(desviacion(aprobadasPorRep)),
    tareas: new Set(resultados.map((r) => r.id)).size,
    repeticiones: reps.size,
    sospechosas,
    probablementeRota: resultados.length > 0 && sospechosas > resultados.length / 2,
    tokensPorAprobada: aprobadas ? Math.round(tokens / aprobadas) : null,
  };
}

export interface Comparacion {
  id: string;
  /** Tasa de aprobadas en A y en B (undefined si la tarea no está en ese fichero). */
  a?: number;
  b?: number;
  cambio: "mejora" | "empeora" | "igual" | "nueva" | "quitada";
  tokensA?: number;
  tokensB?: number;
  segundosA?: number;
  segundosB?: number;
}

/** Tarea a tarea: qué mejora o empeora de A a B, con tokens y tiempo. */
export function comparar(a: readonly ResultadoTarea[], b: readonly ResultadoTarea[]): Comparacion[] {
  const ra = new Map(porTarea(a).map((t) => [t.id, t]));
  const rb = new Map(porTarea(b).map((t) => [t.id, t]));
  const ids = [...new Set([...ra.keys(), ...rb.keys()])].sort();
  return ids.map((id) => {
    const x = ra.get(id);
    const y = rb.get(id);
    const cambio = !x ? "nueva" : !y ? "quitada" : y.tasa > x.tasa ? "mejora" : y.tasa < x.tasa ? "empeora" : "igual";
    return {
      id,
      cambio,
      ...(x ? { a: x.tasa, tokensA: x.tokensMedia, segundosA: x.segundosMedia } : {}),
      ...(y ? { b: y.tasa, tokensB: y.tokensMedia, segundosB: y.segundosMedia } : {}),
    };
  });
}
