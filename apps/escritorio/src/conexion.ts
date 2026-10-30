import { invoke } from "@tauri-apps/api/core";

export interface DatosConexion {
  /** p. ej. ws://127.0.0.1:51234 */
  url: string;
  token: string;
}

/**
 * Dentro de la app, Tauri arranca el núcleo y entrega URL y token.
 * En un navegador (desarrollo) se pasan en la URL: ?ws=ws://127.0.0.1:N&token=T
 */
export async function datosConexion(): Promise<DatosConexion> {
  if ("__TAURI_INTERNALS__" in window) return invoke<DatosConexion>("conexion_nucleo");
  const q = new URLSearchParams(location.search);
  const url = q.get("ws");
  const token = q.get("token");
  if (!url || !token) throw new Error("Fuera de la app hay que abrir la página con ?ws=…&token=…");
  return { url, token };
}
