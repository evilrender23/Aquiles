/** Artefactos: la tarjeta en el hilo y el panel lateral (código en vivo, vista aislada, versiones, copiar y guardar). */
import { type Artefacto, codigosError, type TipoArtefacto } from "@aquiles/protocolo";
import {
  Boton,
  BotonIcono,
  Desplegable,
  Icono,
  LatticeLoader,
  Opcion,
  Pestanas,
  clases,
  copiarTexto,
  idPestana,
  type NombreIcono,
  useMenuContextual,
} from "@aquiles/ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useAcciones } from "../estado/almacen";
import { contarLineas, nombreFichero, nombreWord, renderizable, type TrozoHilo } from "../estado/artefactos";
import { mostrarFichero, puedeMostrarRutas } from "../plataforma/aplicacion";
import { ErrorNucleo } from "../rpc";
import { Markdown } from "./Markdown";

export const ICONOS_ARTEFACTO: Record<TipoArtefacto, NombreIcono> = { html: "ventana", svg: "imagen", markdown: "documento", codigo: "codigo" };

export type PestanaArtefacto = "codigo" | "vista";

/** Lo que el hilo necesita para pintar las tarjetas y abrir el panel. */
export interface ContextoArtefactos {
  porElemento: Map<string, TrozoHilo[]>;
  /** El que enseña el panel ahora. */
  abierto?: { id: string; version: number };
  abrir: (id: string, version: number) => void;
  /** Abre un .md o un .docx (ruta absoluta) en el panel, como documento de solo lectura; `nombre`, si no es el del fichero (un adjunto). */
  abrirDocumento: (ruta: string, nombre?: string) => void;
}
export const ArtefactosHilo = createContext<ContextoArtefactos | null>(null);
export const useArtefactosHilo = () => useContext(ArtefactosHilo);

const lineas = (n: number) => (n === 1 ? "1 línea" : `${n} líneas`);

export function TarjetaArtefacto({ a, version, activa, alAbrir }: { a: Artefacto; version: number; activa: boolean; alAbrir: () => void }) {
  return (
    <button type="button" className={clases("tarjeta-artefacto", activa && "tarjeta-artefacto--activa")} aria-pressed={activa} onClick={alAbrir}>
      <Icono nombre={ICONOS_ARTEFACTO[a.tipo]} tamano={18} className="tarjeta-artefacto__icono" />
      <span className="tarjeta-artefacto__titulo">{a.titulo}</span>
      {version > 0 && <span className="tarjeta-artefacto__version">v{version + 1}</span>}
      {!a.completo && (
        <span className="tarjeta-artefacto__escribiendo">
          <i className="nx-punto nx-pulso" aria-hidden="true" />
          {lineas(contarLineas(a.contenido))}
        </span>
      )}
    </button>
  );
}

/* ── Marco del panel (artefactos y documentos) ────── */

const ANCHO_MINIMO = 340;
/** Lo que se deja como mínimo a la conversación al ensanchar el panel. */
const MINIMO_CONVERSACION = 380;
const CLAVE_ANCHO = "aquiles.panel-artefacto.ancho";

function anchoGuardado(): number {
  try {
    const n = Number(localStorage.getItem(CLAVE_ANCHO));
    return Number.isFinite(n) && n >= ANCHO_MINIMO ? n : 520;
  } catch {
    return 520;
  }
}

export const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const PANEL = "panel-artefacto";

/** El panel de la derecha: asa para ensancharlo, cabecera con icono, título y Cerrar; el resto lo pone quien lo usa. */
export function MarcoPanel({
  titulo,
  ayuda,
  icono,
  cabecera,
  menu,
  alCerrar,
  children,
}: {
  titulo: string;
  /** Texto al pasar el ratón por el título (la ruta de un documento). */
  ayuda?: string;
  icono: NombreIcono;
  /** Lo que va entre el título y Cerrar (el selector de versión). */
  cabecera?: ReactNode;
  menu: ReturnType<typeof useMenuContextual>;
  alCerrar: () => void;
  children: ReactNode;
}) {
  const [ancho, setAncho] = useState(anchoGuardado);
  const panel = useRef<HTMLElement>(null);

  // Ensanchar arrastrando el borde izquierdo (o con las flechas cuando el asa tiene el foco).
  const maximo = () => Math.max(ANCHO_MINIMO, (panel.current?.parentElement?.clientWidth ?? 1200) - MINIMO_CONVERSACION);
  const fijarAncho = (n: number) => {
    const v = Math.round(Math.min(maximo(), Math.max(ANCHO_MINIMO, n)));
    setAncho(v);
    try {
      localStorage.setItem(CLAVE_ANCHO, String(v));
    } catch {
      // Sin almacenamiento: el ancho dura lo que dure la vista.
    }
  };
  const arrastrar = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const asa = e.currentTarget;
    asa.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const a0 = panel.current?.getBoundingClientRect().width ?? ancho;
    const mover = (m: globalThis.PointerEvent) => fijarAncho(a0 + (x0 - m.clientX));
    const soltar = () => {
      asa.removeEventListener("pointermove", mover);
      asa.removeEventListener("pointerup", soltar);
      asa.removeEventListener("pointercancel", soltar);
    };
    asa.addEventListener("pointermove", mover);
    asa.addEventListener("pointerup", soltar);
    asa.addEventListener("pointercancel", soltar);
  };
  const teclaAsa = (e: KeyboardEvent<HTMLDivElement>) => {
    const paso = e.shiftKey ? 80 : 24;
    const nuevo = { ArrowLeft: ancho + paso, ArrowRight: ancho - paso, Home: maximo(), End: ANCHO_MINIMO }[e.key];
    if (nuevo === undefined) return;
    e.preventDefault();
    fijarAncho(nuevo);
  };

  return (
    <aside ref={panel} className="panel-artefacto" aria-label={titulo} style={{ width: ancho }} {...menu}>
      {/* biome-ignore lint/a11y/useSemanticElements: un <hr> no se puede arrastrar ni enfocar; es el separador redimensionable de ARIA. */}
      <div
        className="panel-artefacto__asa"
        role="separator"
        aria-orientation="vertical"
        aria-label="Ancho del panel"
        aria-valuenow={ancho}
        aria-valuemin={ANCHO_MINIMO}
        tabIndex={0}
        onPointerDown={arrastrar}
        onKeyDown={teclaAsa}
      />
      <header className="panel-artefacto__cabecera">
        <Icono nombre={icono} tamano={18} className="panel-artefacto__icono" />
        <h2 className="panel-artefacto__titulo" title={ayuda ?? titulo}>
          {titulo}
        </h2>
        {cabecera}
        <BotonIcono etiqueta="Cerrar" icono="cerrar" onClick={alCerrar} />
      </header>
      {children}
    </aside>
  );
}

/* ── Guardar en la carpeta de la sesión ───────────── */

/** Qué se guarda: el texto tal cual (artefactos.guardar) o el markdown convertido a Word (documentos.exportar). */
export interface Destino {
  tipo: "fichero" | "word";
  nombre: string;
  contenido: string;
}

export type Guardado = { tipo: "guardando" } | { tipo: "ok"; ruta: string } | { tipo: "existe"; destino: Destino } | { tipo: "error"; texto: string };

/** Guardar con la pregunta de sobrescribir: si ya existe (código `yaExiste`), se queda en «existe» hasta que se elija. */
export function useGuardado(sesionId: string) {
  const { llamar } = useAcciones();
  const [guardado, setGuardado] = useState<Guardado>();
  const guardar = useCallback(
    async (destino: Destino, sobrescribir = false) => {
      setGuardado({ tipo: "guardando" });
      const extra = sobrescribir ? { sobrescribir: true } : {};
      try {
        const { ruta } =
          destino.tipo === "word"
            ? await llamar("documentos.exportar", { sesionId, nombre: destino.nombre, markdown: destino.contenido, ...extra })
            : await llamar("artefactos.guardar", { sesionId, nombre: destino.nombre, contenido: destino.contenido, ...extra });
        setGuardado({ tipo: "ok", ruta });
      } catch (e) {
        setGuardado(!sobrescribir && e instanceof ErrorNucleo && e.codigo === codigosError.yaExiste ? { tipo: "existe", destino } : { tipo: "error", texto: mensaje(e) });
      }
    },
    [llamar, sesionId],
  );
  const olvidar = useCallback(() => setGuardado(undefined), []);
  return { guardado, guardar, olvidar };
}

export function EstadoGuardado({ guardado, alGuardar, alCancelar }: { guardado?: Guardado; alGuardar: (d: Destino, sobrescribir: boolean) => void; alCancelar: () => void }) {
  const cancelar = useRef<HTMLButtonElement>(null);
  const existe = guardado?.tipo === "existe";
  useEffect(() => {
    if (existe) cancelar.current?.focus();
  }, [existe]);
  if (!guardado || guardado.tipo === "guardando") return null;
  if (guardado.tipo === "existe")
    return (
      <div className="panel-artefacto__aviso" role="alert">
        <span>
          <code>{guardado.destino.nombre}</code> ya existe
        </span>
        <Boton variante="acento" tamano="pequeno" onClick={() => alGuardar(guardado.destino, true)}>
          Sobrescribir
        </Boton>
        <Boton variante="fantasma" tamano="pequeno" ref={cancelar} onClick={alCancelar} onKeyDown={(e) => e.key === "Escape" && alCancelar()}>
          Cancelar
        </Boton>
      </div>
    );
  if (guardado.tipo === "error")
    return (
      <p className="panel-artefacto__aviso panel-artefacto__aviso--error" role="alert">
        {guardado.texto}
      </p>
    );
  return (
    <div className="panel-artefacto__aviso" role="status">
      <Icono nombre="check" tamano={14} grosor={2.5} />
      <span className="panel-artefacto__ruta" title={guardado.ruta}>
        {guardado.ruta}
      </span>
      {puedeMostrarRutas() && (
        <Boton variante="fantasma" tamano="pequeno" icono="carpeta" onClick={() => void mostrarFichero(guardado.ruta)}>
          Mostrar fichero
        </Boton>
      )}
    </div>
  );
}

/* ── Panel de un artefacto ────────────────────────── */

export function PanelArtefacto({
  sesionId,
  versiones,
  indice,
  pestana,
  alVersion,
  alPestana,
  alCerrar,
}: {
  sesionId: string;
  versiones: Artefacto[];
  indice: number;
  pestana: PestanaArtefacto;
  alVersion: (i: number) => void;
  alPestana: (p: PestanaArtefacto) => void;
  alCerrar: () => void;
}) {
  const a = versiones[indice] ?? versiones[versiones.length - 1];
  const { guardado, guardar, olvidar } = useGuardado(sesionId);
  const [copiado, setCopiado] = useState(false);

  // Otro artefacto u otra versión: lo de guardar era del anterior.
  // biome-ignore lint/correctness/useExhaustiveDependencies: el disparador es el cambio de artefacto o de versión.
  useEffect(() => olvidar(), [a?.id, indice]);
  useEffect(() => {
    if (!copiado) return;
    const t = setTimeout(() => setCopiado(false), 1400);
    return () => clearTimeout(t);
  }, [copiado]);

  const conVista = a ? renderizable(a.tipo) : false;
  const activa: PestanaArtefacto = conVista ? pestana : "codigo";
  const conWord = a?.tipo === "markdown";
  const ocupado = !a?.completo || guardado?.tipo === "guardando";

  const copiar = () => {
    if (!a) return;
    copiarTexto(a.contenido);
    setCopiado(true);
  };
  const enCarpeta = () => a && void guardar({ tipo: "fichero", nombre: nombreFichero(a), contenido: a.contenido });
  const comoWord = () => a && void guardar({ tipo: "word", nombre: nombreWord(a.id), contenido: a.contenido });

  const menu = useMenuContextual(({ seleccion }) => [
    seleccion.trim() && { texto: "Copiar", icono: "copiar", atajo: "Ctrl+C", alElegir: () => copiarTexto(seleccion) },
    seleccion.trim() && { tipo: "separador" },
    { texto: seleccion.trim() ? "Copiar todo" : "Copiar", icono: "copiar", alElegir: copiar },
    { texto: "Guardar en la carpeta", icono: "guardar", deshabilitado: !a?.completo, alElegir: enCarpeta },
    conWord && { texto: "Guardar como Word", icono: "documento", deshabilitado: !a?.completo, alElegir: comoWord },
    { tipo: "separador" },
    { texto: "Cerrar", icono: "cerrar", alElegir: alCerrar },
  ]);

  if (!a) return null;

  return (
    <MarcoPanel
      titulo={a.titulo}
      icono={ICONOS_ARTEFACTO[a.tipo]}
      menu={menu}
      alCerrar={alCerrar}
      cabecera={
        versiones.length > 1 && (
          <Desplegable
            etiqueta="Versión"
            alineacion="derecha"
            disparador={({ alternar, abierto: _a, ...aria }) => (
              <Boton variante="chip" tamano="pequeno" iconoFinal="chevron-abajo" onClick={alternar} title="Versión" {...aria}>
                v{indice + 1}
              </Boton>
            )}
          >
            {(cerrar) =>
              versiones.map((v, i) => (
                <Opcion
                  // biome-ignore lint/suspicious/noArrayIndexKey: las versiones solo se añaden al final.
                  key={i}
                  texto={`v${i + 1}`}
                  marcada={i === indice}
                  titulo={v.titulo}
                  alElegir={() => {
                    alVersion(i);
                    cerrar();
                  }}
                />
              ))
            }
          </Desplegable>
        )
      }
    >
      <div className="panel-artefacto__barra">
        {conVista ? (
          <Pestanas
            etiqueta="Artefacto"
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
          <span className="panel-artefacto__lenguaje">{a.lenguaje ?? ""}</span>
        )}
        <span className="panel-artefacto__acciones">
          <BotonIcono etiqueta={copiado ? "Copiado" : "Copiar"} icono={copiado ? "check" : "copiar"} onClick={copiar} />
          <BotonIcono etiqueta="Guardar en la carpeta" icono="guardar" disabled={ocupado} onClick={enCarpeta} />
          {conWord && <BotonIcono etiqueta="Guardar como Word" icono="documento" disabled={ocupado} onClick={comoWord} />}
        </span>
      </div>
      <EstadoGuardado guardado={guardado} alGuardar={(d, s) => void guardar(d, s)} alCancelar={olvidar} />
      <div
        className={clases("panel-artefacto__cuerpo", activa === "vista" && `panel-artefacto__cuerpo--${a.tipo}`)}
        {...(conVista ? { role: "tabpanel", id: PANEL, "aria-labelledby": idPestana(PANEL, activa) } : {})}
      >
        {activa === "codigo" ? (
          <CodigoConLineas key={`${a.id}:${indice}`} texto={a.contenido} seguir={!a.completo} />
        ) : a.tipo === "markdown" ? (
          <div className="panel-artefacto__md">
            <Markdown texto={a.contenido} />
          </div>
        ) : a.completo && (a.tipo === "html" || a.tipo === "svg") ? (
          <VistaAislada tipo={a.tipo} contenido={a.contenido} titulo={a.titulo} />
        ) : (
          <div className="panel-artefacto__espera">
            <LatticeLoader activo />
            <span>{lineas(contarLineas(a.contenido))}</span>
          </div>
        )}
      </div>
    </MarcoPanel>
  );
}

/** Código con números de línea; mientras llega, sigue el final si no se ha subido a leer. */
export function CodigoConLineas({ texto, seguir }: { texto: string; seguir: boolean }) {
  const caja = useRef<HTMLElement>(null);
  const pegado = useRef(true);
  const n = contarLineas(texto);
  const numeros = useMemo(() => Array.from({ length: Math.max(1, n) }, (_, i) => i + 1).join("\n"), [n]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: el disparador es que llegue texto.
  useLayoutEffect(() => {
    const c = caja.current;
    if (c && seguir && pegado.current) c.scrollTop = c.scrollHeight;
  }, [texto, seguir]);
  return (
    <section
      ref={caja}
      className="artefacto-codigo"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: una zona con scroll tiene que poder enfocarse para moverse con el teclado.
      tabIndex={0}
      aria-label="Código"
      onScroll={(e) => {
        const d = e.currentTarget;
        pegado.current = d.scrollHeight - d.scrollTop - d.clientHeight < 40;
      }}
    >
      <pre className="artefacto-codigo__numeros" aria-hidden="true">
        {numeros}
      </pre>
      <pre className="artefacto-codigo__texto">
        <code>{texto}</code>
      </pre>
    </section>
  );
}

/* ── Vista aislada (HTML y SVG) ───────────────────── */

/** El núcleo guarda cada vista una hora (o hasta 50 más): se reutiliza un poco menos. */
const DURACION_VISTA_MS = 50 * 60 * 1000;
const MAX_VISTAS = 30;
const vistas = new Map<string, { url: Promise<string>; hasta: number }>();

function publicar(clave: string, crear: () => Promise<string>): Promise<string> {
  const ahora = Date.now();
  const hay = vistas.get(clave);
  if (hay && hay.hasta > ahora) return hay.url;
  const url = crear();
  vistas.set(clave, { url, hasta: ahora + DURACION_VISTA_MS });
  url.catch(() => vistas.delete(clave));
  while (vistas.size > MAX_VISTAS) {
    const primera = vistas.keys().next().value;
    if (primera === undefined) break;
    vistas.delete(primera);
  }
  return url;
}

/** iframe en el origen del núcleo, sin allow-same-origin: el artefacto no ve la app ni el token. */
export function VistaAislada({ tipo, contenido, titulo }: { tipo: "html" | "svg"; contenido: string; titulo: string }) {
  const { llamar, urlNucleo } = useAcciones();
  const [estado, setEstado] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let vivo = true;
    setEstado({});
    publicar(`${tipo}\u0000${contenido}`, async () => urlNucleo((await llamar("artefactos.vista", { tipo, contenido })).ruta)).then(
      (url) => vivo && setEstado({ url }),
      (e: unknown) => vivo && setEstado({ error: mensaje(e) }),
    );
    return () => {
      vivo = false;
    };
  }, [tipo, contenido, llamar, urlNucleo]);
  if (estado.error)
    return (
      <p className="panel-artefacto__aviso panel-artefacto__aviso--error" role="alert">
        {estado.error}
      </p>
    );
  if (!estado.url)
    return (
      <div className="panel-artefacto__espera">
        <LatticeLoader activo />
      </div>
    );
  return <iframe className="panel-artefacto__marco" src={estado.url} title={titulo} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" />;
}
