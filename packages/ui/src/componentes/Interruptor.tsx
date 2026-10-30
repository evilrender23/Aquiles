import type { ComponentPropsWithRef } from "react";
import { clases } from "../clases";

export interface PropsInterruptor extends Omit<ComponentPropsWithRef<"button">, "onChange" | "role" | "aria-checked" | "children"> {
  activo: boolean;
  alCambiar: (activo: boolean) => void;
}

/** Interruptor del lienzo (tablero de Automatizaciones): pista lima con la bola oscura cuando está activo. Necesita aria-label o aria-labelledby. */
export function Interruptor({ activo, alCambiar, className, type = "button", ...resto }: PropsInterruptor) {
  return (
    <button type={type} role="switch" aria-checked={activo} className={clases("nx-interruptor", className)} onClick={() => alCambiar(!activo)} {...resto}>
      <span className="nx-interruptor__bola" aria-hidden="true" />
    </button>
  );
}
