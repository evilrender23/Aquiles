/**
 * Expresiones de «cuando» de las tareas programadas, en español y en hora local, sin distinguir mayúsculas ni tildes.
 * - Una vez: «en 30m», «en 2 horas», «hoy 18:00», «mañana a las 9», «2026-11-02 10:00».
 * - Repetidas: «cada 15m», «cada hora», «cada día 9:00», «cada lunes y jueves 18:30», «días laborables 8:00»,
 *   «cada mes el día 1 10:00» o cron de 5 campos («0 9 * * 1-5»).
 *
 * Las de calendario (días de la semana, del mes y cron) se reducen a los cinco conjuntos de una expresión cron y
 * comparten el cálculo de la siguiente fecha.
 */

export class ErrorCron extends Error {}

export interface Expresion {
  /** Frase corta: «cada lunes a las 9:00». */
  descripcion: string;
  repite: boolean;
  /** Primera ejecución posterior a `desde`; undefined si ya no habrá más. */
  siguiente(desde: Date): Date | undefined;
}

const MINUTO_MS = 60_000;
const DIA_MS = 24 * 60 * MINUTO_MS;
/** Hasta dónde se busca la siguiente fecha de calendario (un 29 de febrero puede tardar 8 años). */
const HORIZONTE_MS = 8 * 366 * DIA_MS;

const AYUDA =
  "Formatos válidos: una vez, «en 30m», «en 2 horas», «hoy 18:00», «mañana a las 9» o «2026-11-02 10:00»; " +
  "repetidas, «cada 15m», «cada hora», «cada día 9:00», «cada lunes y jueves 18:30», «días laborables 8:00», " +
  "«cada mes el día 1 10:00» o cron de 5 campos («0 9 * * 1-5»).";

const UNIDAD = "(m|min|minutos?|h|horas?|d|dias?|semanas?)";
const HORA = "(?:a las? )?(\\d{1,2})(?:[:.](\\d{2}))?h?";
const DIA_SEMANA = "lunes|martes|miercoles|jueves|viernes|sabados?|domingos?";
const SEMANA: Record<string, number> = {
  domingo: 0, domingos: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, sabados: 6,
};
const NOMBRES_DIA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const re = (patron: string) => new RegExp(`^${patron}$`);
const PATRONES = {
  dentroDe: re(`en (\\d+) ?${UNIDAD}`),
  diaRelativo: re(`(hoy|manana|pasado manana) ${HORA}`),
  fecha: re(`(\\d{4})-(\\d{1,2})-(\\d{1,2})(?: |t)${HORA}`),
  intervalo: re(`cada (?:(\\d+) ?)?${UNIDAD}`),
  diario: re(`(?:cada dia|todos los dias|a diario|diariamente) ${HORA}`),
  semanal: re(`(?:cada|todos los|los) ((?:${DIA_SEMANA})(?:(?:, | y | e )(?:${DIA_SEMANA}))*) ${HORA}`),
  laborables: re(`(?:(?:(?:cada|todos los|los) )?dias? laborables?|entre semana) ${HORA}`),
  findes: re(`(?:(?:cada|todos los|los) )?fines? de semana ${HORA}`),
  mensual: re(`(?:cada mes(?: el)?(?: dia)? (\\d{1,2})|el (?:dia )?(\\d{1,2}) de cada mes) ${HORA}`),
  cron: re("([\\d*,/-]+) ([\\d*,/-]+) ([\\d*,/-]+) ([\\d*,/-]+) ([\\d*,/-]+)"),
};

/** Lo que se cumple de una expresión de calendario: los cinco campos de cron. */
interface Calendario {
  minutos: Set<number>;
  horas: Set<number>;
  dias: Set<number>;
  meses: Set<number>;
  /** 0 = domingo. */
  semana: Set<number>;
  /** El campo se escribió como «*»: si los dos están restringidos, basta con que se cumpla uno (como en cron). */
  diasLibres: boolean;
  semanaLibre: boolean;
  fuente: string;
}

export function interpretar(cuando: string, ahora = new Date()): Expresion {
  const original = cuando.trim();
  const t = normalizar(original);
  let m: RegExpExecArray | null;

  if ((m = PATRONES.dentroDe.exec(t))) {
    return unaVez(new Date(ahora.getTime() + cantidad(m[1]!) * msDe(m[2]!)), ahora, original);
  }
  if ((m = PATRONES.diaRelativo.exec(t))) {
    const [h, mi] = hora(m[2]!, m[3]);
    const desplazamiento = m[1] === "hoy" ? 0 : m[1] === "manana" ? 1 : 2;
    const fecha = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + desplazamiento, h, mi);
    return unaVez(fecha, ahora, original);
  }
  if ((m = PATRONES.fecha.exec(t))) {
    const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const [h, mi] = hora(m[4]!, m[5]);
    const fecha = new Date(a, mes - 1, dia, h, mi);
    if (fecha.getMonth() !== mes - 1 || fecha.getDate() !== dia) throw new ErrorCron(`La fecha ${m[1]}-${m[2]}-${m[3]} no existe`);
    return unaVez(fecha, ahora, original);
  }
  if ((m = PATRONES.intervalo.exec(t))) {
    const n = m[1] === undefined ? 1 : cantidad(m[1]);
    const ms = n * msDe(m[2]!);
    return { descripcion: `cada ${n === 1 ? "" : `${n} `}${nombreUnidad(m[2]!, n)}`, repite: true, siguiente: (desde) => new Date(desde.getTime() + ms) };
  }
  if ((m = PATRONES.diario.exec(t))) return deCalendario(calendario(m[1]!, m[2], {}, original), ahora);
  if ((m = PATRONES.semanal.exec(t))) {
    const dias = m[1]!.split(/, | y | e /).map((d) => SEMANA[d]!);
    return deCalendario(calendario(m[2]!, m[3], { semana: dias }, original), ahora);
  }
  if ((m = PATRONES.laborables.exec(t))) return deCalendario(calendario(m[1]!, m[2], { semana: [1, 2, 3, 4, 5] }, original), ahora);
  if ((m = PATRONES.findes.exec(t))) return deCalendario(calendario(m[1]!, m[2], { semana: [6, 0] }, original), ahora);
  if ((m = PATRONES.mensual.exec(t))) {
    const dia = Number(m[1] ?? m[2]);
    if (dia < 1 || dia > 31) throw new ErrorCron(`El día ${dia} no existe en ningún mes`);
    return deCalendario(calendario(m[3]!, m[4], { dias: [dia] }, original), ahora);
  }
  if ((m = PATRONES.cron.exec(t))) return deCalendario(cron(m.slice(1, 6) as string[], original), ahora);
  throw new ErrorCron(`No entiendo «${original}». ${AYUDA}`);
}

/** Las `n` próximas ejecuciones a partir de `desde`. */
export function proximas(e: Expresion, desde: Date, n = 5): Date[] {
  const fechas: Date[] = [];
  for (let d = e.siguiente(desde); d && fechas.length < n; d = e.siguiente(d)) fechas.push(d);
  return fechas;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cantidad(texto: string): number {
  const n = Number(texto);
  if (n < 1) throw new ErrorCron("La cantidad tiene que ser al menos 1");
  return n;
}

function msDe(unidad: string): number {
  if (unidad.startsWith("m")) return MINUTO_MS;
  if (unidad.startsWith("h")) return 60 * MINUTO_MS;
  if (unidad.startsWith("d")) return DIA_MS;
  return 7 * DIA_MS;
}

function nombreUnidad(unidad: string, n: number): string {
  const nombre = unidad.startsWith("m") ? "minuto" : unidad.startsWith("h") ? "hora" : unidad.startsWith("d") ? "día" : "semana";
  return n === 1 ? nombre : `${nombre}s`;
}

function hora(h: string, m: string | undefined): [number, number] {
  const [hh, mm] = [Number(h), Number(m ?? 0)];
  if (hh > 23 || mm > 59) throw new ErrorCron(`La hora ${h}:${m ?? "00"} no existe`);
  return [hh, mm];
}

function unaVez(fecha: Date, ahora: Date, original: string): Expresion {
  if (fecha.getTime() <= ahora.getTime()) throw new ErrorCron(`«${original}» ya ha pasado`);
  const ano = fecha.getFullYear() === ahora.getFullYear() ? "" : ` de ${fecha.getFullYear()}`;
  return {
    descripcion: `una vez, el ${fecha.getDate()} de ${MESES[fecha.getMonth()]}${ano} ${aLas(fecha.getHours(), fecha.getMinutes())}`,
    repite: false,
    siguiente: (desde) => (fecha.getTime() > desde.getTime() ? new Date(fecha) : undefined),
  };
}

const rango = (desde: number, hasta: number) => new Set(Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i));

function calendario(h: string, m: string | undefined, o: { dias?: number[]; semana?: number[] }, fuente: string): Calendario {
  const [hh, mm] = hora(h, m);
  return {
    minutos: new Set([mm]),
    horas: new Set([hh]),
    dias: o.dias ? new Set(o.dias) : rango(1, 31),
    meses: rango(1, 12),
    semana: o.semana ? new Set(o.semana) : rango(0, 6),
    diasLibres: !o.dias,
    semanaLibre: !o.semana,
    fuente,
  };
}

function cron([mi, ho, dm, me, ds]: string[], fuente: string): Calendario {
  const semana = new Set([...campo(ds!, 0, 7, "día de la semana")].map((d) => d % 7));
  return {
    minutos: campo(mi!, 0, 59, "minutos"),
    horas: campo(ho!, 0, 23, "horas"),
    dias: campo(dm!, 1, 31, "día del mes"),
    meses: campo(me!, 1, 12, "mes"),
    semana,
    diasLibres: dm === "*",
    semanaLibre: ds === "*",
    fuente,
  };
}

/** Un campo de cron: «*», números, listas «1,15», rangos «1-5» y pasos «*\/15» o «0-30/10». */
function campo(texto: string, min: number, max: number, nombre: string): Set<number> {
  const valores = new Set<number>();
  for (const parte of texto.split(",")) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(parte);
    if (!m) throw new ErrorCron(`En el campo de ${nombre}, «${parte}» no es válido`);
    const paso = m[4] ? Number(m[4]) : 1;
    const desde = m[1] ? min : Number(m[2]);
    const hasta = m[1] ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : desde;
    if (desde < min || hasta > max || desde > hasta || paso < 1) {
      throw new ErrorCron(`En el campo de ${nombre}, «${parte}» se sale de ${min}–${max}`);
    }
    for (let v = desde; v <= hasta; v += paso) valores.add(v);
  }
  return valores;
}

function deCalendario(c: Calendario, ahora: Date): Expresion {
  if (!siguienteFecha(c, ahora)) throw new ErrorCron(`«${c.fuente}» no se cumple nunca`);
  return { descripcion: describir(c), repite: true, siguiente: (desde) => siguienteFecha(c, desde) };
}

/**
 * Avanza desde el minuto siguiente saltando meses, días y horas enteros que no valen. Se usan los métodos locales de
 * Date, así que un cambio de hora no repite ni pierde nada salvo la hora que no existe.
 */
function siguienteFecha(c: Calendario, desde: Date): Date | undefined {
  const t = new Date(desde);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limite = desde.getTime() + HORIZONTE_MS;
  while (t.getTime() <= limite) {
    if (!c.meses.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
    } else if (!diaVale(c, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
    } else if (!c.horas.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
    } else if (!c.minutos.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
    } else {
      return t;
    }
  }
  return undefined;
}

function diaVale(c: Calendario, t: Date): boolean {
  const dia = c.dias.has(t.getDate());
  const semana = c.semana.has(t.getDay());
  if (c.diasLibres) return semana;
  if (c.semanaLibre) return dia;
  return dia || semana;
}

function describir(c: Calendario): string {
  const [m] = c.minutos;
  const [h] = c.horas;
  if (c.minutos.size !== 1 || c.horas.size !== 1 || c.meses.size !== 12) return `cron «${c.fuente}»`;
  const a = aLas(h!, m!);
  if (c.diasLibres && (c.semanaLibre || c.semana.size === 7)) return `cada día ${a}`;
  if (c.diasLibres) {
    // Semana empezando en lunes.
    const dias = [...c.semana].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
    if (dias.join() === "1,2,3,4,5") return `días laborables ${a}`;
    if (dias.join() === "6,0") return `fines de semana ${a}`;
    return `cada ${lista(dias.map((d) => NOMBRES_DIA[d]!))} ${a}`;
  }
  if (c.semanaLibre && c.dias.size === 1) return `el día ${[...c.dias][0]} de cada mes ${a}`;
  return `cron «${c.fuente}»`;
}

function aLas(h: number, m: number): string {
  return `${h === 1 ? "a la" : "a las"} ${h}:${String(m).padStart(2, "0")}`;
}

function lista(xs: string[]): string {
  return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} y ${xs.at(-1)}`;
}
