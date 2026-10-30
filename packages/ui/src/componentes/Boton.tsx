import type { ComponentPropsWithRef, ReactNode } from "react";
import { clases } from "../clases";
import { Icono, type NombreIcono } from "./Icono";

export type VarianteBoton = "principal" | "secundario" | "acento" | "contorno" | "fantasma" | "chip";

/** Con React 19 `ref` llega como una prop más y se pasa al <button>. */
export interface PropsBoton extends ComponentPropsWithRef<"button"> {
  /**
   * principal: píldora con el gradiente lima (un CTA por pantalla).
   * secundario: borde fuerte y texto en mayúsculas.
   * acento: fondo lima al 12 % (la acción recomendada de una tarjeta).
   * contorno, fantasma, chip: acciones secundarias.
   */
  variante?: VarianteBoton;
  tamano?: "normal" | "alto" | "pequeno";
  ancho?: boolean;
  icono?: NombreIcono;
  iconoFinal?: NombreIcono;
  children?: ReactNode;
}

export function Boton({ variante = "contorno", tamano = "normal", ancho, icono, iconoFinal, className, children, type = "button", ...resto }: PropsBoton) {
  const tamIcono = variante === "principal" ? 18 : 16;
  return (
    <button
      type={type}
      className={clases("nx-boton", `nx-boton--${variante}`, tamano !== "normal" && `nx-boton--${tamano}`, ancho && "nx-boton--ancho", className)}
      {...resto}
    >
      {icono && <Icono nombre={icono} tamano={icono === "detener" ? 14 : tamIcono} />}
      {children}
      {iconoFinal && <Icono nombre={iconoFinal} tamano={tamIcono} />}
    </button>
  );
}

export interface PropsBotonIcono extends Omit<ComponentPropsWithRef<"button">, "aria-label"> {
  /** Obligatoria: es el único nombre accesible del botón. */
  etiqueta: string;
  icono: NombreIcono;
  tamanoIcono?: number;
  variante?: "normal" | "pequeno" | "ventana";
}

export function BotonIcono({ etiqueta, icono, tamanoIcono, variante = "normal", className, type = "button", ...resto }: PropsBotonIcono) {
  const tam = tamanoIcono ?? (variante === "normal" ? 18 : 16);
  return (
    <button
      type={type}
      aria-label={etiqueta}
      title={etiqueta}
      className={clases("nx-boton-icono", variante !== "normal" && `nx-boton-icono--${variante}`, className)}
      {...resto}
    >
      <Icono nombre={icono} tamano={tam} />
    </button>
  );
}
