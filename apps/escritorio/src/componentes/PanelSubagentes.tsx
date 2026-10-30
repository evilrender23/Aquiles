/** Subagentes de una sesión (herramienta `delegar`): estado, tarea, lo que van escribiendo, y parar, reconducir o abrir. */
import type { MotivoFin } from "@aquiles/protocolo";
import { Boton, BotonIcono, Etiqueta, clases, useMenuContextual } from "@aquiles/ui";
import { useEffect, useRef, useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import type { EstadoApp } from "../estado/tipos";

interface Hijo {
  subId: string;
  nombre: string;
  tarea?: string;
  /** undefined: de una sesión anterior, sin eventos (no se sabe cómo acabó). */
  estado?: "en-curso" | MotivoFin;
  texto?: string;
  error?: string;
}

const ESTADOS: Record<"en-curso" | MotivoFin, string> = { "en-curso": "Trabajando", fin: "Terminado", parado: "Parado", limite: "Límite de pasos", error: "Error" };

/** Hijos de una sesión: los de los eventos y los que lista el núcleo (origen subagente con este padre). */
export function hijosDe(s: EstadoApp, padre: string): Hijo[] {
  const deEventos = Object.values(s.subagentes).filter((x) => x.padre === padre);
  const deLista = Object.values(s.sesiones)
    .filter((x) => x.origen?.tipo === "subagente" && x.origen.padre === padre)
    .sort((a, b) => a.creada.localeCompare(b.creada));
  const ids = [...new Set([...deLista.map((x) => x.sesionId), ...deEventos.map((x) => x.subId)])];
  return ids.map((subId) => {
    const sesion = s.sesiones[subId];
    const ev = s.subagentes[subId];
    const estado = ev?.estado ?? (sesion?.trabajando ? "en-curso" : undefined);
    return {
      subId,
      nombre: sesion?.titulo?.replace(/ · subagente$/, "") || "Subagente",
      ...(ev?.tarea ? { tarea: ev.tarea } : {}),
      ...(estado ? { estado } : {}),
      ...(ev?.texto ? { texto: ev.texto } : {}),
      ...(ev?.error ? { error: ev.error } : {}),
    };
  });
}

export function PanelSubagentes({ sesionId, compacto = false }: { sesionId: string; compacto?: boolean }) {
  const estado = useEstado();
  const hijos = hijosDe(estado, sesionId);
  const enCurso = hijos.filter((h) => h.estado === "en-curso").length;
  const [abierto, setAbierto] = useState(true);
  if (!hijos.length) return null;

  const lista = (
    <div className="subagentes__lista">
      {hijos.map((h) => (
        <TarjetaSubagente key={h.subId} h={h} />
      ))}
    </div>
  );
  if (!compacto) {
    return (
      <section className="subagentes" aria-label="Subagentes">
        <Etiqueta>Subagentes</Etiqueta>
        {lista}
      </section>
    );
  }
  return (
    <section className="subagentes subagentes--compacto" aria-label="Subagentes">
      <button type="button" className="subagentes__plegar" aria-expanded={abierto} onClick={() => setAbierto((a) => !a)}>
        <Etiqueta>{enCurso ? `Subagentes · ${enCurso} / ${hijos.length}` : `Subagentes · ${hijos.length}`}</Etiqueta>
      </button>
      {abierto && lista}
    </section>
  );
}

function TarjetaSubagente({ h }: { h: Hijo }) {
  const { detener, reconducir, abrirSesion } = useAcciones();
  const [reconduciendo, setReconduciendo] = useState(false);
  const [texto, setTexto] = useState("");
  const [error, setError] = useState<string>();
  const entrada = useRef<HTMLInputElement>(null);
  const trabajando = h.estado === "en-curso";

  useEffect(() => {
    if (reconduciendo) entrada.current?.focus();
  }, [reconduciendo]);

  const menu = useMenuContextual(() => [
    trabajando && { texto: "Parar", icono: "detener", alElegir: () => detener(h.subId) },
    trabajando && { texto: "Reconducir…", icono: "enviar", alElegir: () => setReconduciendo(true) },
    { texto: "Abrir", icono: "flecha-diagonal", alElegir: () => abrirSesion(h.subId) },
  ]);

  const enviar = async () => {
    const t = texto.trim();
    if (!t) return;
    try {
      await reconducir(h.subId, t);
      setTexto("");
      setReconduciendo(false);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <article className={clases("subagente", h.estado === "error" && "subagente--error")} {...menu}>
      <div className="subagente__cabecera">
        <span className="subagente__nombre">{h.nombre}</span>
        {h.estado && (
          <span className="subagente__estado">
            {trabajando && <i className="nx-punto nx-pulso" aria-hidden="true" />}
            {ESTADOS[h.estado]}
          </span>
        )}
      </div>
      {h.tarea && (
        <p className="subagente__tarea" title={h.tarea}>
          {h.tarea}
        </p>
      )}
      {h.texto && (
        <p className="subagente__texto" aria-live={trabajando ? "polite" : undefined}>
          {h.texto}
        </p>
      )}
      {(h.error || error) && (
        <p className="subagente__error" role="alert">
          {error ?? h.error}
        </p>
      )}
      {reconduciendo ? (
        <form
          className="subagente__reconducir"
          onSubmit={(e) => {
            e.preventDefault();
            void enviar();
          }}
        >
          <input
            ref={entrada}
            className="subagente__entrada"
            aria-label={`Reconducir a ${h.nombre}`}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setReconduciendo(false)}
          />
          <BotonIcono type="submit" variante="pequeno" etiqueta="Enviar" icono="enviar" disabled={!texto.trim()} />
        </form>
      ) : (
        <div className="subagente__botones">
          {trabajando && (
            <Boton variante="fantasma" tamano="pequeno" icono="detener" onClick={() => detener(h.subId)}>
              Parar
            </Boton>
          )}
          {trabajando && (
            <Boton variante="fantasma" tamano="pequeno" onClick={() => setReconduciendo(true)}>
              Reconducir
            </Boton>
          )}
          <Boton variante="fantasma" tamano="pequeno" iconoFinal="flecha-diagonal" onClick={() => abrirSesion(h.subId)}>
            Abrir
          </Boton>
        </div>
      )}
    </article>
  );
}
