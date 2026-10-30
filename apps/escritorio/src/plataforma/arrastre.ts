/**
 * Ficheros arrastrados a la ventana. En la app de escritorio el WebView se queda los ficheros soltados
 * (dragDropEnabled) y avisa con sus rutas; en el navegador no hace nada (ahí van los eventos HTML5).
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { enTauri } from "./tauri";

export function alArrastrarFicheros(f: { entrar: () => void; salir: () => void; soltar: (rutas: string[]) => void }): () => void {
  if (!enTauri()) return () => {};
  let vivo = true;
  let soltar: (() => void) | undefined;
  getCurrentWebview()
    .onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter") f.entrar();
      else if (p.type === "leave") f.salir();
      else if (p.type === "drop") f.soltar(p.paths);
    })
    .then(
      (s) => (vivo ? (soltar = s) : s()),
      () => {},
    );
  return () => {
    vivo = false;
    soltar?.();
  };
}
