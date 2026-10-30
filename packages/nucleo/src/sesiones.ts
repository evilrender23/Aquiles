/**
 * Sesiones: estado en memoria + un JSONL por sesión en `<perfil>/sesiones/<id>.jsonl`.
 * Líneas: {"tipo":"inicio",…}, {"tipo":"mensaje","mensaje":…}, {"tipo":"ajuste",…} (proveedor, modelo,
 * permisos o título), {"tipo":"compactacion","mensajes":[…]} (sustituye el historial entero) y
 * {"tipo":"turno"} al empezar cada turno y {"tipo":"uso","uso":{…},"fecha":…} al acabarlo: un turno sin su línea
 * «uso» es uno que se cortó porque el núcleo se cerró (la sesión sale como interrumpida).
 * Una última línea cortada se ignora al cargar.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InfoSesion, MensajeHistorial, ModoAprobacion, Uso } from "@aquiles/protocolo";
import { infoAdjunto } from "./adjuntos";
import { INSTRUCCIONES_ARTEFACTOS } from "./artefactos";
import type { Huella } from "./herramientas/herramienta";
import type { Mensaje } from "./tipos";

export interface Sesion {
  id: string;
  cwd: string;
  /** Se fija al crear la sesión y no cambia, para que la caché de prompt del proveedor sirva. */
  sistema: string;
  mensajes: Mensaje[];
  creada: string;
  actualizada: string;
  modoAprobacion: ModoAprobacion;
  proveedor: string;
  modelo?: string;
  /** Nivel de esfuerzo de razonamiento elegido; si falta, el del modelo. */
  esfuerzo?: string;
  /** Título puesto a mano; si falta, se usa el primer mensaje. */
  titulo?: string;
  /** Quién la abrió si no fue la app (tarea programada, chat de un canal, subagente). */
  origen?: OrigenSesion;
  /** Líneas "mensaje" escritas en el JSONL (incluidas las anteriores a una compactación). */
  lineasMensaje: number;
  /** Claves de "permitir siempre" concedidas en esta sesión. */
  permitidos: Set<string>;
  lecturas: Map<string, Huella>;
  estado: Map<string, unknown>;
  /** Hay un turno empezado sin terminar en el JSONL (si no está en marcha ahora, se cortó). */
  turnoAbierto: boolean;
  /** Mensajes escritos por el usuario mientras el turno trabaja; entran en el siguiente paso. */
  steer: string[];
  turno?: AbortController;
}

export type OrigenSesion = NonNullable<InfoSesion["origen"]>;

export interface OpcionesSesion {
  modoAprobacion?: ModoAprobacion;
  proveedor: string;
  modelo?: string;
  esfuerzo?: string;
  titulo?: string;
  origen?: OrigenSesion;
}

export interface Ajuste {
  modoAprobacion?: ModoAprobacion;
  proveedor?: string;
  modelo?: string;
  /** "" = volver al del modelo. */
  esfuerzo?: string;
  titulo?: string;
}

export function sistemaBase(cwd: string, fecha = new Date()): string {
  return [
    "Eres Aquiles, un agente personal que trabaja en el ordenador del usuario.",
    `Carpeta de trabajo: ${cwd}`,
    `Fecha: ${fecha.toISOString().slice(0, 10)}`,
    "Responde en el idioma del usuario, de forma directa.",
    "Comprueba con las herramientas en vez de suponer el contenido de los ficheros.",
    "Nunca inventes la salida de un comando ni el contenido de un fichero: si no lo has ejecutado o leído con una herramienta, no lo des por hecho.",
    "Lee un fichero antes de editarlo; usa editar para cambios concretos y escribir para ficheros nuevos.",
    "Ejecuta los tests o comandos que demuestren que el cambio funciona antes de darlo por terminado.",
    "En trabajos de varios pasos, lleva la lista con la herramienta tareas.",
  ].join("\n");
}

type Linea =
  | {
      tipo: "inicio"; id: string; cwd: string; sistema: string; creada: string; modoAprobacion: ModoAprobacion;
      proveedor?: string; modelo?: string; esfuerzo?: string; titulo?: string; origen?: OrigenSesion;
    }
  | { tipo: "mensaje"; mensaje: Mensaje; fecha?: string }
  | ({ tipo: "ajuste" } & Ajuste)
  | { tipo: "compactacion"; mensajes: Mensaje[] }
  | { tipo: "uso"; uso: Uso; motivo: string; fecha: string }
  | { tipo: "turno"; fecha: string };

export interface GanchosSesiones {
  /** Construye el system prompt de una sesión nueva (se congela para toda la sesión). */
  sistema?: (cwd: string) => string;
  /** Tras guardar un mensaje; `ordinal` = posición de su línea "mensaje" en el JSONL (desde 0). */
  alAnotar?: (s: Sesion, m: Mensaje, ordinal: number, fecha: string) => void;
}

export class AlmacenSesiones {
  private enMemoria = new Map<string, Sesion>();

  /** `directorio` null: solo en memoria (tests). */
  constructor(
    private directorio: string | null,
    private proveedorPorDefecto = "agy",
    private ganchos: GanchosSesiones = {},
  ) {
    if (directorio) mkdirSync(directorio, { recursive: true });
  }

  crear(cwd: string, o: OpcionesSesion = { proveedor: this.proveedorPorDefecto }): Sesion {
    const ahora = new Date().toISOString();
    const modo = o.modoAprobacion ?? "preguntar-ejecutar";
    const base = this.ganchos.sistema?.(cwd) ?? sistemaBase(cwd);
    // Los canales de chat no pueden enseñar artefactos, y un subagente responde a otro agente.
    const conArtefactos = o.origen?.tipo !== "canal" && o.origen?.tipo !== "subagente";
    const sistema = conArtefactos ? `${base}\n\n${INSTRUCCIONES_ARTEFACTOS}` : base;
    const s = nueva(crypto.randomUUID(), cwd, sistema, ahora, modo, o.proveedor, o.modelo);
    if (o.esfuerzo) s.esfuerzo = o.esfuerzo;
    if (o.titulo) s.titulo = o.titulo;
    if (o.origen) s.origen = o.origen;
    this.enMemoria.set(s.id, s);
    this.escribir(
      s,
      {
        tipo: "inicio", id: s.id, cwd, sistema: s.sistema, creada: ahora, modoAprobacion: modo, proveedor: o.proveedor,
        ...(o.modelo ? { modelo: o.modelo } : {}), ...(o.esfuerzo ? { esfuerzo: o.esfuerzo } : {}),
        ...(o.titulo ? { titulo: o.titulo } : {}), ...(o.origen ? { origen: o.origen } : {}),
      },
      true,
    );
    return s;
  }

  /** Busca en memoria y, si no está, la carga del disco. */
  obtener(id: string): Sesion | undefined {
    const s = this.enMemoria.get(id);
    if (s) return s;
    const ruta = this.ruta(id);
    if (!ruta || !existsSync(ruta)) return undefined;
    const cargada = cargar(ruta, this.proveedorPorDefecto);
    if (cargada) this.enMemoria.set(id, cargada);
    return cargada;
  }

  anotar(s: Sesion, m: Mensaje): void {
    const fecha = new Date().toISOString();
    this.escribir(s, { tipo: "mensaje", mensaje: m, fecha });
    const ordinal = s.lineasMensaje++;
    this.ganchos.alAnotar?.(s, m, ordinal, fecha);
  }

  anotarInicioTurno(s: Sesion): void {
    s.turnoAbierto = true;
    this.escribir(s, { tipo: "turno", fecha: new Date().toISOString() });
  }

  /** Tokens gastados en un turno ya terminado; también lo cierra. */
  anotarUso(s: Sesion, uso: Uso, motivo: string): void {
    s.turnoAbierto = false;
    this.escribir(s, { tipo: "uso", uso, motivo, fecha: new Date().toISOString() });
  }

  anotarCompactacion(s: Sesion): void {
    this.escribir(s, { tipo: "compactacion", mensajes: s.mensajes });
  }

  ajustar(s: Sesion, a: Ajuste): void {
    aplicar(s, a);
    this.escribir(s, { tipo: "ajuste", ...a });
  }

  /** Borra la sesión de memoria y de disco. */
  borrar(id: string): boolean {
    const s = this.enMemoria.get(id);
    this.enMemoria.delete(id);
    s?.turno?.abort();
    const ruta = this.ruta(id);
    if (!ruta || !existsSync(ruta)) return s !== undefined;
    rmSync(ruta, { force: true });
    return true;
  }

  listar(): InfoSesion[] {
    const vistas = new Map<string, InfoSesion>();
    if (this.directorio) {
      for (const f of readdirSync(this.directorio)) {
        if (!f.endsWith(".jsonl")) continue;
        const id = f.slice(0, -6);
        if (this.enMemoria.has(id)) continue;
        const s = cargar(join(this.directorio, f), this.proveedorPorDefecto);
        if (s) vistas.set(id, info(s));
      }
    }
    for (const s of this.enMemoria.values()) vistas.set(s.id, info(s));
    return [...vistas.values()].sort((a, b) => b.actualizada.localeCompare(a.actualizada));
  }

  enCurso(): Sesion[] {
    return [...this.enMemoria.values()];
  }

  private ruta(id: string): string | undefined {
    if (!this.directorio || !/^[\w-]+$/.test(id)) return undefined;
    return join(this.directorio, `${id}.jsonl`);
  }

  private escribir(s: Sesion, linea: Linea, crear = false): void {
    s.actualizada = new Date().toISOString();
    if (!this.directorio) return;
    const ruta = join(this.directorio, `${s.id}.jsonl`);
    const texto = `${JSON.stringify(linea)}\n`;
    if (crear) writeFileSync(ruta, texto);
    else appendFileSync(ruta, texto);
  }
}

function nueva(
  id: string, cwd: string, sistema: string, creada: string, modoAprobacion: ModoAprobacion, proveedor: string, modelo?: string,
): Sesion {
  return {
    id, cwd, sistema, mensajes: [], creada, actualizada: creada, modoAprobacion, proveedor, ...(modelo ? { modelo } : {}),
    permitidos: new Set(), lecturas: new Map(), estado: new Map(), steer: [], lineasMensaje: 0, turnoAbierto: false,
  };
}

function aplicar(s: Sesion, a: Ajuste): void {
  if (a.modoAprobacion) s.modoAprobacion = a.modoAprobacion;
  if (a.proveedor) s.proveedor = a.proveedor;
  if (a.modelo !== undefined) s.modelo = a.modelo || undefined;
  if (a.esfuerzo !== undefined) s.esfuerzo = a.esfuerzo || undefined;
  if (a.titulo) s.titulo = a.titulo;
}

function cargar(ruta: string, proveedorPorDefecto: string): Sesion | undefined {
  let s: Sesion | undefined;
  for (const bruto of readFileSync(ruta, "utf8").split("\n")) {
    if (!bruto.trim()) continue;
    let l: Linea;
    try {
      l = JSON.parse(bruto);
    } catch {
      continue; // última línea a medio escribir
    }
    if (l.tipo === "inicio") {
      s = nueva(l.id, l.cwd, l.sistema, l.creada, l.modoAprobacion ?? "preguntar-ejecutar", l.proveedor ?? proveedorPorDefecto, l.modelo);
      if (l.esfuerzo) s.esfuerzo = l.esfuerzo;
      if (l.titulo) s.titulo = l.titulo;
      if (l.origen) s.origen = l.origen;
    } else if (s && l.tipo === "mensaje") {
      s.mensajes.push(l.mensaje);
      s.lineasMensaje++;
    }
    else if (s && l.tipo === "compactacion") s.mensajes = l.mensajes;
    else if (s && l.tipo === "ajuste") aplicar(s, l);
    else if (s && l.tipo === "turno") s.turnoAbierto = true;
    else if (s && l.tipo === "uso") s.turnoAbierto = false;
  }
  if (s) s.actualizada = statSync(ruta).mtime.toISOString();
  return s;
}

export function titulo(s: Sesion): string | undefined {
  if (s.titulo) return s.titulo;
  const primero = s.mensajes.find((m) => m.rol === "usuario");
  if (primero?.rol !== "usuario") return undefined;
  // Un mensaje que solo lleva adjuntos se titula con sus nombres.
  const t = (primero.texto.trim() || (primero.adjuntos ?? []).map((a) => a.nombre).join(", ")).replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

export function info(s: Sesion): InfoSesion {
  return {
    sesionId: s.id, cwd: s.cwd, titulo: titulo(s), creada: s.creada, actualizada: s.actualizada,
    mensajes: s.mensajes.length, modoAprobacion: s.modoAprobacion, proveedor: s.proveedor,
    ...(s.modelo ? { modelo: s.modelo } : {}), ...(s.esfuerzo ? { esfuerzo: s.esfuerzo } : {}), trabajando: s.turno !== undefined, ...(s.origen ? { origen: s.origen } : {}),
    ...(s.turnoAbierto && !s.turno ? { interrumpida: true } : {}),
  };
}

export function historial(s: Sesion): MensajeHistorial[] {
  return s.mensajes.map((m) =>
    m.rol === "herramienta"
      ? {
          rol: "herramienta", id: m.id, nombre: m.nombre, resultado: m.resultado.slice(0, 4000), error: m.error,
          ...(m.resumen ? { resumen: m.resumen } : {}), ...(m.diffs ? { diffs: m.diffs } : {}),
        }
      : m.rol === "usuario"
        ? { rol: "usuario", texto: m.texto, ...(m.adjuntos?.length ? { adjuntos: m.adjuntos.map(infoAdjunto) } : {}) }
        : { rol: m.rol, texto: m.texto },
  );
}
