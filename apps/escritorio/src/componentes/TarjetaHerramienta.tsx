import { BloqueCodigo, Icono, LatticeLoader, clases, type NombreIcono } from "@aquiles/ui";
import { useState } from "react";
import { duracion } from "../estado/formato";
import type { Elemento } from "../estado/tipos";
import { BloquesDiff, FilaDiff } from "./VistaDiff";

type Herramienta = Extract<Elemento, { tipo: "herramienta" }>;

const ICONOS: Record<string, NombreIcono> = {
  terminal: "terminal",
  procesos: "terminal",
  leer: "fichero",
  escribir: "lapiz",
  editar: "lapiz",
  buscar_ficheros: "buscar",
  buscar_texto: "buscar",
};

/** Línea compacta (icono, nombre, resumen y estado) que se despliega con la salida o el diff. */
export function TarjetaHerramienta({ h }: { h: Herramienta }) {
  const [elegido, setElegido] = useState<boolean>();
  // Mientras corre con salida en vivo se ve abierta; después manda lo que elija el usuario.
  const abierto = elegido ?? (h.estado === "en-curso" && !!h.salida);
  const diffs = h.diffs ?? [];
  const desplegable = diffs.length > 0 || !!h.salida;

  return (
    <div className={clases("herramienta nx-tarjeta", h.estado === "fallo" && "herramienta--fallo")}>
      <button type="button" className="herramienta__cabecera" aria-expanded={desplegable ? abierto : undefined} disabled={!desplegable} onClick={() => setElegido(!abierto)}>
        <Icono nombre={ICONOS[h.nombre] ?? "herramienta"} tamano={18} className="herramienta__icono" />
        <span className="herramienta__nombre">{h.nombre}</span>
        <span className="herramienta__resumen" title={h.resumen}>
          {h.resumen}
        </span>
        <span className="herramienta__estado">
          {h.estado === "en-curso" ? (
            <>
              <LatticeLoader activo />
              <span className="nx-sr">En curso</span>
            </>
          ) : h.estado === "fallo" ? (
            <span className="herramienta__fallo">
              <Icono nombre="alerta" tamano={14} />
              Error
            </span>
          ) : h.ms !== undefined && h.nombre !== "preguntar" ? (
            duracion(h.ms)
          ) : (
            <>
              <Icono nombre="check" tamano={14} grosor={2.5} />
              <span className="nx-sr">Hecho</span>
            </>
          )}
        </span>
        {desplegable && <Icono nombre="chevron-abajo" tamano={14} className={clases("herramienta__chevron", abierto && "herramienta__chevron--abierto")} />}
      </button>

      {diffs.length > 0 && (
        <div className="diff">
          {diffs.map((d) => (
            <div key={d.ruta}>
              <FilaDiff diff={d} />
              {abierto && <BloquesDiff diff={d} />}
            </div>
          ))}
        </div>
      )}
      {abierto && !diffs.length && h.salida && <BloqueCodigo className="herramienta__salida" codigo={h.salida} />}
    </div>
  );
}
