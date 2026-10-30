/**
 * Visor de documentos en el panel de artefactos: un .md (Vista con el Markdown de la app y Código con el texto) o un
 * .docx (Vista con el HTML de `documentos.leer` en la vista aislada), de solo lectura.
 *
 * Se abre con «Ver» (tarjetas de herramienta y adjuntos) y solo cuando el agente escribe un documento: con
 * `herramienta.inicio` ya llega el markdown, que se enseña antes de que exista el fichero (también mientras se espera el
 * permiso); con `herramienta.fin` se lee el fichero de verdad.
 */
import type { Resultados } from "@aquiles/protocolo";
import { BotonIcono, LatticeLoader, Pestanas, copiarTexto, idPestana, useMenuContextual } from "@aquiles/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAcciones } from "../estado/almacen";
import { claseDocumento, nombreDeRuta, nombreWord, paginaDocumento, rutaAbsoluta } from "../estado/artefactos";
import { mostrarFichero, puedeMostrarRutas } from "../plataforma/aplicacion";
import { CodigoConLineas, EstadoGuardado, MarcoPanel, mensaje, PANEL, type PestanaArtefacto, useGuardado, VistaAislada } from "./Artefactos";
import { Markdown } from "./Markdown";
import "./VisorDocumento.css";

export interface DocumentoAbierto {
  /** Absoluta. */
  ruta: string;
  /** El que se enseña, si no es el del fichero (un adjunto se guarda como `<id>-<nombre>`). */
  nombre?: string;
  /** Sube cada vez que hay que volver a leer el fichero. */
  n: number;
  pestana: PestanaArtefacto;
  /** El usuario eligió pestaña: ya no se cambia sola. */
  manual: boolean;
  /** Lo está escribiendo el agente: su herramienta, el markdown de sus argumentos (si lo trae) y, si falló, por qué. */
  escribiendo?: { id: string; markdown?: string; fallo?: string };
}

/** Herramientas que escriben un documento; `editar` no trae el texto entero, así que con ella se lee el fichero. */
const ESCRIBEN = new Set(["escribir_documento", "escribir", "editar"]);

/**
 * El documento del panel. Se abre solo cuando el agente escribe un .md o un .docx en esta sesión (en el turno en curso:
 * los eventos llegan en vivo, no del historial) y respeta la pestaña si el usuario ya la tocó. `alAbrir` cierra lo que
 * enseñara el panel antes (un artefacto).
 */
export function usePanelDocumento(sesionId: string, cwd: string | undefined, alAbrir: () => void) {
  const { alEvento } = useAcciones();
  const [documento, setDocumento] = useState<DocumentoAbierto>();
  const actual = useRef({ cwd, alAbrir });
  actual.current = { cwd, alAbrir };

  useEffect(
    () =>
      alEvento((e) => {
        if (e.tipo === "herramienta.inicio" && e.sesionId === sesionId && ESCRIBEN.has(e.nombre)) {
          const args = (e.argumentos ?? {}) as { ruta?: unknown; contenido?: unknown };
          const { cwd } = actual.current;
          if (typeof args.ruta !== "string" || !cwd) return;
          const ruta = rutaAbsoluta(cwd, args.ruta);
          if (!claseDocumento(ruta)) return;
          const markdown = e.nombre !== "editar" && typeof args.contenido === "string" ? args.contenido : undefined;
          actual.current.alAbrir();
          setDocumento((d) => {
            const mismo = d?.ruta === ruta && d.manual;
            return {
              ruta,
              n: (d?.n ?? 0) + 1,
              pestana: mismo ? d.pestana : "vista",
              manual: mismo,
              escribiendo: { id: e.id, ...(markdown !== undefined ? { markdown } : {}) },
            };
          });
        } else if (e.tipo === "herramienta.fin" && e.sesionId === sesionId) {
          setDocumento((d) => {
            if (!d?.escribiendo || d.escribiendo.id !== e.id) return d;
            // Escrito: se lee el fichero. Si falló, se queda lo que iba a escribir, con el motivo.
            return e.error ? { ...d, escribiendo: { ...d.escribiendo, fallo: e.resultado } } : { ...d, n: d.n + 1, escribiendo: undefined };
          });
        }
      }),
    [alEvento, sesionId],
  );

  const abrir = useCallback((ruta: string, nombre?: string) => {
    actual.current.alAbrir();
    setDocumento((d) => ({ ruta, ...(nombre ? { nombre } : {}), n: (d?.n ?? 0) + 1, pestana: "vista", manual: false }));
  }, []);
  const cerrar = useCallback(() => setDocumento(undefined), []);
  const elegirPestana = useCallback((pestana: PestanaArtefacto) => setDocumento((d) => d && { ...d, pestana, manual: true }), []);
  // Tras un fallo al escribir, recargar deja lo que no se llegó a escribir y enseña el fichero.
  const recargar = useCallback(() => setDocumento((d) => d && { ...d, n: d.n + 1, escribiendo: undefined }), []);
  return { documento, abrir, cerrar, elegirPestana, recargar };
}

type Leido = Resultados["documentos.leer"];

/** Primera frase del motivo de un fallo (el resultado de la herramienta va dirigido al modelo). */
const motivoCorto = (t: string) => (/^[^\n]*?[.!?](?=\s|$)/.exec(t)?.[0] ?? t.split("\n")[0] ?? t).slice(0, 240);

export function PanelDocumento({
  sesionId,
  documento,
  alPestana,
  alRecargar,
  alCerrar,
}: {
  sesionId: string;
  documento: DocumentoAbierto;
  alPestana: (p: PestanaArtefacto) => void;
  alRecargar: () => void;
  alCerrar: () => void;
}) {
  const { llamar } = useAcciones();
  const { ruta, n, escribiendo } = documento;
  const clase = claseDocumento(ruta) ?? "markdown";
  const previo = escribiendo?.markdown;
  const [leido, setLeido] = useState<{ doc?: Leido; error?: string }>();
  const { guardado, guardar, olvidar } = useGuardado(sesionId);
  const [copiado, setCopiado] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `n` es el disparador de volver a leer.
  useEffect(() => {
    if (previo !== undefined) return;
    let vivo = true;
    setLeido(undefined);
    llamar("documentos.leer", { ruta }).then(
      (doc) => vivo && setLeido({ doc }),
      (e: unknown) => vivo && setLeido({ error: mensaje(e) }),
    );
    return () => {
      vivo = false;
    };
  }, [llamar, ruta, n, previo]);
  useEffect(() => {
    if (!copiado) return;
    const t = setTimeout(() => setCopiado(false), 1400);
    return () => clearTimeout(t);
  }, [copiado]);

  // Mientras el agente lo escribe, su markdown (también el de un .docx, que sale de él); después, el fichero.
  const contenido: { formato: Leido["formato"]; texto: string } | undefined =
    previo !== undefined ? { formato: "markdown", texto: previo } : leido?.doc ? { formato: leido.doc.formato, texto: leido.doc.contenido } : undefined;
  const nombre = documento.nombre ?? leido?.doc?.nombre ?? nombreDeRuta(ruta);
  const markdown = contenido?.formato === "markdown" ? contenido.texto : undefined;
  const conPestanas = clase === "markdown";
  const activa: PestanaArtefacto = conPestanas ? documento.pestana : "vista";
  const enDisco = !escribiendo;
  const recargable = enDisco || !!escribiendo?.fallo;
  const word = clase === "markdown" && enDisco && markdown !== undefined;

  const copiar = () => {
    if (markdown === undefined) return;
    copiarTexto(markdown);
    setCopiado(true);
  };
  const comoWord = () => markdown !== undefined && void guardar({ tipo: "word", nombre: nombreWord(nombre), contenido: markdown });

  const menu = useMenuContextual(({ seleccion }) => [
    seleccion.trim() && { texto: "Copiar", icono: "copiar", atajo: "Ctrl+C", alElegir: () => copiarTexto(seleccion) },
    seleccion.trim() && { tipo: "separador" },
    markdown !== undefined && { texto: seleccion.trim() ? "Copiar todo" : "Copiar", icono: "copiar", alElegir: copiar },
    recargable && { texto: "Recargar", icono: "recargar", alElegir: alRecargar },
    word && { texto: "Guardar como Word", icono: "documento", deshabilitado: guardado?.tipo === "guardando", alElegir: comoWord },
    { texto: "Copiar ruta", icono: "copiar", alElegir: () => copiarTexto(ruta) },
    enDisco && puedeMostrarRutas() && { texto: "Mostrar fichero", icono: "carpeta", alElegir: () => void mostrarFichero(ruta) },
    { tipo: "separador" },
    { texto: "Cerrar", icono: "cerrar", alElegir: alCerrar },
  ]);

  return (
    <MarcoPanel
      titulo={nombre}
      ayuda={ruta}
      icono="documento"
      menu={menu}
      alCerrar={alCerrar}
      cabecera={
        escribiendo &&
        !escribiendo.fallo && (
          <span className="visor-documento__escribiendo">
            <i className="nx-punto nx-pulso" aria-hidden="true" />
            Escribiendo
          </span>
        )
      }
    >
      <div className="panel-artefacto__barra">
        {conPestanas ? (
          <Pestanas
            etiqueta="Documento"
            className="panel-artefacto__pestanas"
            pestanas={[
              { id: "codigo", texto: "Código" },
              { id: "vista", texto: "Vista" },
            ]}
            activa={activa}
            alElegir={alPestana}
            idPanel={PANEL}
          />
        ) : (
          <span className="panel-artefacto__lenguaje">docx</span>
        )}
        <span className="panel-artefacto__acciones">
          {markdown !== undefined && <BotonIcono etiqueta={copiado ? "Copiado" : "Copiar"} icono={copiado ? "check" : "copiar"} onClick={copiar} />}
          {recargable && <BotonIcono etiqueta="Recargar" icono="recargar" onClick={alRecargar} />}
          {word && <BotonIcono etiqueta="Guardar como Word" icono="documento" disabled={guardado?.tipo === "guardando"} onClick={comoWord} />}
          {enDisco && puedeMostrarRutas() && <BotonIcono etiqueta="Mostrar fichero" icono="carpeta" onClick={() => void mostrarFichero(ruta)} />}
        </span>
      </div>
      {escribiendo?.fallo && (
        <p className="panel-artefacto__aviso panel-artefacto__aviso--error" role="alert" title={escribiendo.fallo}>
          No se ha escrito: {motivoCorto(escribiendo.fallo)}
        </p>
      )}
      <EstadoGuardado guardado={guardado} alGuardar={(d, s) => void guardar(d, s)} alCancelar={olvidar} />
      <div className="panel-artefacto__cuerpo" {...(conPestanas ? { role: "tabpanel", id: PANEL, "aria-labelledby": idPestana(PANEL, activa) } : {})}>
        {leido?.error && !contenido ? (
          <p className="panel-artefacto__aviso panel-artefacto__aviso--error" role="alert">
            {leido.error}
          </p>
        ) : !contenido ? (
          <div className="panel-artefacto__espera">
            <LatticeLoader activo />
          </div>
        ) : contenido.formato === "html" ? (
          <VistaAislada tipo="html" contenido={paginaDocumento(contenido.texto, nombre)} titulo={nombre} />
        ) : activa === "codigo" ? (
          <CodigoConLineas texto={contenido.texto} seguir={false} />
        ) : (
          <div className="panel-artefacto__md">
            <Markdown texto={contenido.texto} />
          </div>
        )}
      </div>
    </MarcoPanel>
  );
}
