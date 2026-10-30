/** Adjuntos: los de la caja antes de enviar (chips, pegar, soltar, clip) y los de los mensajes ya enviados. */
import { BotonIcono, Icono, clases, copiarTexto, useMenuContextual } from "@aquiles/ui";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { useAcciones } from "../estado/almacen";
import { type AdjuntoPendiente, admitir, desdeFicheros, desdeRutas, esImagen, renombrarPegado, tamanoLegible } from "../estado/adjuntos";
import { claseDocumento } from "../estado/artefactos";
import type { AdjuntoVisto } from "../estado/tipos";
import { mostrarFichero, puedeMostrarRutas } from "../plataforma/aplicacion";
import { alArrastrarFicheros } from "../plataforma/arrastre";
import { elegirFicheros } from "../plataforma/dialogo";
import { enTauri } from "../plataforma/tauri";
import { useArtefactosHilo } from "./Artefactos";

/** Los adjuntos de una caja: añadir (clip, soltar, pegar), quitar y vaciar al enviar, con el error del último intento. */
export function useAdjuntos() {
  const [adjuntos, setAdjuntos] = useState<AdjuntoPendiente[]>([]);
  const [error, setError] = useState<string>();
  const [arrastrando, setArrastrando] = useState(false);
  const actuales = useRef(adjuntos);
  actuales.current = adjuntos;

  const anadir = useCallback((nuevos: AdjuntoPendiente[], errorPrevio?: string) => {
    const r = admitir(actuales.current, nuevos);
    actuales.current = r.lista;
    setAdjuntos(r.lista);
    setError([errorPrevio, r.error].filter(Boolean).join(" · ") || undefined);
  }, []);

  const anadirFicheros = useCallback(
    async (ficheros: File[]) => {
      if (!ficheros.length) return;
      const r = await desdeFicheros(ficheros);
      anadir(r.adjuntos, r.error);
    },
    [anadir],
  );
  const anadirRutas = useCallback((rutas: string[]) => rutas.length && anadir(desdeRutas(rutas)), [anadir]);

  // Soltar ficheros en la ventana: en la app, el WebView da las rutas; en el navegador, los eventos HTML5.
  useEffect(() => {
    if (enTauri())
      return alArrastrarFicheros({
        entrar: () => setArrastrando(true),
        salir: () => setArrastrando(false),
        soltar: (rutas) => {
          setArrastrando(false);
          anadirRutas(rutas);
        },
      });
    let dentro = 0;
    const conFicheros = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const entrar = (e: DragEvent) => {
      if (!conFicheros(e)) return;
      dentro++;
      setArrastrando(true);
    };
    const sobre = (e: DragEvent) => {
      if (!conFicheros(e) || !e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const salir = (e: DragEvent) => {
      if (!conFicheros(e)) return;
      dentro = Math.max(0, dentro - 1);
      if (!dentro) setArrastrando(false);
    };
    const soltar = (e: DragEvent) => {
      if (!conFicheros(e)) return;
      e.preventDefault();
      dentro = 0;
      setArrastrando(false);
      void anadirFicheros([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", entrar);
    window.addEventListener("dragover", sobre);
    window.addEventListener("dragleave", salir);
    window.addEventListener("drop", soltar);
    return () => {
      window.removeEventListener("dragenter", entrar);
      window.removeEventListener("dragover", sobre);
      window.removeEventListener("dragleave", salir);
      window.removeEventListener("drop", soltar);
    };
  }, [anadirFicheros, anadirRutas]);

  /** Ctrl+V con imágenes en el portapapeles: se adjuntan; el texto se pega como siempre. */
  const pegar = useCallback(
    (e: ClipboardEvent<HTMLElement>) => {
      const imagenes = [...e.clipboardData.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile());
      const ficheros = imagenes.filter((f): f is File => !!f).map(renombrarPegado);
      if (!ficheros.length) return;
      e.preventDefault();
      void anadirFicheros(ficheros);
    },
    [anadirFicheros],
  );

  const quitar = useCallback((clave: string) => {
    const lista = actuales.current.filter((a) => a.clave !== clave);
    actuales.current = lista;
    setAdjuntos(lista);
    setError(undefined);
  }, []);

  const vaciar = useCallback(() => {
    actuales.current = [];
    setAdjuntos([]);
    setError(undefined);
  }, []);

  /** Devuelve a la caja los adjuntos de un envío que no salió, si no se ha adjuntado nada después. */
  const restaurar = useCallback((lista: AdjuntoPendiente[]) => {
    if (actuales.current.length) return;
    actuales.current = lista;
    setAdjuntos(lista);
  }, []);

  return { adjuntos, error, setError, arrastrando, anadirFicheros, anadirRutas, pegar, quitar, vaciar, restaurar };
}

/** Clip: el selector nativo en la app (rutas); un <input type=file> en el navegador (contenido). */
export function BotonAdjuntar({ alRutas, alFicheros, deshabilitado }: { alRutas: (r: string[]) => void; alFicheros: (f: File[]) => void; deshabilitado?: boolean }) {
  const entrada = useRef<HTMLInputElement>(null);
  return (
    <>
      <BotonIcono
        etiqueta="Adjuntar"
        icono="clip"
        disabled={deshabilitado}
        onClick={() => {
          if (enTauri()) void elegirFicheros().then(alRutas, () => {});
          else entrada.current?.click();
        }}
      />
      {!enTauri() && (
        <input
          ref={entrada}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            alFicheros([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      )}
    </>
  );
}

/** Los adjuntos por enviar: miniatura si es imagen, nombre, tamaño y ×. */
export function ChipsAdjuntos({ adjuntos, alQuitar, compacto = false }: { adjuntos: AdjuntoPendiente[]; alQuitar: (clave: string) => void; compacto?: boolean }) {
  if (!adjuntos.length) return null;
  return (
    <ul className={clases("adjuntos", compacto && "adjuntos--compacto")} aria-label="Adjuntos">
      {adjuntos.map((a) => (
        <li key={a.clave} className="adjunto" title={a.ruta ?? a.nombre}>
          {a.miniatura ? <img className="adjunto__miniatura" src={a.miniatura} alt="" /> : <Icono nombre="fichero" tamano={compacto ? 14 : 16} className="adjunto__icono" />}
          <span className="adjunto__nombre">{a.nombre}</span>
          {a.bytes !== undefined && <span className="adjunto__tamano">{tamanoLegible(a.bytes)}</span>}
          <BotonIcono variante="pequeno" etiqueta={`Quitar ${a.nombre}`} icono="cerrar" tamanoIcono={13} className="adjunto__quitar" onClick={() => alQuitar(a.clave)} />
        </li>
      ))}
    </ul>
  );
}

/** Mientras se arrastran ficheros sobre la ventana. */
export function ZonaSoltar({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="zona-soltar" aria-hidden="true">
      <Icono nombre="clip" tamano={28} />
    </div>
  );
}

/* ── En el hilo ───────────────────────────────────── */

/** Miniaturas del historial: se piden una vez (adjuntos.leer) y se guardan para toda la sesión de la app. */
const miniaturas = new Map<string, Promise<string>>();

function useMiniatura(sesionId: string, a: AdjuntoVisto): string | undefined {
  const { llamar } = useAcciones();
  const [url, setUrl] = useState(a.miniatura);
  const imagen = esImagen(a);
  useEffect(() => {
    if (url || !imagen || !a.id) return;
    const clave = `${sesionId}:${a.id}`;
    let p = miniaturas.get(clave);
    if (!p) {
      p = llamar("adjuntos.leer", { sesionId, id: a.id }).then((r) => `data:${r.tipo};base64,${r.datos}`);
      miniaturas.set(clave, p);
      p.catch(() => miniaturas.delete(clave));
    }
    let vivo = true;
    p.then(
      (u) => vivo && setUrl(u),
      () => {},
    );
    return () => {
      vivo = false;
    };
  }, [url, imagen, a.id, sesionId, llamar]);
  return url;
}

export function AdjuntosMensaje({ sesionId, adjuntos }: { sesionId: string; adjuntos: AdjuntoVisto[] }) {
  const [ampliada, setAmpliada] = useState<{ url: string; nombre: string }>();
  return (
    <>
      <ul className="adjuntos adjuntos--mensaje" aria-label="Adjuntos">
        {adjuntos.map((a, i) => (
          <AdjuntoMensaje key={a.id ?? i} sesionId={sesionId} a={a} alAmpliar={setAmpliada} />
        ))}
      </ul>
      {ampliada && <Ampliada url={ampliada.url} nombre={ampliada.nombre} alCerrar={() => setAmpliada(undefined)} />}
    </>
  );
}

function AdjuntoMensaje({ sesionId, a, alAmpliar }: { sesionId: string; a: AdjuntoVisto; alAmpliar: (x: { url: string; nombre: string }) => void }) {
  const url = useMiniatura(sesionId, a);
  const imagen = esImagen(a);
  const ruta = a.ruta;
  const mostrar = puedeMostrarRutas() && !!ruta;
  // Un .md o un .docx se abre en el visor del panel de artefactos.
  const visor = useArtefactosHilo();
  const verDocumento = ruta && visor && claseDocumento(ruta) ? () => visor.abrirDocumento(ruta, a.nombre) : undefined;
  const menu = useMenuContextual(() => [
    imagen && url && { texto: "Ver", icono: "flecha-diagonal", alElegir: () => alAmpliar({ url, nombre: a.nombre }) },
    verDocumento && { texto: "Ver", icono: "flecha-diagonal", alElegir: verDocumento },
    ruta && { texto: "Copiar ruta", icono: "copiar", alElegir: () => copiarTexto(ruta) },
    mostrar && ruta && { texto: "Mostrar fichero", icono: "carpeta", alElegir: () => mostrarFichero(ruta) },
  ]);
  const detalle = [a.bytes !== undefined ? tamanoLegible(a.bytes) : undefined].filter(Boolean).join(" · ");

  if (imagen && url) {
    return (
      <li className="adjunto-mensaje adjunto-mensaje--imagen" {...menu}>
        <button type="button" className="adjunto-mensaje__imagen" title={a.nombre} onClick={() => alAmpliar({ url, nombre: a.nombre })}>
          <img src={url} alt={a.nombre} />
        </button>
      </li>
    );
  }
  const contenido = (
    <>
      <Icono nombre="fichero" tamano={16} className="adjunto__icono" />
      <span className="adjunto__nombre">{a.nombre}</span>
      {detalle && <span className="adjunto__tamano">{detalle}</span>}
    </>
  );
  const abrir = verDocumento ?? (mostrar && ruta ? () => void mostrarFichero(ruta) : undefined);
  return (
    <li className="adjunto adjunto--mensaje" title={ruta ?? a.nombre} {...menu}>
      {abrir ? (
        <button type="button" className="adjunto__abrir" onClick={abrir}>
          {contenido}
        </button>
      ) : (
        contenido
      )}
    </li>
  );
}

/** Imagen a tamaño grande; se cierra con Escape, con el botón o pulsando fuera. */
function Ampliada({ url, nombre, alCerrar }: { url: string; nombre: string; alCerrar: () => void }) {
  const cerrar = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cerrar.current?.focus();
    const tecla = (e: KeyboardEvent) => e.key === "Escape" && alCerrar();
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [alCerrar]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape cierra (escuchado en window) y el botón tiene el foco.
    <div className="ampliada" role="dialog" aria-modal="true" aria-label={nombre} onClick={(e) => e.target === e.currentTarget && alCerrar()}>
      <img src={url} alt={nombre} className="ampliada__imagen" />
      <BotonIcono ref={cerrar} etiqueta="Cerrar" icono="cerrar" className="ampliada__cerrar" onClick={alCerrar} />
    </div>
  );
}
