import { Titular } from "@aquiles/ui";
import { useLayoutEffect, useRef } from "react";
import { estaTrabajando, useAcciones, useEstado } from "../estado/almacen";
import { conversacionVacia } from "../estado/conversacion";
import { Compositor } from "./Compositor";
import { Hilo } from "./Hilo";
import { TarjetaPermiso, TarjetaPregunta } from "./Peticiones";
import { MedidorContexto, SelectorModelo, SelectorPermisos } from "./Selectores";

/** Distancia al final por debajo de la cual el hilo sigue pegado abajo al llegar contenido. */
const PEGADO_PX = 120;

export function VistaConversacion({ sesionId }: { sesionId: string }) {
  const estado = useEstado();
  const { enviar, detener, ajustarSesion } = useAcciones();
  const sesion = estado.sesiones[sesionId];
  const conversacion = estado.conversaciones[sesionId] ?? conversacionVacia();
  const trabajando = estaTrabajando(estado, sesionId);
  const pendientes = estado.pendientes.filter((p) => p.sesionId === sesionId);
  const conectada = estado.conexion === "conectada";

  // App monta una vista por sesión (key), así que esto empieza pegado abajo en cada una.
  const desplazable = useRef<HTMLDivElement>(null);
  const pegado = useRef(true);

  // Sigue el contenido nuevo solo si el usuario no ha subido a leer. (Sin scrollIntoView ni nada devuelto.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: las dependencias son el disparador (llega contenido), no datos que se lean.
  useLayoutEffect(() => {
    const d = desplazable.current;
    if (d && pegado.current) d.scrollTop = d.scrollHeight;
  }, [conversacion.elementos, conversacion.pensandoDesde, pendientes.length]);

  if (!sesion) return null;

  return (
    <div className="conversacion">
      <section className="conversacion__principal">
        <div
          ref={desplazable}
          className="conversacion__desplazable"
          onScroll={(e) => {
            const d = e.currentTarget;
            pegado.current = d.scrollHeight - d.scrollTop - d.clientHeight < PEGADO_PX;
          }}
        >
          {sesion.titulo && (
            <header className="conversacion__cabecera">
              <Titular texto={sesion.titulo} tamano="m" />
            </header>
          )}
          {conversacion.cargando ? null : (
            <Hilo
              conversacion={conversacion}
              trabajando={trabajando}
              despues={pendientes.map((p) => (p.tipo === "aprobacion" ? <TarjetaPermiso key={p.id} p={p} /> : <TarjetaPregunta key={p.id} p={p} />))}
            />
          )}
        </div>

        <div className="conversacion__pie">
          <Compositor
            etiqueta="Mensaje para Aquiles"
            placeholder="Escribe una instrucción"
            textoEnviar="Enviar"
            deshabilitado={!conectada || conversacion.cargando}
            trabajando={trabajando}
            alEnviar={(t) => enviar(sesionId, t)}
            alDetener={() => detener(sesionId)}
            izquierda={
              <SelectorPermisos modo={sesion.modoAprobacion} deshabilitado={!conectada} alElegir={(modoAprobacion) => void ajustarSesion(sesionId, { modoAprobacion })} />
            }
            derecha={
              <>
                <span className="conversacion__contexto-compacto">
                  <MedidorContexto uso={conversacion.contexto} />
                </span>
                <SelectorModelo
                  proveedor={sesion.proveedor}
                  modelo={sesion.modelo}
                  proveedores={estado.proveedores}
                  deshabilitado={!conectada}
                  alElegir={(proveedor, modelo) => void ajustarSesion(sesionId, { proveedor, modelo: modelo ?? "" })}
                />
              </>
            }
          />
        </div>
      </section>

      {conversacion.contexto && (
        <aside className="conversacion__lateral" aria-label="Contexto de la sesión">
          <MedidorContexto uso={conversacion.contexto} grande />
        </aside>
      )}
    </div>
  );
}
