import { open } from "@tauri-apps/plugin-dialog";

/** Selector de carpeta nativo. Devuelve null si se cancela. Solo dentro de Tauri. */
export async function elegirCarpeta(actual?: string): Promise<string | null> {
  const r = await open({ directory: true, multiple: false, ...(actual ? { defaultPath: actual } : {}) });
  return typeof r === "string" ? r : null;
}
