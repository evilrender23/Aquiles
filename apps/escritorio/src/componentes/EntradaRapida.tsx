/**
 * Entrada rápida (`index.html?vista=rapida`): la ventana pequeña del atajo Ctrl+Alt+Espacio.
 * Enter crea una sesión con los ajustes por defecto, le manda el texto y pasa a la ventana principal;
 * Escape la esconde. Tiene su propia conexión con el núcleo (la misma que la principal, vía conexion_nucleo).
 * No pasa por App: el idioma lo toma del guardado y, al conectar o al recibir el foco, de los ajustes.
 */
import { Boton, t } from "@aquiles/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { datosConexion } from "../conexion";
import { alReiniciarNucleo, mostrarPrincipal, ocultarVentana } from "../plataforma/aplicacion";
import { paraEnviar } from "../estado/adjuntos";
import { aplicarIdioma, idiomaGuardado } from "../i18n";
import { ClienteRpc } from "../rpc";
import { ChipsAdjuntos, ZonaSoltar, useAdjuntos } from "./Adjuntos";

export function EntradaRapida() {
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string>();
  // Ficheros soltados en la ventana e imágenes pegadas (sin clip: aquí no hay sitio ni permiso para el diálogo).
  const adj = useAdjuntos();
  const cliente = useRef<ClienteRpc | undefined>(undefined);
  const caja = useRef<HTMLTextAreaElement>(null);
  // Cambiarlo vuelve a pintar la ventana con el idioma nuevo (t() se llama al pintar).
  const [, setIdioma] = useState(idiomaGuardado);

  /** La conexión abierta, o una nueva si se cerró (el núcleo se reinició, por ejemplo). */
  const conexion = useCallback(async (): Promise<ClienteRpc> => {
    if (cliente.current) return cliente.current;
    const { url, token } = await datosConexion();
    const c = await ClienteRpc.conectar(url, token);
    c.alCerrar(() => {
      if (cliente.current === c) cliente.current = undefined;
    });
    cliente.current = c;
    return c;
  }, []);

  /** El idioma de los ajustes (puede haberse cambiado en la ventana principal). */
  const leerIdioma = useCallback(async () => {
    try {
      const { idioma } = await (await conexion()).llamar("ajustes.leer", {});
      aplicarIdioma(idioma);
      setIdioma(idioma);
    } catch {
      // Sin núcleo: se queda el guardado.
    }
  }, [conexion]);

  useEffect(() => {
    // Tras un reinicio del núcleo la conexión vieja ya no sirve: la próxima se pide de nuevo.
    const soltar = alReiniciarNucleo(() => {
      cliente.current?.cerrar();
      cliente.current = undefined;
    });
    // El atajo enseña la ventana ya creada: al recibir el foco, el cursor va a la caja (y se mira el idioma, por si cambió).
    // La primera vez, además, abre la conexión.
    const enfocar = () => {
      caja.current?.focus();
      void leerIdioma();
    };
    window.addEventListener("focus", enfocar);
    enfocar();
    return () => {
      soltar();
      window.removeEventListener("focus", enfocar);
      cliente.current?.cerrar();
      cliente.current = undefined;
    };
  }, [leerIdioma]);

  const empezar = async () => {
    const limpio = texto.trim();
    if ((!limpio && !adj.adjuntos.length) || enviando) return;
    setEnviando(true);
    setError(undefined);
    try {
      const c = await conexion();
      const sesion = await c.llamar("sesion.crear", {});
      const adjuntos = adj.adjuntos.map(paraEnviar);
      await c.llamar("prompt.enviar", { sesionId: sesion.sesionId, texto: limpio, ...(adjuntos.length ? { adjuntos } : {}) });
      setTexto("");
      adj.vaciar();
      await mostrarPrincipal(sesion.sesionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form
      className="rapida"
      onSubmit={(e) => {
        e.preventDefault();
        void empezar();
      }}
    >
      <ZonaSoltar visible={adj.arrastrando} />
      <div className="rapida__caja">
        <textarea
          ref={caja}
          className="rapida__texto"
          aria-label={t("Instrucción para Aquiles")}
          placeholder={t("Describe qué quieres que haga")}
          rows={adj.adjuntos.length ? 1 : 2}
          value={texto}
          onPaste={adj.pegar}
          onChange={(e) => {
            setTexto(e.target.value);
            setError(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              void ocultarVentana();
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void empezar();
            }
          }}
        />
        <ChipsAdjuntos adjuntos={adj.adjuntos} alQuitar={adj.quitar} compacto />
        {(error || adj.error) && (
          <p className="rapida__error" role="alert">
            {error ?? adj.error}
          </p>
        )}
      </div>
      <Boton type="submit" variante="principal" iconoFinal="flecha-diagonal" disabled={(!texto.trim() && !adj.adjuntos.length) || enviando}>
        {t("Empezar")}
      </Boton>
    </form>
  );
}
