/** Controles de la ventana sin decoraciones. En el navegador no hacen nada. */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { enTauri } from "./tauri";

export const minimizar = () => (enTauri() ? getCurrentWindow().minimize() : Promise.resolve());
export const alternarMaximizar = () => (enTauri() ? getCurrentWindow().toggleMaximize() : Promise.resolve());
export const cerrarVentana = () => (enTauri() ? getCurrentWindow().close() : Promise.resolve());

/** Si la ventana está maximizada (para el icono de maximizar / restaurar). */
export function useMaximizada(): boolean {
  const [maximizada, setMaximizada] = useState(false);
  useEffect(() => {
    if (!enTauri()) return;
    const v = getCurrentWindow();
    let vivo = true;
    let soltar: (() => void) | undefined;
    const leer = () => void v.isMaximized().then((m) => vivo && setMaximizada(m), () => {});
    leer();
    v.onResized(leer).then(
      (f) => (vivo ? (soltar = f) : f()),
      () => {},
    );
    return () => {
      vivo = false;
      soltar?.();
    };
  }, []);
  return maximizada;
}
