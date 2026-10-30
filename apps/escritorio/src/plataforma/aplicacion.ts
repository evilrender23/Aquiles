/**
 * Lo que solo existe en la app de escritorio (comandos de src-tauri y plugins): perfiles, núcleo remoto,
 * actualizaciones, arranque con Windows, ventanas y sus eventos. En el navegador no hacen nada:
 * las consultas devuelven `undefined` y la interfaz oculta lo que dependa de ellas.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { enTauri } from "./tauri";

/** Escucha un evento de Tauri; devuelve cómo dejar de escuchar (también si aún no se había registrado). */
export function escucharTauri<T>(evento: string, f: (datos: T) => void): () => void {
  if (!enTauri()) return () => {};
  let vivo = true;
  let soltar: (() => void) | undefined;
  listen<T>(evento, (e) => f(e.payload)).then(
    (s) => (vivo ? (soltar = s) : s()),
    () => {},
  );
  return () => {
    vivo = false;
    soltar?.();
  };
}

/** El núcleo vuelve a estar listo tras reiniciarse (perfil, copia, remoto…): hay que reconectar. */
export const alReiniciarNucleo = (f: () => void) => escucharTauri<unknown>("nucleo-reiniciado", f);
/** La entrada rápida creó una sesión y pide abrirla aquí. */
export const alAbrirSesion = (f: (sesionId: string) => void) => escucharTauri<string>("abrir-sesion", f);

export const arranqueActivado = (): Promise<boolean | undefined> => (enTauri() ? isEnabled() : Promise.resolve(undefined));
export const cambiarArranque = async (activo: boolean): Promise<void> => {
  if (enTauri()) await (activo ? enable() : disable());
};

/**
 * Actualizaciones: la app se compila desde `main` del repositorio. La versión es el commit
 * (`getVersion()` siempre da 0.0.1 y no sirve).
 */
export interface InfoActualizacion {
  /** Commit corto de la app en marcha; null si no se sabe. */
  actual: string | null;
  /** El último de `main`, con su fecha y su mensaje. */
  ultimo: string;
  fecha: string | null;
  mensaje: string | null;
  hayNueva: boolean;
  /** Es la compilación de desarrollo (no se actualiza sola). */
  desarrollo: boolean;
}
export type EstadoActualizacion =
  | { fase: "inactiva" }
  | { fase: "compilando"; paso: number; total: number; texto: string }
  | { fase: "lista"; commit: string }
  | { fase: "error"; texto: string };
export interface ProgresoActualizacion {
  paso: number;
  total: number;
  texto: string;
}
/** Hace git fetch; falla con un texto claro sin red o sin credenciales. */
export const buscarActualizacion = (): Promise<InfoActualizacion | undefined> => (enTauri() ? invoke<InfoActualizacion>("buscar_actualizacion") : Promise.resolve(undefined));
/** Empieza a compilar en segundo plano (el progreso llega por eventos). */
export const instalarActualizacion = (): Promise<void> => (enTauri() ? invoke<void>("instalar_actualizacion") : Promise.resolve());
export const estadoActualizacion = (): Promise<EstadoActualizacion | undefined> => (enTauri() ? invoke<EstadoActualizacion>("estado_actualizacion") : Promise.resolve(undefined));
/** Solo con la compilación lista: la app se cierra, cambia las carpetas y vuelve a abrirse. */
export const aplicarActualizacion = (): Promise<void> => (enTauri() ? invoke<void>("aplicar_actualizacion") : Promise.resolve());
export const actualizarSolo = (): Promise<boolean | undefined> => (enTauri() ? invoke<boolean>("actualizar_solo") : Promise.resolve(undefined));
export const cambiarActualizarSolo = (activo: boolean): Promise<void> => (enTauri() ? invoke<void>("cambiar_actualizar_solo", { activo }) : Promise.resolve());
export const alProgresoActualizacion = (f: (p: ProgresoActualizacion) => void) => escucharTauri<ProgresoActualizacion>("actualizacion-progreso", f);
export const alActualizacionLista = (f: (d: { commit: string }) => void) => escucharTauri<{ commit: string }>("actualizacion-lista", f);
export const alErrorActualizacion = (f: (d: { texto: string }) => void) => escucharTauri<{ texto: string }>("actualizacion-error", f);

export const perfilActual = (): Promise<string | undefined> => (enTauri() ? invoke<string>("perfil_actual") : Promise.resolve(undefined));
/** Guarda el perfil y relanza el núcleo con él (luego llega «nucleo-reiniciado»). */
export const cambiarPerfil = (nombre: string): Promise<void> => (enTauri() ? invoke<void>("cambiar_perfil", { nombre }) : Promise.resolve());

/** URL del núcleo remoto, `null` si se usa el local, `undefined` en el navegador. */
export const remotoActual = (): Promise<string | null | undefined> => (enTauri() ? invoke<string | null>("remoto_actual") : Promise.resolve(undefined));
export const conectarRemoto = (url: string, token: string): Promise<void> => (enTauri() ? invoke<void>("conectar_remoto", { url, token }) : Promise.resolve());
export const desconectarRemoto = (): Promise<void> => (enTauri() ? invoke<void>("desconectar_remoto") : Promise.resolve());

/** Entrada rápida: esconde su ventana y pasa a la principal, con la sesión creada. */
export const mostrarPrincipal = (sesionId?: string): Promise<void> => (enTauri() ? invoke<void>("mostrar_principal", { sesionId: sesionId ?? null }) : Promise.resolve());
export const ocultarVentana = (): Promise<void> => (enTauri() ? getCurrentWindow().hide() : Promise.resolve());

/** Atajo global de la entrada rápida («ctrl+alt+space»…) y si se pudo registrar (otro programa puede tenerlo). */
export interface EstadoAtajo {
  atajo: string;
  registrado: boolean;
  error?: string;
}
export const atajoActual = (): Promise<EstadoAtajo | undefined> => (enTauri() ? invoke<EstadoAtajo>("atajo_actual") : Promise.resolve(undefined));
export const cambiarAtajo = (atajo: string): Promise<EstadoAtajo | undefined> => (enTauri() ? invoke<EstadoAtajo>("cambiar_atajo", { atajo }) : Promise.resolve(undefined));

/** «Mostrar carpeta / fichero» solo existen en la app de escritorio (plugin opener). */
export const puedeMostrarRutas = (): boolean => enTauri();
/** Abre una carpeta (que exista) en el explorador. */
export const abrirCarpeta = (ruta: string): Promise<void> => (enTauri() ? invoke<void>("abrir_carpeta", { ruta }) : Promise.resolve());
/** Abre el explorador en la carpeta de un fichero, con el fichero seleccionado. */
export const mostrarFichero = (ruta: string): Promise<void> => (enTauri() ? revealItemInDir(ruta) : Promise.resolve());
