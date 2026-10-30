/**
 * LatticeLoader y ThoughtLine (React Bits), tal como los combina el lienzo de Aquiles · NOX:
 * una cuadrícula 4×4 que barre en diagonal mientras piensa y queda en lima al terminar,
 * con la etiqueta «Pensando…» / «Pensó durante», un cronómetro y, si los hay, los pasos.
 */
import { type ReactNode, useEffect, useState } from "react";
import { clases } from "../clases";
import { Icono } from "../componentes/Icono";

const CELDAS = Array.from({ length: 16 }, (_, i) => ({ id: `c${i}`, diagonal: Math.floor(i / 4) + (i % 4) }));

export function LatticeLoader({ activo }: { activo: boolean }) {
  return (
    <span aria-hidden="true" className={clases("nx-lattice", activo && "nx-lattice--activa")}>
      {CELDAS.map((c) => (
        // Retardos negativos: el barrido ya está en marcha al aparecer, sin un primer instante con una celda suelta.
        <i key={c.id} style={activo ? { animationDelay: `${c.diagonal * 90 - 900}ms` } : undefined} />
      ))}
    </span>
  );
}

const segundos = (ms: number) => `${(ms / 1000).toFixed(1).replace(".", ",")} s`;

export interface PropsThoughtLine {
  /** Mientras piensa, el cronómetro cuenta desde `desde` (Date.now()). */
  trabajando: boolean;
  desde?: number;
  /** Duración final cuando ya no trabaja; sin ella (del historial), no se enseña tiempo. */
  ms?: number;
  pasos?: string[];
  /** El razonamiento: con él, la línea se puede desplegar para leerlo (también mientras llega). */
  detalle?: ReactNode;
}

export function ThoughtLine({ trabajando, desde, ms, pasos = [], detalle }: PropsThoughtLine) {
  const [ahora, setAhora] = useState(() => Date.now());
  // Los pasos se ven mientras trabaja; el razonamiento, solo si se pide.
  const [abierto, setAbierto] = useState(trabajando && !detalle && pasos.length > 0);

  useEffect(() => {
    if (!trabajando) return;
    const t = setInterval(() => setAhora(Date.now()), 100);
    return () => clearInterval(t);
  }, [trabajando]);

  const transcurrido = trabajando && desde !== undefined ? Math.max(0, ahora - desde) : (ms ?? 0);
  const conTiempo = trabajando || ms !== undefined;
  const conPasos = pasos.length > 0;
  const desplegable = conPasos || !!detalle;
  const suave = (visible: boolean) => ({ opacity: visible ? 1 : 0, filter: visible ? "blur(0)" : "blur(2px)" });
  const contenido = (
    <>
      <LatticeLoader activo={trabajando} />
      <span aria-hidden="true" className="nx-pensamiento__etiquetas">
        <span style={suave(trabajando)}>
          <span className={trabajando ? "nx-shim" : undefined}>Pensando…</span>
        </span>
        <span style={{ ...suave(!trabajando), opacity: trabajando ? 0 : 0.75 }}>{conTiempo ? "Pensó durante" : "Pensamiento"}</span>
      </span>
      {conTiempo && (
        <span aria-hidden="true" className="nx-pensamiento__tiempo">
          {segundos(transcurrido)}
        </span>
      )}
      {desplegable && (
        <span aria-hidden="true" className="nx-pensamiento__chevron" style={{ transform: abierto ? "rotate(180deg)" : "none" }}>
          <Icono nombre="chevron-abajo" tamano={14} grosor={2.2} />
        </span>
      )}
    </>
  );

  return (
    <div className="nx-pensamiento">
      {desplegable ? (
        <button type="button" className="nx-pensamiento__boton" aria-expanded={abierto} onClick={() => setAbierto((a) => !a)}>
          {contenido}
        </button>
      ) : (
        <div className="nx-pensamiento__boton">{contenido}</div>
      )}
      <span className="nx-sr" role="status">
        {trabajando ? "Pensando…" : conTiempo ? `Pensó durante ${segundos(transcurrido).replace(" s", " segundos")}` : "Pensamiento"}
      </span>
      {detalle && (
        <div className={clases("nx-pensamiento__traza", abierto && "nx-pensamiento__traza--abierta")}>
          <div>
            <div className="nx-pensamiento__detalle">{detalle}</div>
          </div>
        </div>
      )}
      {conPasos && (
        <div className={clases("nx-pensamiento__traza", abierto && "nx-pensamiento__traza--abierta")}>
          <div>
            <div className="nx-pensamiento__pasos">
              {pasos.map((texto, i) => {
                const actual = trabajando && i === pasos.length - 1;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: los pasos solo se añaden al final.
                  <div key={i} className={clases("nx-fold", "nx-pensamiento__paso", actual && "nx-pensamiento__paso--actual")}>
                    <span aria-hidden="true" className="nx-pensamiento__marca">
                      {actual ? <i className="nx-punto nx-pulso" /> : <Icono nombre="check" tamano={14} grosor={2.5} />}
                    </span>
                    <span>{texto}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
