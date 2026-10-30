import type { ModoAprobacion } from "@aquiles/protocolo";
import { CrystalizedBall, Etiqueta, GradientAscii, Titular } from "@aquiles/ui";
import { useMemo, useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { esfuerzoTrasCambio } from "../estado/esfuerzo";
import { carpetasRecientes } from "../estado/formato";
import { Compositor } from "./Compositor";
import { SelectorCarpeta, SelectorEsfuerzo, SelectorModelo, SelectorPermisos } from "./Selectores";

/** Nueva sesión: GradientASCII en lima detrás, el orbe y la caja para la primera instrucción. */
export function VistaInicio() {
  const { ajustes, proveedores, conexion, voz, sesiones } = useEstado();
  const { empezar, llamar } = useAcciones();
  // Lo elegido aquí vale solo para la sesión que se va a crear; por defecto, los ajustes.
  const [eleccion, setEleccion] = useState<{ cwd?: string; proveedor?: string; modelo?: string; esfuerzo?: string; modoAprobacion?: ModoAprobacion }>({});
  const [error, setError] = useState<string>();
  const proveedor = eleccion.proveedor ?? ajustes?.proveedor;
  const modelo = eleccion.proveedor ? eleccion.modelo : ajustes?.modelo;
  const esfuerzo = eleccion.esfuerzo ?? ajustes?.esfuerzo;
  const modo = eleccion.modoAprobacion ?? ajustes?.modoAprobacion;
  const carpeta = eleccion.cwd ?? ajustes?.carpeta;
  const recientes = useMemo(() => carpetasRecientes(Object.values(sesiones), ajustes?.carpeta), [sesiones, ajustes?.carpeta]);
  const listo = conexion === "conectada" && !!ajustes;

  return (
    <div className="inicio">
      <GradientAscii className="inicio__fondo" />
      <div className="inicio__contenido">
        <div className="inicio__orbe">
          <CrystalizedBall tamano={200} desnudo />
        </div>
        <div className="inicio__titulo">
          <Etiqueta>Nueva sesión</Etiqueta>
          <Titular texto="Dale una tarea" tamano="l" />
        </div>
        <Compositor
          etiqueta="Instrucción para Aquiles"
          placeholder="Describe qué quieres que haga"
          textoEnviar="Empezar"
          filas={3}
          deshabilitado={!listo}
          dictar={voz?.dictado ? async () => (await llamar("voz.dictar", {})).texto : undefined}
          alEnviar={async (texto, adjuntos) => {
            setError(undefined);
            try {
              await empezar({ texto, adjuntos, ...eleccion });
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              return false;
            }
          }}
          izquierda={
            proveedor && modo ? (
              <>
                {carpeta && <SelectorCarpeta carpeta={carpeta} recientes={recientes} alElegir={(c) => setEleccion((e) => ({ ...e, cwd: c }))} />}
                <SelectorModelo
                  proveedor={proveedor}
                  modelo={modelo}
                  proveedores={proveedores}
                  alineacion="izquierda"
                  alElegir={(p, m) => {
                    const nuevo = esfuerzoTrasCambio(proveedores, p, m, esfuerzo);
                    setEleccion((e) => ({ ...e, proveedor: p, modelo: m, ...(nuevo !== undefined ? { esfuerzo: nuevo } : {}) }));
                  }}
                />
                <SelectorEsfuerzo
                  proveedor={proveedor}
                  modelo={modelo}
                  esfuerzo={esfuerzo}
                  proveedores={proveedores}
                  alineacion="izquierda"
                  alElegir={(x) => setEleccion((e) => ({ ...e, esfuerzo: x }))}
                />
                <SelectorPermisos modo={modo} alElegir={(m) => setEleccion((e) => ({ ...e, modoAprobacion: m }))} />
              </>
            ) : undefined
          }
        />
        {error && (
          <p className="inicio__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
