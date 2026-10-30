import { Boton, Icono, Titular } from "@aquiles/ui";
import { useLayoutEffect, useRef, useState } from "react";
import { estaTrabajando, useAcciones, useEstado } from "../estado/almacen";
import { conversacionVacia } from "../estado/conversacion";
import { Compositor } from "./Compositor";
import { Hilo } from "./Hilo";
import { PanelObjetivo } from "./Objetivo";
import { TarjetaPermiso, TarjetaPregunta } from "./Peticiones";
import { PanelSubagentes, hijosDe } from "./PanelSubagentes";
import { MedidorContexto, SelectorModelo, SelectorPermisos } from "./Selectores";

/** Distancia al final por debajo de la cual el hilo sigue pegado abajo al llegar contenido. */
const PEGADO_PX = 120;

export function VistaConversacion({ sesionId }: { sesionId: string }) {
  const estado = useEstado();
  const { enviar, detener, ajustarSesion, llamar } = useAcciones();
  const sesion = estado.sesiones[sesionId];
  const conversacion = estado.conversaciones[sesionId] ?? conversacionVacia();
  const trabajando = estaTrabajando(estado, sesionId);
  const pendientes = estado.pendientes.filter((p) => p.sesionId === sesionId);
  const conectada = estado.conexion === "conectada";

  // App monta una vista por sesión (key), así que esto empieza pegado abajo en cada una.
  const desplazable = useRef<HTMLDivElement>(null);
  const pegado = useRef(true);
  const [editandoObjetivo, setEditandoObjetivo] = useState(false);

  // Sigue el contenido nuevo solo si el usuario no ha subido a leer. (Sin scrollIntoView ni nada devuelto.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: las dependencias son el disparador (llega contenido), no datos que se lean.
  useLayoutEffect(() => {
    const d = desplazable.current;
    if (d && pegado.current) d.scrollTop = d.scrollHeight;
  }, [conversacion.elementos, conversacion.pensandoDesde, pendientes.length]);

  const hayHijos = hijosDe(estado, sesionId).length > 0;

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
          {sesion.interrumpida && !trabajando && (
            <div className="interrumpida" role="status">
              <Icono nombre="pausa" tamano={16} />
              <span className="interrumpida__texto">Interrumpida</span>
              <Boton variante="acento" tamano="pequeno" disabled={!conectada} onClick={() => void enviar(sesionId, "Continúa donde lo dejaste.")}>
                Continuar
              </Boton>
            </div>
          )}
          <PanelObjetivo sesion={sesion} editando={editandoObjetivo} alEditar={setEditandoObjetivo} />
          <div className="conversacion__subagentes-compacto">
            <PanelSubagentes sesionId={sesionId} compacto />
          </div>
          <Compositor
            dictar={estado.voz?.dictado ? async () => (await llamar("voz.dictar", {})).texto : undefined}
            etiqueta="Mensaje para Aquiles"
            placeholder="Escribe una instrucción"
            textoEnviar="Enviar"
            deshabilitado={!conectada || conversacion.cargando}
            trabajando={trabajando}
            alEnviar={(t) => enviar(sesionId, t)}
            alDetener={() => detener(sesionId)}
            izquierda={
              <>
                <SelectorPermisos modo={sesion.modoAprobacion} deshabilitado={!conectada} alElegir={(modoAprobacion) => void ajustarSesion(sesionId, { modoAprobacion })} />
                {!sesion.objetivo && !editandoObjetivo && (
                  <Boton variante="chip" icono="diana" disabled={!conectada} onClick={() => setEditandoObjetivo(true)}>
                    Objetivo
                  </Boton>
                )}
              </>
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

      {(conversacion.contexto || hayHijos) && (
        <aside className="conversacion__lateral" aria-label="Contexto de la sesión">
          <MedidorContexto uso={conversacion.contexto} grande />
          <PanelSubagentes sesionId={sesionId} />
        </aside>
      )}
    </div>
  );
}
