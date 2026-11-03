import type { DestinoMemoria, OrigenAprendizaje, Propuesta } from "@aquiles/protocolo";
import { t } from "@aquiles/ui";
import { useAcciones, useEstado } from "./almacen";
import { type Carga, useCarga } from "./carga";

/** Propuestas pendientes; se vuelven a pedir con aprendizaje.actualizado (y al reconectar). */
export function usePropuestas(): Carga<Propuesta[]> {
  const { revisiones } = useEstado();
  const { listarPropuestas } = useAcciones();
  return useCarga("propuestas", revisiones.aprendizaje, listarPropuestas);
}

/** Con getters: cada lectura sale en el idioma de la interfaz de ese momento. */
export const DESTINOS: Record<DestinoMemoria, string> = {
  get usuario() {
    return t("Tú");
  },
  get agente() {
    return t("Agente");
  },
  get proyecto() {
    return t("Proyecto");
  },
};

export const ORIGENES: Record<OrigenAprendizaje["tipo"], string> = {
  get sesion() {
    return t("Sesión");
  },
  get revision() {
    return t("Revisión");
  },
  aprender: "/aprender",
  get manual() {
    return t("Manual");
  },
};

/** «Memoria · Agente», «Habilidad nueva · nombre»… */
export function tipoAprendizaje(p: { tipo: "memoria" | "skill"; destino?: DestinoMemoria; nombre?: string; nueva?: boolean }): string {
  if (p.tipo === "memoria") return p.destino ? t("Memoria · {destino}", { destino: DESTINOS[p.destino] }) : t("Memoria");
  const tipo = p.nueva ? t("Habilidad nueva") : t("Habilidad");
  return p.nombre ? `${tipo} · ${p.nombre}` : tipo;
}
