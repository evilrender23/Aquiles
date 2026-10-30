import { type TareaVisible, textoSinArtefactos } from "@aquiles/protocolo";
import { BotonIcono, CrystalizedBall, Etiqueta, Icono, Tarjeta, ThoughtLine, clases, copiarTexto, type ElementosMenu, useMenuContextual } from "@aquiles/ui";
import { useState, type ReactNode } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { hora } from "../estado/formato";
import type { AdjuntoVisto, Conversacion, Elemento } from "../estado/tipos";
import { AdjuntosMensaje } from "./Adjuntos";
import { TarjetaArtefacto, useArtefactosHilo } from "./Artefactos";
import { Markdown, TextoAsistente } from "./Markdown";
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

export function Hilo({
  sesionId,
  cwd,
  conversacion,
  trabajando,
  despues,
}: {
  sesionId: string;
  cwd: string;
  conversacion: Conversacion;
  trabajando: boolean;
  despues?: ReactNode;
}) {
  const bloques = agrupar(conversacion.elementos);
  const pensando = trabajando && conversacion.pensandoDesde !== undefined;
  // El turno vivo necesita un bloque de Aquiles al final aunque aún no haya llegado nada.
  if (pensando && bloques.at(-1)?.tipo !== "aquiles") bloques.push({ tipo: "aquiles", id: "vivo", hora: conversacion.pensandoDesde, elementos: [] });
  const ultimoAquiles = bloques.findLastIndex((b) => b.tipo === "aquiles");

  return (
    <div className="hilo">
      {bloques.map((b, i) =>
        b.tipo === "usuario" ? (
          <MensajeUsuario key={b.e.id} sesionId={sesionId} texto={b.e.texto} hora={b.e.hora} adjuntos={b.e.adjuntos} />
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
              <ElementoAquiles key={e.id} e={e} cwd={cwd} />
            ))}
            {pensando && i === ultimoAquiles && (
              <ThoughtLine
                trabajando
                desde={conversacion.pensandoDesde}
                detalle={conversacion.pensamientoVivo ? <Markdown texto={conversacion.pensamientoVivo} compacto /> : undefined}
              />
            )}
          </article>
        ),
      )}
      {despues}
    </div>
  );
}

function ElementoAquiles({ e, cwd }: { e: Elemento; cwd: string }) {
  switch (e.tipo) {
    case "asistente":
      return <MensajeAsistente id={e.id} texto={e.texto} abierto={e.abierto} />;
    case "herramienta":
      return <TarjetaHerramienta h={e} cwd={cwd} />;
    case "pensamiento":
      return <ThoughtLine trabajando={false} ms={e.ms} detalle={e.texto ? <Markdown texto={e.texto} compacto /> : undefined} />;
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
    case "aprendizaje":
      return <AvisoAprendizaje e={e} />;
    case "usuario":
      return null;
  }
}

/** «> » delante de cada línea, para citar en la caja. */
const cita = (texto: string) =>
  texto
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

/** Acciones sobre un trozo seleccionado dentro de un mensaje: valen para la selección, no para todo el mensaje. */
function menuSeleccion(seleccion: string, a: { insertarEnCaja: (t: string) => void; leer?: (t: string) => void; buscar: (t: string) => void }): ElementosMenu {
  return [
    { texto: "Copiar", icono: "copiar", atajo: "Ctrl+C", alElegir: () => copiarTexto(seleccion) },
    { texto: "Citar en la caja", icono: "cita", alElegir: () => a.insertarEnCaja(cita(seleccion)) },
    a.leer && { texto: "Leer en voz alta", icono: "altavoz", alElegir: () => a.leer?.(seleccion) },
    { tipo: "separador" },
    { texto: "Buscar en conversaciones", icono: "buscar", alElegir: () => a.buscar(seleccion) },
  ];
}

function MensajeUsuario({ sesionId, texto, hora: h, adjuntos }: { sesionId: string; texto: string; hora?: number; adjuntos?: AdjuntoVisto[] }) {
  const { voz } = useEstado();
  const { enviar, insertarEnCaja, buscarEnConversaciones, llamar } = useAcciones();
  const leer = voz?.lectura ? (t: string) => void llamar("voz.leer", { texto: paraLeer(t) }).catch(() => {}) : undefined;
  const menu = useMenuContextual(({ seleccion }) =>
    seleccion.trim()
      ? menuSeleccion(seleccion, { insertarEnCaja, leer, buscar: buscarEnConversaciones })
      : [
          { texto: "Copiar", icono: "copiar", alElegir: () => copiarTexto(texto) },
          { texto: "Citar en la caja", icono: "cita", alElegir: () => insertarEnCaja(cita(texto)) },
          { texto: "Volver a enviar", icono: "enviar", alElegir: () => void enviar(sesionId, texto) },
          leer && { texto: "Leer en voz alta", icono: "altavoz", alElegir: () => leer(texto) },
        ],
  );
  return (
    <article className="mensaje-usuario" {...menu}>
      <Etiqueta>{h ? `Tú · ${hora(h)}` : "Tú"}</Etiqueta>
      {texto.trim() && <div className="mensaje-usuario__texto">{texto}</div>}
      {adjuntos?.length ? <AdjuntosMensaje sesionId={sesionId} adjuntos={adjuntos} /> : null}
    </article>
  );
}

function MensajeAsistente({ id, texto, abierto }: { id: string; texto: string; abierto: boolean }) {
  const { voz } = useEstado();
  const { insertarEnCaja, buscarEnConversaciones, llamar } = useAcciones();
  const artefactos = useArtefactosHilo();
  const trozos = artefactos?.porElemento.get(id);
  // Citar y leer, sin los artefactos (van aparte, en su panel).
  const prosa = trozos ? textoSinArtefactos(texto) : texto;
  const leer = voz?.lectura ? (t: string) => void llamar("voz.leer", { texto: paraLeer(t) }).catch(() => {}) : undefined;
  const menu = useMenuContextual(({ seleccion, objetivo }) => {
    if (seleccion.trim()) return menuSeleccion(seleccion, { insertarEnCaja, leer, buscar: buscarEnConversaciones });
    // «Copiar» da el texto tal como se ve; «Copiar como Markdown», el original.
    const md = [...(objetivo.closest(".asistente")?.querySelectorAll(".md") ?? [])];
    const visto = md.length ? md.map((x) => x.textContent?.trim() ?? "").join("\n\n") : prosa;
    return [
      { texto: "Copiar", icono: "copiar", alElegir: () => copiarTexto(visto.trim()) },
      { texto: "Copiar como Markdown", alElegir: () => copiarTexto(texto) },
      { texto: "Citar en la caja", icono: "cita", alElegir: () => insertarEnCaja(cita(prosa)) },
      leer && !abierto && { texto: "Leer en voz alta", icono: "altavoz", alElegir: () => leer(prosa) },
    ];
  });
  return (
    <div className="asistente" {...menu}>
      {trozos ? (
        trozos.map((t, i) =>
          t.tipo === "texto" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: los trozos de un mensaje solo crecen por el final.
            <TextoAsistente key={i} texto={t.texto} abierto={abierto && i === trozos.length - 1} />
          ) : (
            <TarjetaArtefacto
              key={t.clave}
              a={t.artefacto}
              version={t.version}
              activa={artefactos?.abierto?.id === t.artefacto.id && artefactos.abierto.version === t.version}
              alAbrir={() => artefactos?.abrir(t.artefacto.id, t.version)}
            />
          ),
        )
      ) : (
        <TextoAsistente texto={texto} abierto={abierto} />
      )}
      {!abierto && prosa.trim() && <BotonLeer texto={prosa} />}
    </div>
  );
}

/** El texto de una respuesta sin la sintaxis de Markdown, para leerlo en voz alta. */
function paraLeer(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
}

/** Altavoz de una respuesta (voz.leer); mientras lee, para (voz.parar). Solo si el núcleo tiene lectura. */
function BotonLeer({ texto }: { texto: string }) {
  const { voz } = useEstado();
  const { llamar } = useAcciones();
  const [leyendo, setLeyendo] = useState(false);
  if (!voz?.lectura) return null;
  const leer = async () => {
    const t = paraLeer(texto);
    if (!t) return;
    setLeyendo(true);
    try {
      await llamar("voz.leer", { texto: t });
    } catch {
      // Si no puede leer (o se paró), el botón vuelve a su estado.
    } finally {
      setLeyendo(false);
    }
  };
  return (
    <BotonIcono
      variante="pequeno"
      className="asistente__leer"
      etiqueta={leyendo ? "Parar la lectura" : "Leer en voz alta"}
      icono={leyendo ? "detener" : "altavoz"}
      tamanoIcono={15}
      onClick={() => (leyendo ? void llamar("voz.parar", {}).catch(() => {}) : void leer())}
    />
  );
}

const plural = (n: number, una: string, varias: string) => `${n} ${n === 1 ? una : varias}`;

/** Revisión de lo aprendido en segundo plano: discreta, como los avisos de compactación o reintento. */
function AvisoAprendizaje({ e }: { e: Extract<Elemento, { tipo: "aprendizaje" }> }) {
  const { abrirMemoria } = useAcciones();
  if (e.estado === "inicio") {
    return (
      <p className="aviso" aria-live="polite">
        <i className="nx-punto nx-pulso" aria-hidden="true" />
        Revisando lo aprendido
      </p>
    );
  }
  if (e.estado === "error") {
    return (
      <p className="aviso" aria-live="polite">
        <i className="aviso__punto" aria-hidden="true" />
        Revisión de lo aprendido: {e.error ?? "error"}
      </p>
    );
  }
  const propuestas = e.propuestas ?? 0;
  const aplicadas = e.aplicadas ?? 0;
  return (
    <p className="aviso" aria-live="polite">
      <i className="aviso__punto" aria-hidden="true" />
      <span>
        Revisión de lo aprendido:{" "}
        {propuestas === 0 && aplicadas === 0 && "sin cambios"}
        {propuestas > 0 && (
          <button type="button" className="aviso__enlace" onClick={() => abrirMemoria("propuestas")}>
            {plural(propuestas, "propuesta", "propuestas")}
          </button>
        )}
        {propuestas > 0 && aplicadas > 0 && " · "}
        {aplicadas > 0 && (
          <button type="button" className="aviso__enlace" onClick={() => abrirMemoria("aprendido")}>
            {plural(aplicadas, "aplicada", "aplicadas")}
          </button>
        )}
      </span>
    </p>
  );
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
