/**
 * Lo que solo existe en la app de escritorio (comandos de src-tauri y plugins): perfiles, núcleo remoto,
 * actualizaciones, arranque con Windows, ventanas y sus eventos. En el navegador no hacen nada:
 * las consultas devuelven `undefined` y la interfaz oculta lo que dependa de ellas.
 */
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
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

export const versionApp = (): Promise<string | undefined> => (enTauri() ? getVersion() : Promise.resolve(undefined));

export const arranqueActivado = (): Promise<boolean | undefined> => (enTauri() ? isEnabled() : Promise.resolve(undefined));
export const cambiarArranque = async (activo: boolean): Promise<void> => {
  if (enTauri()) await (activo ? enable() : disable());
};

export interface Actualizacion {
  version: string;
  notas?: string | null;
}
export interface ProgresoActualizacion {
  descargados: number;
  total?: number | null;
}
export const buscarActualizacion = (): Promise<Actualizacion | null> => (enTauri() ? invoke<Actualizacion | null>("buscar_actualizacion") : Promise.resolve(null));
/** Descarga, instala y relanza la app; solo vuelve si algo falla. */
export const instalarActualizacion = (): Promise<void> => (enTauri() ? invoke<void>("instalar_actualizacion") : Promise.resolve());
export const alProgresoActualizacion = (f: (p: ProgresoActualizacion) => void) => escucharTauri<ProgresoActualizacion>("actualizacion-progreso", f);

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
