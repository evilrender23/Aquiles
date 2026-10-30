import type { HTMLAttributes, ReactNode } from "react";
import { clases } from "../clases";

export interface PropsEtiqueta extends HTMLAttributes<HTMLSpanElement> {
  tono?: "apagado" | "lima";
  children?: ReactNode;
}

/** Etiqueta en mayúsculas con +32 % de tracking (estilo `label` de NOX). */
export function Etiqueta({ tono = "apagado", className, ...resto }: PropsEtiqueta) {
  return <span className={clases("nx-etiqueta", tono === "lima" && "nx-etiqueta--lima", className)} {...resto} />;
}

export interface PropsTitular extends HTMLAttributes<HTMLHeadingElement> {
  texto: string;
  tamano?: "l" | "m";
  nivel?: 1 | 2;
}

/**
 * Titular en mayúsculas con la palabra clave (la última) y un punto final en lima.
 * Con una sola palabra solo el punto va en lima, como el logotipo «NOX.».
 */
export function Titular({ texto, tamano = "m", nivel = 1, className, ...resto }: PropsTitular) {
  const limpio = texto.trim().replace(/[.。]+$/, "");
  const corte = limpio.lastIndexOf(" ");
  const Etq = nivel === 1 ? "h1" : "h2";
  return (
    <Etq className={clases("nx-titular", `nx-titular--${tamano}`, className)} {...resto}>
      {corte > 0 ? (
        <>
          {limpio.slice(0, corte + 1)}
          <span className="nx-titular__clave">{limpio.slice(corte + 1)}</span>
        </>
      ) : (
        limpio
      )}
      <span className="nx-titular__clave">.</span>
    </Etq>
  );
}
