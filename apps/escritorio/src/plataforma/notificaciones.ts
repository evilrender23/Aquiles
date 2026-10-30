/**
 * Notificaciones del sistema (plugin de Tauri). En el navegador no hacen nada y la app pinta su propio aviso.
 * Al pulsar una se abre su sesión: el plugin avisa de la pulsación con `onAction` (`tap`).
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, onAction, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { enTauri } from "./tauri";

let siguiente = 1;
/** id de la notificación → sesión que abre. */
const sesiones = new Map<number, string>();

/** true si se mostró como notificación del sistema. */
export async function notificarSistema(n: { titulo: string; texto: string; sesionId?: string }): Promise<boolean> {
  if (!enTauri()) return false;
  try {
    let permiso = await isPermissionGranted();
    if (!permiso) permiso = (await requestPermission()) === "granted";
    if (!permiso) return false;
    const id = siguiente++;
    if (n.sesionId) sesiones.set(id, n.sesionId);
    sendNotification({ id, title: n.titulo, body: n.texto, ...(n.sesionId ? { extra: { sesionId: n.sesionId } } : {}) });
    return true;
  } catch {
    return false;
  }
}

/** Escucha las pulsaciones en las notificaciones del sistema; devuelve cómo dejar de escuchar. */
export function alPulsarNotificacion(abrir: (sesionId: string) => void): () => void {
  if (!enTauri()) return () => {};
  let vivo = true;
  let soltar: (() => void) | undefined;
  onAction((e) => {
    if (e.actionId !== "tap" || !e.notification) return;
    const extra = e.notification.extra?.sesionId;
    const sesionId = sesiones.get(e.notification.id) ?? (typeof extra === "string" ? extra : undefined);
    if (!sesionId) return;
    abrir(sesionId);
    void getCurrentWindow()
      .setFocus()
      .catch(() => {});
  }).then(
    (l) => (vivo ? (soltar = () => void l.unregister()) : void l.unregister()),
    () => {},
  );
  return () => {
    vivo = false;
    soltar?.();
  };
}
