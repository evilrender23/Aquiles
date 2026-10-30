import type { TareaVisible } from "@aquiles/protocolo";
import { CrystalizedBall, Etiqueta, Icono, Tarjeta, ThoughtLine, clases } from "@aquiles/ui";
import { useState, type ReactNode } from "react";
import { hora } from "../estado/formato";
import type { Conversacion, Elemento } from "../estado/tipos";
import { TextoAsistente } from "./Markdown";
import { TarjetaHerramienta } from "./TarjetaHerramienta";

type Bloque = { tipo: "usuario"; e: Extract<Elemento, { tipo: "usuario" }> } | { tipo: "aquiles"; id: string; hora?: number; elementos: Elemento[] };

/** Agrupa lo que no es del usuario en bloques de Aquiles, cada uno con su cabecera. */
function agrupar(elementos: Elemento[]): Bloque[] {
  const bloques: Bloque[] = [];
  for (const e of elementos) {
    if (e.tipo === "usuario") {
      bloques.push({ tipo: "usuario", e });
      continue;
    }
    const momento = e.tipo === "asistente" ? e.hora : e.tipo === "herramienta" ? e.inicio : undefined;
    const ultimo = bloques.at(-1);
    if (ultimo?.tipo === "aquiles") {
      ultimo.elementos.push(e);
      ultimo.hora ??= momento;
    } else bloques.push({ tipo: "aquiles", id: e.id, hora: momento, elementos: [e] });
  }
  return bloques;
}

export function Hilo({ conversacion, trabajando, despues }: { conversacion: Conversacion; trabajando: boolean; despues?: ReactNode }) {
  const bloques = agrupar(conversacion.elementos);
  const pensando = trabajando && conversacion.pensandoDesde !== undefined;
  // El turno vivo necesita un bloque de Aquiles al final aunque aún no haya llegado nada.
  if (pensando && bloques.at(-1)?.tipo !== "aquiles") bloques.push({ tipo: "aquiles", id: "vivo", hora: conversacion.pensandoDesde, elementos: [] });
  const ultimoAquiles = bloques.findLastIndex((b) => b.tipo === "aquiles");

  return (
    <div className="hilo">
      {bloques.map((b, i) =>
        b.tipo === "usuario" ? (
          <article key={b.e.id} className="mensaje-usuario">
            <Etiqueta>{b.e.hora ? `Tú · ${hora(b.e.hora)}` : "Tú"}</Etiqueta>
            <div className="mensaje-usuario__texto">{b.e.texto}</div>
          </article>
        ) : (
          // Clave por posición: el bloque «vivo» pasa a tener elementos sin volver a montarse (ni su orbe).
          // biome-ignore lint/suspicious/noArrayIndexKey: los bloques solo se añaden al final.
          <article key={`aquiles-${i}`} className="bloque-aquiles">
            <div className="bloque-aquiles__cabecera">
              {/* Un solo orbe animado (el del turno más reciente): cada uno abre un contexto WebGL. */}
              <CrystalizedBall tamano={40} ocupado={trabajando && i === ultimoAquiles} estatico={i !== ultimoAquiles} />
              <Etiqueta>{b.hora ? `Aquiles · ${hora(b.hora)}` : "Aquiles"}</Etiqueta>
            </div>
            {b.elementos.map((e) => (
              <ElementoAquiles key={e.id} e={e} />
            ))}
            {pensando && i === ultimoAquiles && <ThoughtLine trabajando desde={conversacion.pensandoDesde} />}
          </article>
        ),
      )}
      {despues}
    </div>
  );
}

function ElementoAquiles({ e }: { e: Elemento }) {
  switch (e.tipo) {
    case "asistente":
      return <TextoAsistente texto={e.texto} abierto={e.abierto} />;
    case "herramienta":
      return <TarjetaHerramienta h={e} />;
    case "pensamiento":
      return <ThoughtLine trabajando={false} ms={e.ms} />;
    case "tareas":
      return <ListaTareas tareas={e.tareas} />;
    case "resumen":
      return <Resumen texto={e.texto} />;
    case "aviso":
      return e.nivel === "error" ? (
        <Tarjeta variante="punteada" className="aviso aviso--error" role="alert">
          <Icono nombre="alerta" tamano={18} />
          <span>{e.texto}</span>
        </Tarjeta>
      ) : (
        <p className="aviso">
          <i className="aviso__punto" aria-hidden="true" />
          {e.texto}
        </p>
      );
    case "usuario":
      return null;
  }
}

function ListaTareas({ tareas }: { tareas: TareaVisible[] }) {
  return (
    <Tarjeta className="tareas" relleno="18px 20px">
      <Etiqueta>Tareas</Etiqueta>
      <ul className="tareas__lista">
        {tareas.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: la lista llega entera en cada evento.
          <li key={i} className={clases("tarea", `tarea--${t.estado}`)}>
            <span className="tarea__marca" aria-hidden="true">
              {t.estado === "hecha" ? (
                <Icono nombre="check" tamano={14} grosor={2.5} />
              ) : t.estado === "en-curso" ? (
                <i className="nx-punto nx-pulso" />
              ) : (
                <Icono nombre="circulo" tamano={14} />
              )}
            </span>
            <span>{t.texto}</span>
            <span className="nx-sr">{t.estado === "hecha" ? "(hecha)" : t.estado === "en-curso" ? "(en curso)" : "(pendiente)"}</span>
          </li>
        ))}
      </ul>
    </Tarjeta>
  );
}

/** Resumen que dejó una compactación del contexto (en el historial). */
function Resumen({ texto }: { texto: string }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <div className="resumen">
      <button type="button" className="resumen__boton" aria-expanded={abierto} onClick={() => setAbierto(!abierto)}>
        Resumen del contexto
        <Icono nombre="chevron-abajo" tamano={14} className={clases("herramienta__chevron", abierto && "herramienta__chevron--abierto")} />
      </button>
      {abierto && <p className="resumen__texto">{texto}</p>}
    </div>
  );
}
