import type { DestinoMemoria, OrigenAprendizaje, Propuesta } from "@aquiles/protocolo";
import { useAcciones, useEstado } from "./almacen";
import { type Carga, useCarga } from "./carga";

/** Propuestas pendientes; se vuelven a pedir con aprendizaje.actualizado (y al reconectar). */
export function usePropuestas(): Carga<Propuesta[]> {
  const { revisiones } = useEstado();
  const { listarPropuestas } = useAcciones();
  return useCarga("propuestas", revisiones.aprendizaje, listarPropuestas);
}

export const DESTINOS: Record<DestinoMemoria, string> = { usuario: "Tú", agente: "Agente", proyecto: "Proyecto" };

export const ORIGENES: Record<OrigenAprendizaje["tipo"], string> = { sesion: "Sesión", revision: "Revisión", aprender: "/aprender", manual: "Manual" };

/** «Memoria · Agente», «Habilidad nueva · nombre»… */
export function tipoAprendizaje(p: { tipo: "memoria" | "skill"; destino?: DestinoMemoria; nombre?: string; nueva?: boolean }): string {
  if (p.tipo === "memoria") return p.destino ? `Memoria · ${DESTINOS[p.destino]}` : "Memoria";
  const tipo = p.nueva ? "Habilidad nueva" : "Habilidad";
  return p.nombre ? `${tipo} · ${p.nombre}` : tipo;
}
