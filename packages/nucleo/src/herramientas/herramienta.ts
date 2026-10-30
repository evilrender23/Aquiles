import { z } from "zod";
import type { EspecHerramienta } from "../tipos";

/** Nivel de riesgo; decide qué pide permiso (fase 1). */
export type Nivel = "lectura" | "escritura" | "ejecucion";

export interface ContextoHerramienta {
  cwd: string;
  senal: AbortSignal;
}

export interface Herramienta<A = unknown> {
  nombre: string;
  descripcion: string;
  nivel: Nivel;
  parametros: z.ZodType<A>;
  ejecutar(args: A, ctx: ContextoHerramienta): Promise<string>;
}

export function definir<A>(h: Herramienta<A>): Herramienta<A> {
  return h;
}

export function especDe(h: Herramienta<unknown>): EspecHerramienta {
  const { $schema: _omitido, ...esquema } = z.toJSONSchema(h.parametros) as Record<string, unknown>;
  return { nombre: h.nombre, descripcion: h.descripcion, esquema };
}

/** Error esperable que se devuelve al modelo como resultado, no como fallo del núcleo. */
export class ErrorHerramienta extends Error {}
