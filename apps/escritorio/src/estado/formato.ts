import type { InfoProveedor, ModoAprobacion } from "@aquiles/protocolo";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export function hora(ts: number | string | Date): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** «ahora», «hace 5 min», «hoy 08:00», «ayer», «27 oct», «27 oct 2025». */
export function fechaRelativa(iso: string, ahora = Date.now()): string {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return "";
  const min = Math.floor((ahora - t) / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const hoy = new Date(ahora);
  const mismoDia = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (mismoDia(d, hoy)) return `hoy ${hora(d)}`;
  const ayer = new Date(ahora);
  ayer.setDate(ayer.getDate() - 1);
  if (mismoDia(d, ayer)) return "ayer";
  const base = `${d.getDate()} ${MESES[d.getMonth()]}`;
  return d.getFullYear() === hoy.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Para cifras grandes: «hoy», «ayer», «27 oct», «27 oct 2025». */
export function fechaCorta(iso: string, ahora = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hoy = new Date(ahora);
  const ayer = new Date(ahora);
  ayer.setDate(ayer.getDate() - 1);
  const mismoDia = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (mismoDia(d, hoy)) return "hoy";
  if (mismoDia(d, ayer)) return "ayer";
  const base = `${d.getDate()} ${MESES[d.getMonth()]}`;
  return d.getFullYear() === hoy.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Como fechaRelativa, con la hora también en días pasados: «hace 5 min», «hoy 08:00», «ayer 21:10», «27 oct 09:30». */
export function fechaConHora(iso: string, ahora = Date.now()): string {
  const r = fechaRelativa(iso, ahora);
  return r === "" || r === "ahora" || r.startsWith("hace") || r.startsWith("hoy") ? r : `${r} ${hora(iso)}`;
}

/** Fecha y hora completas, para el title. */
export function fechaCompleta(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short" });
}

const decimal = (n: number) => n.toFixed(1).replace(/\.0$/, "").replace(".", ",");

/** 61400 → «61,4k»; 200000 → «200k». */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${decimal(n / 1_000_000)}M`;
  if (n >= 1000) return `${decimal(n / 1000)}k`;
  return String(n);
}

export function duracion(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** Último tramo de una ruta de Windows o POSIX. */
export function nombreCarpeta(ruta: string): string {
  const partes = ruta.replace(/[\\/]+$/, "").split(/[\\/]/);
  return partes.at(-1) || ruta;
}

export const MODOS: Record<ModoAprobacion, string> = {
  "preguntar-siempre": "Preguntar siempre",
  "preguntar-ejecutar": "Preguntar al ejecutar",
  "libre-proyecto": "Libre en el proyecto",
};

/** Lo que se enseña como modelo de una sesión o de los ajustes. */
export function nombreModelo(proveedor: string, modelo: string | undefined, proveedores: InfoProveedor[]): string {
  if (modelo) return modelo;
  const p = proveedores.find((x) => x.id === proveedor);
  return p?.modeloPorDefecto ?? p?.nombre ?? proveedor;
}

/** Fechas que vienen (próxima ejecución): «hoy 09:00», «mañana 09:00», «lun 3 nov 09:00». */
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
export function fechaProxima(iso: string, ahora = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hoy = new Date(ahora);
  const manana = new Date(ahora);
  manana.setDate(manana.getDate() + 1);
  const mismoDia = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (mismoDia(d, hoy)) return `hoy ${hora(d)}`;
  if (mismoDia(d, manana)) return `mañana ${hora(d)}`;
  const base = `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
  return `${d.getFullYear() === hoy.getFullYear() ? base : `${base} ${d.getFullYear()}`} ${hora(d)}`;
}

/** Duración entre dos fechas ISO («41,0 s», «1 min 12 s»); vacío si falta el fin. */
export function duracionEntre(inicio: string, fin?: string): string {
  if (!fin) return "";
  const ms = new Date(fin).getTime() - new Date(inicio).getTime();
  return Number.isFinite(ms) && ms >= 0 ? duracion(ms) : "";
}
