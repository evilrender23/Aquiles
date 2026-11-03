/** Esfuerzo de razonamiento: los niveles los declara cada proveedor (y a veces cada modelo); aquí solo se nombran. */
import type { EsfuerzoModelo, InfoProveedor } from "@aquiles/protocolo";
import { t } from "@aquiles/ui";

/** Los niveles conocidos con su nombre; los demás, tal como vienen. */
export function nombreEsfuerzo(nivel: string): string {
  switch (nivel) {
    case "low":
      return t("Bajo");
    case "medium":
      return t("Medio");
    case "high":
      return t("Alto");
    case "xhigh":
      return t("Muy alto");
    case "max":
      return t("Máximo");
    default:
      return nivel;
  }
}

/** Niveles de ese modelo (los suyos si el proveedor los da por modelo; si no, los generales). Sin niveles, undefined. */
export function esfuerzoDe(proveedores: InfoProveedor[], proveedor: string | undefined, modelo: string | undefined): EsfuerzoModelo | undefined {
  const p = proveedores.find((x) => x.id === proveedor);
  if (!p?.esfuerzo) return undefined;
  const efectivo = modelo || p.modeloPorDefecto;
  const e = (efectivo ? p.esfuerzo.porModelo?.[efectivo] : undefined) ?? { niveles: p.esfuerzo.niveles, porDefecto: p.esfuerzo.porDefecto };
  return e.niveles.length ? e : undefined;
}

/** «Por defecto» ("") y los niveles; el por defecto lleva el nivel entre paréntesis solo si el proveedor lo dice. */
export function opcionesEsfuerzo(e: EsfuerzoModelo): { valor: string; texto: string }[] {
  const porDefecto = e.porDefecto ? t("Por defecto ({nivel})", { nivel: nombreEsfuerzo(e.porDefecto) }) : t("Por defecto");
  return [{ valor: "", texto: porDefecto }, ...e.niveles.map((n) => ({ valor: n, texto: nombreEsfuerzo(n) }))];
}

/** Al cambiar de modelo: "" si el nivel elegido no está entre los del modelo nuevo; undefined si vale el que hay. */
export function esfuerzoTrasCambio(proveedores: InfoProveedor[], proveedor: string, modelo: string | undefined, actual: string | undefined): "" | undefined {
  if (!actual) return undefined;
  return esfuerzoDe(proveedores, proveedor, modelo)?.niveles.includes(actual) ? undefined : "";
}
