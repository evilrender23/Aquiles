import { Boton, Icono, Titular, clases } from "@aquiles/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { estaTrabajando, useAcciones, useEstado } from "../estado/almacen";
import { type ArtefactosSesion, recogerArtefactos, renderizable } from "../estado/artefactos";
import { conversacionVacia } from "../estado/conversacion";
import { esfuerzoTrasCambio } from "../estado/esfuerzo";
import { ArtefactosHilo, type ContextoArtefactos, PanelArtefacto, type PestanaArtefacto } from "./Artefactos";
import { Compositor } from "./Compositor";
import { Hilo } from "./Hilo";
import { PanelObjetivo } from "./Objetivo";
import { TarjetaPermiso, TarjetaPregunta } from "./Peticiones";
import { PanelSubagentes, hijosDe } from "./PanelSubagentes";
import { MedidorContexto, SelectorEsfuerzo, SelectorModelo, SelectorPermisos } from "./Selectores";

/** Último pedido de «Objetivo…» atendido (la vista se monta con el pedido ya hecho). */
let ultimoObjetivo = 0;

/** Distancia al final por debajo de la cual el hilo sigue pegado abajo al llegar contenido. */
const PEGADO_PX = 120;

/** Artefacto abierto en el panel. Sin `version`, la última (y sigue a las que lleguen). */
interface PanelAbierto {
  id: string;
  version?: number;
  pestana: PestanaArtefacto;
  /** El usuario eligió pestaña: ya no se cambia sola a Vista al terminar. */
  manual: boolean;
}

/**
 * Panel de artefactos: se abre solo en Código cuando uno empieza a llegar en este turno y pasa a Vista al cerrarse
 * (si se puede ver y el usuario no ha tocado las pestañas).
 */
function usePanelArtefactos(artefactos: ArtefactosSesion) {
  const [panel, setPanel] = useState<PanelAbierto>();
  const vistos = useRef(new Set<string>());
  const seguido = useRef<string | undefined>(undefined);
  useEffect(() => {
    const vivo = artefactos.vivo;
    if (vivo && !vistos.current.has(vivo.clave)) {
      vistos.current.add(vivo.clave);
      seguido.current = vivo.clave;
      setPanel({ id: vivo.artefacto.id, pestana: "codigo", manual: false });
      return;
    }
    const clave = seguido.current;
    if (!clave || vivo?.clave === clave) return;
    seguido.current = undefined;
    const a = artefactos.porClave.get(clave)?.artefacto;
    if (a?.completo && renderizable(a.tipo)) setPanel((p) => (p && p.id === a.id && !p.manual ? { ...p, pestana: "vista" } : p));
  }, [artefactos]);
  return [panel, setPanel] as const;
}

export function VistaConversacion({ sesionId }: { sesionId: string }) {
  const estado = useEstado();
  const { enviar, detener, ajustarSesion, llamar } = useAcciones();
  const sesion = estado.sesiones[sesionId];
  const conversacion = estado.conversaciones[sesionId] ?? conversacionVacia();
  const trabajando = estaTrabajando(estado, sesionId);
  const pendientes = estado.pendientes.filter((p) => p.sesionId === sesionId);
  const conectada = estado.conexion === "conectada";
  const cwd = sesion?.cwd;
  const buscarFicheros = useCallback(async (consulta: string) => (cwd ? (await llamar("ficheros.buscar", { cwd, consulta })).ficheros : []), [cwd, llamar]);

  // App monta una vista por sesión (key), así que esto empieza pegado abajo en cada una.
  const desplazable = useRef<HTMLDivElement>(null);
  const pegado = useRef(true);
  const [editandoObjetivo, setEditandoObjetivo] = useState(false);
  // «Objetivo…» desde el menú de la sesión.
  const pedidoObjetivo = estado.pedidos.objetivo;
  useEffect(() => {
    if (pedidoObjetivo && pedidoObjetivo.sesionId === sesionId && pedidoObjetivo.n > ultimoObjetivo) {
      ultimoObjetivo = pedidoObjetivo.n;
      setEditandoObjetivo(true);
    }
  }, [pedidoObjetivo, sesionId]);

  // Sigue el contenido nuevo solo si el usuario no ha subido a leer. (Sin scrollIntoView ni nada devuelto.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: las dependencias son el disparador (llega contenido), no datos que se lean.
  useLayoutEffect(() => {
    const d = desplazable.current;
    if (d && pegado.current) d.scrollTop = d.scrollHeight;
  }, [conversacion.elementos, conversacion.pensandoDesde, pendientes.length]);

  const hayHijos = hijosDe(estado, sesionId).length > 0;

  const artefactos = useMemo(() => recogerArtefactos(conversacion.elementos), [conversacion.elementos]);
  const [panel, setPanel] = usePanelArtefactos(artefactos);
  const versiones = panel ? artefactos.porId.get(panel.id) : undefined;
  const indice = versiones ? Math.min(panel?.version ?? versiones.length - 1, versiones.length - 1) : 0;
  const ctxArtefactos = useMemo<ContextoArtefactos>(
    () => ({
      porElemento: artefactos.porElemento,
      abierto: panel && versiones ? { id: panel.id, version: indice } : undefined,
      abrir: (id, version) => {
        const todas = artefactos.porId.get(id) ?? [];
        const a = todas[version];
        setPanel({ id, version: version === todas.length - 1 ? undefined : version, pestana: a?.completo && renderizable(a.tipo) ? "vista" : "codigo", manual: false });
      },
    }),
    [artefactos, panel, versiones, indice, setPanel],
  );
  const conPanel = !!(panel && versiones?.length);

  if (!sesion) return null;

  const elegirModelo = (proveedor: string, modelo: string | undefined) => {
    const esfuerzo = esfuerzoTrasCambio(estado.proveedores, proveedor, modelo, sesion.esfuerzo);
    void ajustarSesion(sesionId, { proveedor, modelo: modelo ?? "", ...(esfuerzo !== undefined ? { esfuerzo } : {}) });
  };

  return (
    <div className={clases("conversacion", conPanel && "conversacion--artefacto")}>
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
            <ArtefactosHilo.Provider value={ctxArtefactos}>
              <Hilo
                sesionId={sesionId}
                cwd={sesion.cwd}
                conversacion={conversacion}
                trabajando={trabajando}
                despues={pendientes.map((p) => (p.tipo === "aprobacion" ? <TarjetaPermiso key={p.id} p={p} /> : <TarjetaPregunta key={p.id} p={p} />))}
              />
            </ArtefactosHilo.Provider>
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
            insercion={estado.pedidos.caja}
            etiqueta="Mensaje para Aquiles"
            placeholder="Escribe una instrucción"
            textoEnviar="Enviar"
            buscarFicheros={buscarFicheros}
            deshabilitado={!conectada || conversacion.cargando}
            trabajando={trabajando}
            alEnviar={(t, adjuntos) => enviar(sesionId, t, adjuntos)}
            adjuntosPermitidos={!trabajando && !pendientes.some((p) => p.tipo === "pregunta")}
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
                <SelectorModelo proveedor={sesion.proveedor} modelo={sesion.modelo} proveedores={estado.proveedores} deshabilitado={!conectada} alElegir={elegirModelo} />
                <SelectorEsfuerzo
                  proveedor={sesion.proveedor}
                  modelo={sesion.modelo}
                  esfuerzo={sesion.esfuerzo}
                  proveedores={estado.proveedores}
                  deshabilitado={!conectada}
                  alElegir={(esfuerzo) => void ajustarSesion(sesionId, { esfuerzo })}
                />
              </>
            }
          />
        </div>
      </section>

      {conPanel && panel && versiones ? (
        <PanelArtefacto
          key={panel.id}
          sesionId={sesionId}
          versiones={versiones}
          indice={indice}
          pestana={panel.pestana}
          alVersion={(i) => setPanel({ ...panel, version: i === versiones.length - 1 ? undefined : i })}
          alPestana={(pestana) => setPanel({ ...panel, pestana, manual: true })}
          alCerrar={() => setPanel(undefined)}
        />
      ) : (conversacion.contexto || hayHijos) && (
        <aside className="conversacion__lateral" aria-label="Contexto de la sesión">
          <MedidorContexto uso={conversacion.contexto} grande />
          <PanelSubagentes sesionId={sesionId} />
        </aside>
      )}
    </div>
  );
}
