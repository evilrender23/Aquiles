export interface Cita {
  titulo: string;
  /** Fecha y hora en ISO 8601, con `Z` o con desfase (`+02:00`). */
  inicio: string;
}

export interface Dia {
  /** AAAA-MM-DD en la zona pedida. */
  dia: string;
  citas: { hora: string; titulo: string }[];
}

function partes(iso: string, zona: string): Record<string, string> {
  const formato = new Intl.DateTimeFormat("en-CA", {
    timeZone: zona,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(formato.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
}

/** Fecha del calendario (AAAA-MM-DD) del instante `iso` en la zona horaria IANA `zona`. */
export function diaLocal(iso: string, zona: string): string {
  const p = partes(iso, zona);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Hora local (HH:MM, de 00:00 a 23:59) del instante `iso` en la zona `zona`. */
export function horaLocal(iso: string, zona: string): string {
  const p = partes(iso, zona);
  return `${p.hour}:${p.minute}`;
}

/** Agrupa las citas por día local: días en orden y, dentro de cada día, citas en orden cronológico. */
export function agruparPorDia(citas: Cita[], zona: string): Dia[] {
  const grupos = new Map<string, Cita[]>();
  for (const c of citas) {
    const dia = diaLocal(c.inicio, zona);
    grupos.set(dia, [...(grupos.get(dia) ?? []), c]);
  }
  return [...grupos.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dia, cs]) => ({
      dia,
      citas: cs
        .sort((x, y) => Date.parse(x.inicio) - Date.parse(y.inicio))
        .map((c) => ({ hora: horaLocal(c.inicio, zona), titulo: c.titulo })),
    }));
}
