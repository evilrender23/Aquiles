/**
 * BranchedMenu (React Bits): árbol plegable cuyas ramas se dibujan al abrir un grupo.
 * La rama del elemento actual va en lima; las demás, en línea fuerte.
 */
import type { ReactNode } from "react";
import { clases } from "../clases";
import { Icono } from "../componentes/Icono";

export interface GrupoRamas<T> {
  id: string;
  etiqueta: string;
  /** Texto completo para el tooltip (p. ej. la ruta). */
  titulo?: string;
  hijos: T[];
}

export interface PropsBranchedMenu<T> {
  etiqueta: string;
  grupos: GrupoRamas<T>[];
  abiertos: ReadonlySet<string>;
  alAlternar: (id: string) => void;
  claveHijo: (hijo: T) => string;
  esActual: (hijo: T) => boolean;
  renderHijo: (hijo: T, actual: boolean) => ReactNode;
}

export function BranchedMenu<T>({ etiqueta, grupos, abiertos, alAlternar, claveHijo, esActual, renderHijo }: PropsBranchedMenu<T>) {
  return (
    <nav aria-label={etiqueta} className="nx-ramas">
      {grupos.map((g) => {
        const abierto = abiertos.has(g.id);
        return (
          <div key={g.id}>
            <button type="button" className="nx-ramas__grupo" aria-expanded={abierto} onClick={() => alAlternar(g.id)} title={g.titulo}>
              <span aria-hidden="true" className={clases("nx-ramas__chevron", abierto && "nx-ramas__chevron--abierto")}>
                <Icono nombre="chevron-derecha" tamano={16} />
              </span>
              <span className="nx-ramas__nombre">{g.etiqueta}</span>
              <span className="nx-ramas__cuenta">{g.hijos.length}</span>
            </button>
            {abierto && (
              <div className="nx-fold">
                {g.hijos.map((h, i) => {
                  const actual = esActual(h);
                  const retraso = { animationDelay: `${i * 90}ms` };
                  return (
                    <div key={claveHijo(h)} className={clases("nx-ramas__hijo", actual && "nx-ramas__hijo--actual")} aria-current={actual ? "page" : undefined}>
                      <svg aria-hidden="true" width="40" height="36" viewBox="0 0 40 36" fill="none" className="nx-ramas__trazo">
                        <path className="nx-rama" d="M14 0V36" stroke={i < g.hijos.length - 1 ? "var(--line-strong)" : "transparent"} strokeWidth="1.5" style={retraso} />
                        <path
                          className="nx-rama"
                          d="M14 -10V8Q14 18 24 18H34"
                          stroke={actual ? "var(--lime)" : "var(--line-strong)"}
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          style={retraso}
                        />
                      </svg>
                      {renderHijo(h, actual)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
