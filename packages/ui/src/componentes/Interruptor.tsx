import { useId, type ComponentPropsWithRef } from "react";
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

export interface PropsCampoInterruptor {
  etiqueta: string;
  activo: boolean;
  alCambiar: (activo: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** Fila con el nombre del ajuste a la izquierda y el interruptor a la derecha. */
export function CampoInterruptor({ etiqueta, activo, alCambiar, disabled, className }: PropsCampoInterruptor) {
  const id = useId();
  return (
    <div className={clases("nx-campo-interruptor", className)}>
      <span id={id} className="nx-campo-interruptor__etiqueta">
        {etiqueta}
      </span>
      <Interruptor activo={activo} alCambiar={alCambiar} disabled={disabled} aria-labelledby={id} />
    </div>
  );
}
