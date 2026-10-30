import { BloqueCodigo, Icono, LatticeLoader, clases, copiarTexto, type ElementosMenu, type NombreIcono, useMenuContextual } from "@aquiles/ui";
import { useRef, useState } from "react";
import { duracion } from "../estado/formato";
import { mostrarFichero, puedeMostrarRutas } from "../plataforma/aplicacion";
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

/** Herramientas cuyo resumen es la ruta del fichero (el primer trozo, sin espacios). */
const CON_RUTA = new Set(["leer", "escribir", "editar"]);

/** Ruta absoluta: las relativas cuelgan de la carpeta de la sesión. */
function absoluta(cwd: string, ruta: string): string {
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(ruta)) return ruta;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${ruta.replace(/^\.[\\/]/, "")}`;
}

/** «Copiar ruta» o «Mostrar fichero»: una opción con una ruta, un submenú con varias. */
function porRuta(texto: string, icono: NombreIcono, rutas: { ver: string; abs: string }[], f: (abs: string) => unknown): ElementosMenu[number] {
  if (rutas.length === 0) return false;
  const [unica] = rutas;
  if (rutas.length === 1 && unica) return { texto, icono, alElegir: () => f(unica.abs) };
  return { tipo: "submenu", texto, icono, elementos: rutas.map((r) => ({ texto: r.ver, alElegir: () => f(r.abs) })) };
}

/** Línea compacta (icono, nombre, resumen y estado) que se despliega con la salida o el diff. */
export function TarjetaHerramienta({ h, cwd }: { h: Herramienta; cwd: string }) {
  const [elegido, setElegido] = useState<boolean>();
  const tarjeta = useRef<HTMLDivElement>(null);
  // Mientras corre con salida en vivo se ve abierta; después manda lo que elija el usuario.
  const abierto = elegido ?? (h.estado === "en-curso" && !!h.salida);
  const diffs = h.diffs ?? [];
  const desplegable = diffs.length > 0 || !!h.salida;

  const menu = useMenuContextual(() => {
    const deResumen = !diffs.length && CON_RUTA.has(h.nombre) ? h.resumen.trim().split(/\s/)[0] : undefined;
    const rutas = (diffs.length ? diffs.map((d) => d.ruta) : deResumen ? [deResumen] : []).map((r) => ({ ver: r, abs: absoluta(cwd, r) }));
    return [
      h.resumen && { texto: h.nombre === "terminal" ? "Copiar comando" : "Copiar resumen", icono: "copiar", alElegir: () => copiarTexto(h.resumen) },
      h.salida && { texto: "Copiar salida", icono: "copiar", alElegir: () => copiarTexto(h.salida ?? "") },
      porRuta("Copiar ruta", "copiar", rutas, copiarTexto),
      puedeMostrarRutas() && porRuta("Mostrar fichero", "carpeta", rutas, mostrarFichero),
      diffs.length > 0 && { tipo: "separador" },
      diffs.length > 0 && {
        texto: "Ver diff",
        icono: "fichero",
        alElegir: () => {
          setElegido(true);
          requestAnimationFrame(() => tarjeta.current?.scrollIntoView({ block: "nearest" }));
        },
      },
    ];
  });

  return (
    <div ref={tarjeta} className={clases("herramienta nx-tarjeta", h.estado === "fallo" && "herramienta--fallo")} {...menu}>
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
