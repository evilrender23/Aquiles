/** Avisos del núcleo (`notificacion`) dentro de la app: en el navegador, o en la app si el sistema no deja notificar. */
import { BotonIcono, Tarjeta } from "@aquiles/ui";
import { useEffect } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import type { Notificacion } from "../estado/tipos";
import { alPulsarNotificacion } from "../plataforma/notificaciones";

const DURACION_MS = 8000;

export function Notificaciones() {
  const { notificaciones } = useEstado();
  const { abrirSesion } = useAcciones();

  // Pulsar una notificación del sistema (Tauri) también abre su sesión.
  useEffect(() => alPulsarNotificacion(abrirSesion), [abrirSesion]);

  return (
    <section className="avisos" aria-live="polite" aria-label="Notificaciones">
      {notificaciones.map((n) => (
        <AvisoFlotante key={n.id} n={n} />
      ))}
    </section>
  );
}

function AvisoFlotante({ n }: { n: Notificacion }) {
  const { cerrarNotificacion, abrirSesion } = useAcciones();
  useEffect(() => {
    const t = setTimeout(() => cerrarNotificacion(n.id), DURACION_MS);
    return () => clearTimeout(t);
  }, [n.id, cerrarNotificacion]);

  const contenido = (
    <>
      <span className="aviso-flotante__titulo">{n.titulo}</span>
      <span className="aviso-flotante__texto">{n.texto}</span>
    </>
  );
  return (
    <Tarjeta className="aviso-flotante" role="status">
      {n.sesionId ? (
        <button
          type="button"
          className="aviso-flotante__cuerpo"
          onClick={() => {
            abrirSesion(n.sesionId!);
            cerrarNotificacion(n.id);
          }}
        >
          {contenido}
        </button>
      ) : (
        <div className="aviso-flotante__cuerpo">{contenido}</div>
      )}
      <BotonIcono variante="pequeno" etiqueta="Cerrar" icono="cerrar" tamanoIcono={14} onClick={() => cerrarNotificacion(n.id)} />
    </Tarjeta>
  );
}
