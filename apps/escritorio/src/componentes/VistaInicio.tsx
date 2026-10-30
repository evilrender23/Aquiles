import type { ModoAprobacion } from "@aquiles/protocolo";
import { CrystalizedBall, Etiqueta, GradientAscii, Titular } from "@aquiles/ui";
import { useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { Compositor } from "./Compositor";
import { SelectorModelo, SelectorPermisos } from "./Selectores";

/** Nueva sesión: GradientASCII en lima detrás, el orbe y la caja para la primera instrucción. */
export function VistaInicio() {
  const { ajustes, proveedores, conexion, voz } = useEstado();
  const { empezar, llamar } = useAcciones();
  // Lo elegido aquí vale solo para la sesión que se va a crear; por defecto, los ajustes.
  const [eleccion, setEleccion] = useState<{ proveedor?: string; modelo?: string; modoAprobacion?: ModoAprobacion }>({});
  const [error, setError] = useState<string>();
  const proveedor = eleccion.proveedor ?? ajustes?.proveedor;
  const modelo = eleccion.proveedor ? eleccion.modelo : ajustes?.modelo;
  const modo = eleccion.modoAprobacion ?? ajustes?.modoAprobacion;
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
          alEnviar={async (texto) => {
            setError(undefined);
            try {
              await empezar({ texto, ...eleccion });
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
          izquierda={
            proveedor && modo ? (
              <>
                <SelectorModelo
                  proveedor={proveedor}
                  modelo={modelo}
                  proveedores={proveedores}
                  alineacion="izquierda"
                  alElegir={(p, m) => setEleccion((e) => ({ ...e, proveedor: p, modelo: m }))}
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
