import { clases } from "@aquiles/ui";
import { useState } from "react";
import { AvisoConexion } from "./componentes/AvisoConexion";
import { BarraLateral } from "./componentes/BarraLateral";
import { BarraTitulo } from "./componentes/BarraTitulo";
import { VistaAjustes } from "./componentes/VistaAjustes";
import { VistaConversacion } from "./componentes/VistaConversacion";
import { VistaHabilidades } from "./componentes/VistaHabilidades";
import { VistaInicio } from "./componentes/VistaInicio";
import { VistaMemoria } from "./componentes/VistaMemoria";
import { ProveedorApp, useEstado } from "./estado/almacen";

export function App() {
  return (
    <ProveedorApp>
      <Marco />
    </ProveedorApp>
  );
}

function Marco() {
  const estado = useEstado();
  // En ventanas estrechas la barra lateral se superpone y se abre desde la barra de título.
  const [lateralAbierta, setLateralAbierta] = useState(false);
  const sesion = estado.activa ? estado.sesiones[estado.activa] : undefined;
  // En Habilidades y Memoria, la carpeta de la sesión activa es la del proyecto que se muestra.
  const ruta = estado.vista === "inicio" ? estado.ajustes?.carpeta : estado.vista === "ajustes" ? undefined : sesion?.cwd;

  return (
    <div className={clases("app", lateralAbierta && "app--lateral-abierta")}>
      <BarraLateral alElegir={() => setLateralAbierta(false)} />
      <div className="app__velo" aria-hidden="true" onClick={() => setLateralAbierta(false)} />
      <div className="app__columna">
        <BarraTitulo ruta={ruta} alMenu={() => setLateralAbierta((a) => !a)} />
        <AvisoConexion />
        <main className="app__vista">
          {estado.vista === "ajustes" ? (
            <VistaAjustes />
          ) : estado.vista === "habilidades" ? (
            <VistaHabilidades />
          ) : estado.vista === "memoria" ? (
            <VistaMemoria />
          ) : estado.vista === "conversacion" && estado.activa ? (
            <VistaConversacion key={estado.activa} sesionId={estado.activa} />
          ) : (
            <VistaInicio />
          )}
        </main>
      </div>
    </div>
  );
}
