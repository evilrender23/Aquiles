/**
 * Qué herramientas pueden ejecutarse sin preguntar.
 *   preguntar-siempre:  pregunta antes de escribir y de ejecutar.
 *   preguntar-ejecutar: escribe libre dentro de la carpeta de trabajo; pregunta antes de ejecutar (por defecto).
 *   libre-proyecto:     no pregunta dentro de la carpeta de trabajo.
 * Tocar rutas fuera de la carpeta de trabajo pregunta siempre, aunque haya "permitir siempre".
 */
import { relative, resolve } from "node:path";
import type { ModoAprobacion } from "@aquiles/protocolo";
import type { Herramienta } from "./herramientas/herramienta";

export type Decision = { tipo: "permitir" } | { tipo: "preguntar"; motivo: string };

export function clavePermiso(h: Herramienta<any>, args: unknown): string {
  return `${h.nombre}:${h.clavePermiso?.(args) ?? "*"}`;
}

export function dentroDe(ruta: string, carpeta: string): boolean {
  const r = relative(resolve(carpeta), resolve(ruta));
  return r === "" || (!r.startsWith("..") && !/^[a-zA-Z]:/.test(r) && !r.startsWith("\\\\"));
}

export function decidir(
  h: Herramienta<any>,
  args: unknown,
  o: { cwd: string; modo: ModoAprobacion; permitidos: ReadonlySet<string> },
): Decision {
  if (h.nivel === "lectura") return { tipo: "permitir" };
  const fuera = (h.rutas?.(args, o.cwd) ?? []).filter((r) => !dentroDe(r, o.cwd));
  if (fuera.length) return { tipo: "preguntar", motivo: `fuera de la carpeta de trabajo: ${fuera.join(", ")}` };
  if (o.permitidos.has(clavePermiso(h, args)) || o.permitidos.has(`${h.nombre}:*`)) return { tipo: "permitir" };
  if (o.modo === "libre-proyecto") return { tipo: "permitir" };
  if (h.nivel === "escritura") {
    return o.modo === "preguntar-siempre" ? { tipo: "preguntar", motivo: "modifica ficheros" } : { tipo: "permitir" };
  }
  return { tipo: "preguntar", motivo: "ejecuta comandos" };
}
