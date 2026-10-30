import type { InputHTMLAttributes } from "react";
import { clases } from "../clases";
import { BotonIcono } from "./Boton";
import { Icono } from "./Icono";

export interface PropsCampoBusqueda extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "value" | "onChange" | "type"> {
  /** Nombre accesible del campo. */
  etiqueta: string;
  valor: string;
  alCambiar: (valor: string) => void;
  tamano?: "normal" | "pequeno";
}

/** Buscador en píldora con lupa (lienzo, Habilidades). Escape o el aspa lo vacían. */
export function CampoBusqueda({ etiqueta, valor, alCambiar, tamano = "normal", className, onKeyDown, ...resto }: PropsCampoBusqueda) {
  return (
    <div className={clases("nx-busqueda", tamano === "pequeno" && "nx-busqueda--pequeno", className)}>
      <Icono nombre="buscar" tamano={tamano === "pequeno" ? 16 : 18} className="nx-busqueda__lupa" />
      <input
        type="search"
        aria-label={etiqueta}
        className="nx-busqueda__entrada"
        spellCheck={false}
        autoComplete="off"
        value={valor}
        onChange={(e) => alCambiar(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.key === "Escape" && valor) {
            e.preventDefault();
            alCambiar("");
          }
        }}
        {...resto}
      />
      {valor && <BotonIcono variante="pequeno" etiqueta="Vaciar" icono="cerrar" tamanoIcono={14} className="nx-busqueda__vaciar" onClick={() => alCambiar("")} />}
    </div>
  );
}
