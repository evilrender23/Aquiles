/** Pestañas Propuestas y Aprendido de Memoria (fase 4: lo que aprende Aquiles y de dónde sale). */
import type { EntradaAprendizaje, OrigenAprendizaje, Propuesta } from "@aquiles/protocolo";
import { BloqueCodigo, Boton, ConMenuContextual, Etiqueta, Tarjeta, useMenuContextual } from "@aquiles/ui";
import { useMemo, useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { ORIGENES, tipoAprendizaje } from "../estado/aprendizaje";
import { type Carga, useCarga } from "../estado/carga";
import { calcularDiff } from "../estado/diff";
import { fechaCompleta, fechaConHora, fechaRelativa } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import { BloquesDiff, FilaDiff } from "./VistaDiff";

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** «Revisión · Título de la sesión», con el título como enlace si la sesión sigue existiendo. */
export function Origen({ origen }: { origen: OrigenAprendizaje }) {
  const { sesiones } = useEstado();
  const { abrirSesion } = useAcciones();
  const sesion = origen.sesionId ? sesiones[origen.sesionId] : undefined;
  const titulo = sesion?.titulo ?? origen.titulo;
  return (
    <span className="origen">
      {ORIGENES[origen.tipo]}
      {sesion ? (
        <>
          {" · "}
          <button type="button" className="origen__enlace" onClick={() => abrirSesion(sesion.sesionId)}>
            {titulo || "Sin título"}
          </button>
        </>
      ) : (
        titulo && ` · ${titulo}`
      )}
    </span>
  );
}

export function PanelPropuestas({ propuestas }: { propuestas: Carga<Propuesta[]> }) {
  const ahora = useReloj(60_000);
  if (propuestas.error) {
    return (
      <p className="memoria__error" role="alert">
        {propuestas.error}
      </p>
    );
  }
  if (!propuestas.datos) return null;
  if (propuestas.datos.length === 0) return <p className="memoria__vacio">Sin propuestas</p>;
  return (
    <div className="propuestas">
      {propuestas.datos.map((p) => (
        <TarjetaPropuesta
          key={p.id}
          p={p}
          ahora={ahora}
          // Decidida: sale de la lista; si sigue pendiente (falló al aplicarse), se queda con su error.
          alDecidir={(r) => propuestas.fijar((l) => (r.estado === "pendiente" ? l.map((x) => (x.id === r.id ? r : x)) : l.filter((x) => x.id !== r.id)))}
        />
      ))}
    </div>
  );
}

function TarjetaPropuesta({ p, ahora, alDecidir }: { p: Propuesta; ahora: number; alDecidir: (p: Propuesta) => void }) {
  const { decidirPropuesta, abrirSesion } = useAcciones();
  const { sesiones } = useEstado();
  const [enviando, setEnviando] = useState<"aceptar" | "descartar">();
  const [error, setError] = useState<string>();
  const fallo = error ?? p.error;

  const decidir = async (decision: "aceptar" | "descartar") => {
    setEnviando(decision);
    try {
      alDecidir(await decidirPropuesta(p.id, decision));
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setEnviando(undefined);
    }
  };

  const menu = useMenuContextual(() => [
    { texto: "Aceptar", icono: "check", deshabilitado: !!enviando, alElegir: () => void decidir("aceptar") },
    { texto: "Descartar", icono: "cerrar", deshabilitado: !!enviando, alElegir: () => void decidir("descartar") },
    { tipo: "separador" },
    p.origen.sesionId && sesiones[p.origen.sesionId] && { texto: "Abrir sesión de origen", icono: "flecha-diagonal", alElegir: () => abrirSesion(p.origen.sesionId!) },
  ]);

  return (
    <Tarjeta como="article" className="propuesta" {...menu}>
      <div className="propuesta__cabecera">
        <Etiqueta>{tipoAprendizaje(p)}</Etiqueta>
        <span className="propuesta__meta">
          <time dateTime={p.fecha} title={fechaCompleta(p.fecha)}>
            {fechaRelativa(p.fecha, ahora)}
          </time>
          {" · "}
          <Origen origen={p.origen} />
        </span>
      </div>
      <h3 className="propuesta__resumen">{p.resumen}</h3>
      {p.tipo === "memoria" ? <CambiosMemoria anadidas={p.anadidas ?? []} quitadas={p.quitadas ?? []} /> : <CambiosSkill p={p} />}
      {fallo && (
        <p className="propuesta__error" role="alert">
          {fallo}
        </p>
      )}
      <div className="propuesta__botones">
        <Boton variante="acento" tamano="pequeno" disabled={!!enviando} onClick={() => void decidir("aceptar")}>
          Aceptar
        </Boton>
        <Boton variante="fantasma" tamano="pequeno" disabled={!!enviando} onClick={() => void decidir("descartar")}>
          Descartar
        </Boton>
      </div>
    </Tarjeta>
  );
}

/** Entradas que entran (+) y salen (−), con los colores del diff. */
function CambiosMemoria({ anadidas, quitadas }: { anadidas: string[]; quitadas: string[] }) {
  if (!anadidas.length && !quitadas.length) return null;
  return (
    <ul className="cambios-memoria">
      {quitadas.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: la propuesta llega entera y no cambia.
        <li key={`-${i}`} className="cambio cambio--menos">
          <span className="cambio__signo" aria-hidden="true">
            −
          </span>
          <span className="nx-sr">Sale:</span>
          <span className="cambio__texto">{t}</span>
        </li>
      ))}
      {anadidas.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: la propuesta llega entera y no cambia.
        <li key={`+${i}`} className="cambio cambio--mas">
          <span className="cambio__signo" aria-hidden="true">
            +
          </span>
          <span className="nx-sr">Entra:</span>
          <span className="cambio__texto">{t}</span>
        </li>
      ))}
    </ul>
  );
}

/** Cada fichero: diff de antes a después, o el contenido entero si es nuevo. */
function CambiosSkill({ p }: { p: Propuesta }) {
  const ficheros = useMemo(
    () =>
      (p.ficheros ?? []).map((f) => ({
        ...f,
        diff: calcularDiff(f.ruta, p.nueva ? undefined : f.antes, f.despues),
      })),
    [p.ficheros, p.nueva],
  );
  if (!ficheros.length) return null;
  return (
    <div className="propuesta__ficheros">
      {ficheros.map((f) => (
        <div key={f.ruta} className="diff">
          <FilaDiff diff={f.diff} />
          {f.diff.nuevo ? <BloqueCodigo className="propuesta__nuevo" codigo={f.despues} /> : f.diff.bloques.length > 0 && <BloquesDiff diff={f.diff} />}
        </div>
      ))}
    </div>
  );
}

/** Línea temporal de lo aprendido (aprendizaje.historial), de lo más reciente a lo más antiguo. */
export function PanelAprendido() {
  const { revisiones } = useEstado();
  const { historialAprendizaje } = useAcciones();
  const historial = useCarga("historial", revisiones.aprendizaje, historialAprendizaje);
  const ahora = useReloj(60_000);

  if (historial.error) {
    return (
      <p className="memoria__error" role="alert">
        {historial.error}
      </p>
    );
  }
  if (!historial.datos) return null;
  if (historial.datos.length === 0) return <p className="memoria__vacio">Sin entradas</p>;
  return <LineaAprendido entradas={historial.datos} ahora={ahora} />;
}

/** Lo aprendido como línea temporal, con la fecha, el tipo, el resumen y el origen de cada entrada. */
export function LineaAprendido({ entradas, ahora }: { entradas: EntradaAprendizaje[]; ahora: number }) {
  const { sesiones } = useEstado();
  const { abrirSesion } = useAcciones();
  return (
    <ol className="linea-tiempo">
      {entradas.map((e) => (
        <ConMenuContextual
          key={e.id}
          construir={() => [
            e.origen.sesionId && sesiones[e.origen.sesionId] && { texto: "Abrir sesión de origen", icono: "flecha-diagonal", alElegir: () => abrirSesion(e.origen.sesionId!) },
          ]}
        >
          {(menu) => (
        <li className="linea-tiempo__entrada" {...menu}>
          <time className="linea-tiempo__fecha" dateTime={e.fecha} title={fechaCompleta(e.fecha)}>
            {fechaConHora(e.fecha, ahora)}
          </time>
          <div className="linea-tiempo__cuerpo">
            <Etiqueta>{tipoAprendizaje(e)}</Etiqueta>
            <p className="linea-tiempo__resumen">{e.resumen}</p>
            <span className="linea-tiempo__origen">
              <Origen origen={e.origen} />
            </span>
          </div>
        </li>
          )}
        </ConMenuContextual>
      ))}
    </ol>
  );
}
