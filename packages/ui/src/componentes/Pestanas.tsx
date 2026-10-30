import type { KeyboardEvent, ReactNode } from "react";
import { clases } from "../clases";

export interface Pestana<T extends string> {
  id: T;
  texto: ReactNode;
  titulo?: string;
}

export interface PropsPestanas<T extends string> {
  /** Nombre accesible de la lista de pestañas. */
  etiqueta: string;
  pestanas: Pestana<T>[];
  activa: T;
  alElegir: (id: T) => void;
  /** id del panel (role="tabpanel") que controlan; su aria-labelledby es `idPestana(idPanel, activa)`. */
  idPanel: string;
  className?: string;
}

export const idPestana = (idPanel: string, id: string) => `${idPanel}-${id}`;

/** Pestañas con forma de chip (como los filtros del lienzo). Flechas, Inicio y Fin cambian de pestaña. */
export function Pestanas<T extends string>({ etiqueta, pestanas, activa, alElegir, idPanel, className }: PropsPestanas<T>) {
  const mover = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = pestanas.length;
    const teclas: Record<string, number> = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 };
    const destino = teclas[e.key];
    const p = destino === undefined ? undefined : pestanas[destino];
    if (destino === undefined || !p) return;
    e.preventDefault();
    alElegir(p.id);
    e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[destino]?.focus();
  };
  return (
    <div role="tablist" aria-label={etiqueta} className={clases("nx-pestanas", className)}>
      {pestanas.map((p, i) => {
        const actual = p.id === activa;
        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={idPestana(idPanel, p.id)}
            aria-selected={actual}
            aria-controls={idPanel}
            tabIndex={actual ? 0 : -1}
            title={p.titulo}
            className="nx-chip"
            onClick={() => alElegir(p.id)}
            onKeyDown={(e) => mover(e, i)}
          >
            {p.texto}
          </button>
        );
      })}
    </div>
  );
}
