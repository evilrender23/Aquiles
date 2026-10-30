import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { clases } from "../clases";
import { Icono } from "./Icono";

export interface PropsCampo extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  etiqueta: string;
  /** Botón o texto al final de la caja (p. ej. «Elegir»). */
  sufijo?: ReactNode;
  mono?: boolean;
  error?: string;
}

export function Campo({ etiqueta, sufijo, mono, error, className, id, ...resto }: PropsCampo) {
  const propio = useId();
  const idCampo = id ?? propio;
  return (
    <div className={clases("nx-campo", mono && "nx-campo--mono", className)}>
      <label htmlFor={idCampo} className="nx-etiqueta">
        {etiqueta}
      </label>
      <div className="nx-campo__caja">
        <input id={idCampo} className="nx-campo__entrada" aria-invalid={error ? true : undefined} {...resto} />
        {sufijo}
      </div>
      {error && <span className="nx-campo__error">{error}</span>}
    </div>
  );
}

export interface OpcionSelector {
  valor: string;
  texto: string;
  deshabilitada?: boolean;
}

export interface PropsSelector extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  etiqueta: string;
  opciones: OpcionSelector[];
  valor: string;
  alCambiar: (valor: string) => void;
  mono?: boolean;
}

export function Selector({ etiqueta, opciones, valor, alCambiar, mono, className, id, ...resto }: PropsSelector) {
  const propio = useId();
  const idCampo = id ?? propio;
  return (
    <div className={clases("nx-campo", mono && "nx-campo--mono", className)}>
      <label htmlFor={idCampo} className="nx-etiqueta">
        {etiqueta}
      </label>
      <div className="nx-campo__caja">
        <select id={idCampo} className="nx-campo__entrada" value={valor} onChange={(e) => alCambiar(e.target.value)} {...resto}>
          {opciones.map((o) => (
            <option key={o.valor} value={o.valor} disabled={o.deshabilitada}>
              {o.texto}
            </option>
          ))}
        </select>
        <Icono nombre="chevron-abajo" tamano={16} className="nx-campo__chevron" />
      </div>
    </div>
  );
}
