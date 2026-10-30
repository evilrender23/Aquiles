/**
 * Claves de API en el llavero de Windows (comandos de src-tauri). En el navegador no hay llavero:
 * la clave solo se pasa al núcleo con `ajustes.clave` y dura lo que dure ese proceso.
 */
import { invoke } from "@tauri-apps/api/core";
import { enTauri } from "./tauri";

export async function guardarClaveLlavero(proveedor: string, clave: string): Promise<void> {
  if (enTauri()) await invoke("guardar_clave", { proveedor, clave });
}

export async function borrarClaveLlavero(proveedor: string): Promise<void> {
  if (enTauri()) await invoke("borrar_clave", { proveedor });
}

/** `undefined` en el navegador: no se puede saber. */
export async function hayClaveLlavero(proveedor: string): Promise<boolean | undefined> {
  if (!enTauri()) return undefined;
  return invoke<boolean>("hay_clave", { proveedor });
}
