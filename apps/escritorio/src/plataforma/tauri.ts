/** Dentro de la app de escritorio (Tauri) o en un navegador (desarrollo). */
export const enTauri = (): boolean => "__TAURI_INTERNALS__" in window;
