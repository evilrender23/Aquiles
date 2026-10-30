import { z } from "zod";
import type { EspecHerramienta } from "../tipos";

/** Nivel de riesgo; decide qué pide permiso (ver aprobaciones.ts). */
export type Nivel = "lectura" | "escritura" | "ejecucion";

/** Estado de un fichero cuando se leyó; `editar` exige que siga igual. */
export interface Huella {
  mtimeMs: number;
  tamano: number;
  /** Hash del contenido (Bun.hash en hex). */
  hash: string;
}

export interface Pregunta {
  texto: string;
  opciones?: string[];
  /** Permite elegir varias opciones (la respuesta llega separada por comas). */
  multiple?: boolean;
}

export interface Tarea {
  texto: string;
  estado: "pendiente" | "en-curso" | "hecha";
}

/** Cambios que una herramienta quiere mostrar en la interfaz. */
export type NotificacionHerramienta = { tipo: "tareas"; tareas: Tarea[] };

export interface ContextoHerramienta {
  cwd: string;
  senal: AbortSignal;
  sesionId: string;
  /** Ficheros leídos o escritos en la sesión (ruta absoluta normalizada → huella). */
  lecturas: Map<string, Huella>;
  /** Almacén por sesión para herramientas con estado (terminal, procesos, tareas). */
  estado: Map<string, unknown>;
  /** Pregunta al usuario y espera la respuesta. */
  preguntar(p: Pregunta): Promise<string>;
  /** Avisa a la interfaz de un cambio visible. */
  notificar(n: NotificacionHerramienta): void;
  /** Progreso en vivo de una ejecución larga (p. ej. salida de terminal). */
  progreso(texto: string): void;
}

export interface Herramienta<A = unknown> {
  nombre: string;
  descripcion: string;
  nivel: Nivel;
  parametros: z.ZodType<A>;
  /** JSON Schema tal cual para el modelo, cuando no sale de `parametros` (p. ej. herramientas MCP). */
  esquema?: Record<string, unknown>;
  ejecutar(args: A, ctx: ContextoHerramienta): Promise<string>;
  /** Una línea para la tarjeta de la interfaz y la petición de permiso (p. ej. el comando). */
  resumen?(args: A): string;
  /** Rutas absolutas que toca (para avisar si salen de la carpeta de trabajo). */
  rutas?(args: A, cwd: string): string[];
  /** Clave para "permitir siempre" (p. ej. el primer token del comando); por defecto, la herramienta entera. */
  clavePermiso?(args: A): string;
}

export function definir<A>(h: Herramienta<A>): Herramienta<A> {
  return h;
}

export function especDe(h: Herramienta<unknown>): EspecHerramienta {
  const { $schema: _omitido, ...esquema } = h.esquema ?? (z.toJSONSchema(h.parametros) as Record<string, unknown>);
  return { nombre: h.nombre, descripcion: h.descripcion, esquema };
}

/** Error esperable que se devuelve al modelo como resultado, no como fallo del núcleo. */
export class ErrorHerramienta extends Error {}
