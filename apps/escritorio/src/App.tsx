import { clases } from "@aquiles/ui";
import { useState } from "react";
import { AvisoConexion } from "./componentes/AvisoConexion";
import { BarraLateral } from "./componentes/BarraLateral";
import { BarraTitulo } from "./componentes/BarraTitulo";
import { VistaAjustes } from "./componentes/VistaAjustes";
import { VistaConversacion } from "./componentes/VistaConversacion";
import { VistaInicio } from "./componentes/VistaInicio";
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
  const ruta = estado.vista === "conversacion" ? sesion?.cwd : estado.vista === "inicio" ? estado.ajustes?.carpeta : undefined;

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
