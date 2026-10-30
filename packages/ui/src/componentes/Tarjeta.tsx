import type { HTMLAttributes, ReactNode } from "react";
import { clases } from "../clases";

export interface PropsTarjeta extends HTMLAttributes<HTMLDivElement> {
  /** destacada: borde lima al 45 % (permisos, preguntas). punteada: trabajo en segundo plano. */
  variante?: "normal" | "destacada" | "punteada";
  relleno?: number | string;
  como?: "div" | "section" | "article";
  children?: ReactNode;
}

export function Tarjeta({ variante = "normal", relleno, como: Etq = "div", className, style, ...resto }: PropsTarjeta) {
  return (
    <Etq
      className={clases("nx-tarjeta", variante !== "normal" && `nx-tarjeta--${variante}`, className)}
      style={relleno !== undefined ? { padding: relleno, ...style } : style}
      {...resto}
    />
  );
}

export interface PropsBloqueCodigo extends HTMLAttributes<HTMLPreElement> {
  codigo: string;
  /** fuerte: el comando que se va a aprobar, en tinta fuerte. */
  tono?: "apagado" | "fuerte";
}

export function BloqueCodigo({ codigo, tono = "apagado", className, ...resto }: PropsBloqueCodigo) {
  return (
    <pre className={clases("nx-codigo", tono === "fuerte" && "nx-codigo--fuerte", className)} {...resto}>
      {codigo}
    </pre>
  );
}

export interface PropsChip extends HTMLAttributes<HTMLSpanElement> {
  destacado?: boolean;
  children?: ReactNode;
}

/** Insignia en píldora; destacada con lima al 12 % de fondo y borde lima al 45 %. */
export function Chip({ destacado, className, ...resto }: PropsChip) {
  return <span className={clases("nx-chip", destacado && "nx-chip--destacado", className)} {...resto} />;
}

export interface PropsMedidor extends HTMLAttributes<HTMLDivElement> {
  /** 0–1 */
  valor: number;
  etiqueta: string;
}

export function Medidor({ valor, etiqueta, className, ...resto }: PropsMedidor) {
  const v = Math.min(1, Math.max(0, valor));
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> no se deja estilar igual en WebView2; la barra es propia de NOX.
    <div
      role="meter"
      aria-label={etiqueta}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      className={clases("nx-medidor", className)}
      {...resto}
    >
      <span style={{ width: `${v * 100}%` }} />
    </div>
  );
}
