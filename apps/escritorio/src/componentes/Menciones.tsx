import { clases, Icono } from "@aquiles/ui";
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";

/** `@` al principio o tras un espacio, hasta el cursor: lo que se está escribiendo como mención. */
const EN_CURSO = /(?:^|\s)@([^\s"@]*)$/;

/**
 * Menciones de ficheros con `@` en una caja de texto: al escribir `@` se buscan ficheros de la carpeta de trabajo y
 * elegir uno lo deja como `@ruta` (o `@"ruta"` si lleva espacios). El núcleo convierte cada mención en un adjunto.
 */
export function useMenciones(
  caja: RefObject<HTMLTextAreaElement | null>,
  texto: string,
  setTexto: (t: string) => void,
  buscar?: (consulta: string) => Promise<string[]>,
) {
  const [consulta, setConsulta] = useState<{ q: string; inicio: number }>();
  const [sugerencias, setSugerencias] = useState<string[]>([]);
  const [activa, setActiva] = useState(0);
  // La que se cerró con Escape no se vuelve a abrir mientras se siga escribiendo en ella.
  const [descartada, setDescartada] = useState<number>();
  const id = useId();
  // La función de búsqueda cambia de identidad con cada render de quien la pasa: la espera no debe reiniciarse por eso.
  const buscarActual = useRef(buscar);
  buscarActual.current = buscar;
  const hayBusqueda = !!buscar;

  /** Tras cada cambio o movimiento del cursor: ¿hay una mención a medio escribir justo antes? */
  const detectar = useCallback(() => {
    const c = caja.current;
    const m = c && hayBusqueda ? EN_CURSO.exec(c.value.slice(0, c.selectionStart)) : null;
    const inicio = m ? (c?.selectionStart ?? 0) - (m[1] ?? "").length - 1 : -1;
    const q = m?.[1] ?? "";
    // Mismo objeto si no cambia: así la búsqueda no se repite al mover el cursor sin escribir.
    setConsulta((previa) => (!m || inicio === descartada ? undefined : previa?.q === q && previa.inicio === inicio ? previa : { q, inicio }));
  }, [caja, hayBusqueda, descartada]);

  useEffect(() => {
    const f = buscarActual.current;
    if (!consulta || !f) {
      setSugerencias([]);
      return;
    }
    let vigente = true;
    const espera = setTimeout(() => {
      f(consulta.q).then(
        (lista) => {
          if (!vigente) return;
          setSugerencias(lista);
          setActiva(0);
        },
        () => vigente && setSugerencias([]),
      );
    }, 80);
    return () => {
      vigente = false;
      clearTimeout(espera);
    };
  }, [consulta]);

  const abierta = !!consulta && sugerencias.length > 0;

  const cerrar = () => {
    setDescartada(consulta?.inicio);
    setConsulta(undefined);
    setSugerencias([]);
  };

  const elegir = (ruta: string) => {
    const c = caja.current;
    if (!c || !consulta) return;
    const mencion = /\s/.test(ruta) ? `@"${ruta}" ` : `@${ruta} `;
    setTexto(texto.slice(0, consulta.inicio) + mencion + texto.slice(c.selectionStart));
    setConsulta(undefined);
    setSugerencias([]);
    const cursor = consulta.inicio + mencion.length;
    requestAnimationFrame(() => {
      c.focus();
      c.setSelectionRange(cursor, cursor);
    });
  };

  /** Las teclas de la lista (flechas, Enter o Tab para elegir, Escape para cerrarla). true si era para ella. */
  const alTecla = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!abierta) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const paso = e.key === "ArrowDown" ? 1 : -1;
      setActiva((a) => (a + paso + sugerencias.length) % sugerencias.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      const ruta = sugerencias[activa];
      if (ruta) elegir(ruta);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cerrar();
      return true;
    }
    return false;
  };

  /** Atributos ARIA para la caja: es un combobox cuya lista son los ficheros. */
  const aria = {
    "aria-autocomplete": "list" as const,
    "aria-expanded": abierta,
    ...(abierta ? { "aria-controls": id, "aria-activedescendant": `${id}-${activa}` } : {}),
  };

  const lista = abierta ? (
    <div id={id} role="listbox" aria-label="Ficheros" className="menciones">
      {sugerencias.map((ruta, i) => {
        const corte = ruta.lastIndexOf("/");
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: el teclado se maneja desde la caja (aria-activedescendant).
          <div
            key={ruta}
            id={`${id}-${i}`}
            tabIndex={-1}
            role="option"
            aria-selected={i === activa}
            className={clases("menciones__opcion", i === activa && "menciones__opcion--activa")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => elegir(ruta)}
            onMouseEnter={() => setActiva(i)}
          >
            <Icono nombre="fichero" tamano={14} />
            <span className="menciones__nombre">{ruta.slice(corte + 1)}</span>
            {corte > 0 && <span className="menciones__carpeta">{ruta.slice(0, corte)}</span>}
          </div>
        );
      })}
    </div>
  ) : null;

  return { detectar, alTecla, aria, lista };
}
