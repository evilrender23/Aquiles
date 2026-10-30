import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { clases } from "../clases";
import { Icono } from "./Icono";

export interface PropsDisparador {
  abierto: boolean;
  alternar: () => void;
  "aria-expanded": boolean;
  "aria-haspopup": "menu";
  "aria-controls": string;
}

export interface PropsDesplegable {
  /** Nombre accesible del menú. */
  etiqueta: string;
  disparador: (p: PropsDisparador) => ReactNode;
  children: (cerrar: () => void) => ReactNode;
  lado?: "arriba" | "abajo";
  alineacion?: "izquierda" | "derecha";
  className?: string;
}

/** Menú anclado a un botón: se cierra con Escape o al pulsar fuera; flechas para moverse entre opciones. */
export function Desplegable({ etiqueta, disparador, children, lado = "arriba", alineacion = "izquierda", className }: PropsDesplegable) {
  const [abierto, setAbierto] = useState(false);
  const caja = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  const cerrar = useCallback(() => setAbierto(false), []);

  useEffect(() => {
    const c = caja.current;
    if (!abierto || !c) return;
    const fuera = (e: PointerEvent) => {
      if (!c.contains(e.target as Node)) setAbierto(false);
    };
    const teclas = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setAbierto(false);
        c.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const opciones = [...(panel.current?.querySelectorAll<HTMLElement>(".nx-opcion:not(:disabled)") ?? [])];
      if (!opciones.length) return;
      e.preventDefault();
      const i = opciones.indexOf(document.activeElement as HTMLElement);
      const siguiente = e.key === "ArrowDown" ? (i + 1) % opciones.length : (i - 1 + opciones.length) % opciones.length;
      opciones[siguiente]?.focus();
    };
    window.addEventListener("pointerdown", fuera);
    c.addEventListener("keydown", teclas);
    const p = panel.current;
    const primero = p?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ?? p?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)");
    primero?.focus();
    return () => {
      window.removeEventListener("pointerdown", fuera);
      c.removeEventListener("keydown", teclas);
    };
  }, [abierto]);

  return (
    <div ref={caja} className={clases("nx-desplegable", className)}>
      {disparador({ abierto, alternar: () => setAbierto((a) => !a), "aria-expanded": abierto, "aria-haspopup": "menu", "aria-controls": id })}
      {abierto && (
        <div
          ref={panel}
          id={id}
          role="menu"
          aria-label={etiqueta}
          className={clases("nx-desplegable__panel", `nx-desplegable__panel--${lado}`, `nx-desplegable__panel--${alineacion}`)}
        >
          {children(cerrar)}
        </div>
      )}
    </div>
  );
}

export interface PropsOpcion {
  texto: ReactNode;
  marcada?: boolean;
  deshabilitada?: boolean;
  alElegir: () => void;
  titulo?: string;
}

export function Opcion({ texto, marcada, deshabilitada, alElegir, titulo }: PropsOpcion) {
  return (
    <button type="button" role="menuitemradio" aria-checked={!!marcada} disabled={deshabilitada} className="nx-opcion" onClick={alElegir} title={titulo}>
      <span className="nx-opcion__texto">{texto}</span>
      {marcada && <Icono nombre="check" tamano={14} grosor={2.5} className="nx-opcion__marca" />}
    </button>
  );
}

export function GrupoOpciones({ titulo, motivo }: { titulo: string; motivo?: string }) {
  return (
    <div className="nx-desplegable__grupo" role="presentation">
      <span className="nx-etiqueta">{titulo}</span>
      {motivo && <span className="nx-desplegable__motivo">{motivo}</span>}
    </div>
  );
}
