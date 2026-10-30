import { ProveedorMenuContextual, clases } from "@aquiles/ui";
import { useEffect, useState, type ReactNode } from "react";
import { AvisoConexion } from "./componentes/AvisoConexion";
import { BarraLateral } from "./componentes/BarraLateral";
import { BarraTitulo } from "./componentes/BarraTitulo";
import { Notificaciones } from "./componentes/Notificaciones";
import { VistaAjustes } from "./componentes/VistaAjustes";
import { VistaAutomatizaciones } from "./componentes/VistaAutomatizaciones";
import { VistaEstadisticas } from "./componentes/VistaEstadisticas";
import { VistaConversacion } from "./componentes/VistaConversacion";
import { VistaHabilidades } from "./componentes/VistaHabilidades";
import { VistaInicio } from "./componentes/VistaInicio";
import { VistaMemoria } from "./componentes/VistaMemoria";
import { ProveedorApp, useAcciones, useEstado } from "./estado/almacen";
import { esMac } from "./plataforma/ventana";

export function App() {
  return (
    <ProveedorApp>
      <Menus>
        <Marco />
      </Menus>
    </ProveedorApp>
  );
}

/** Menús contextuales de toda la app; una selección suelta también se puede buscar en las conversaciones. */
function Menus({ children }: { children: ReactNode }) {
  const { buscarEnConversaciones } = useAcciones();
  return (
    <ProveedorMenuContextual seleccion={(texto) => [{ texto: "Buscar en conversaciones", icono: "buscar", alElegir: () => buscarEnConversaciones(texto) }]}>
      {children}
    </ProveedorMenuContextual>
  );
}

function Marco() {
  const estado = useEstado();
  // En ventanas estrechas la barra lateral se superpone y se abre desde la barra de título.
  const [lateralAbierta, setLateralAbierta] = useState(false);
  // Buscar desde un menú: en ventanas estrechas la barra lateral está escondida y hay que sacarla.
  const busqueda = estado.pedidos.busqueda?.n;
  useEffect(() => {
    if (busqueda) setLateralAbierta(true);
  }, [busqueda]);
  const sesion = estado.activa ? estado.sesiones[estado.activa] : undefined;
  // En Habilidades y Memoria, la carpeta de la sesión activa es la del proyecto que se muestra.
  const ruta = estado.vista === "inicio" ? estado.ajustes?.carpeta : estado.vista === "ajustes" || estado.vista === "automatizaciones" || estado.vista === "estadisticas" ? undefined : sesion?.cwd;

  return (
    <div className={clases("app", lateralAbierta && "app--lateral-abierta", esMac && "app--mac")}>
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
          ) : estado.vista === "automatizaciones" ? (
            <VistaAutomatizaciones />
          ) : estado.vista === "estadisticas" ? (
            <VistaEstadisticas />
          ) : estado.vista === "conversacion" && estado.activa ? (
            <VistaConversacion key={estado.activa} sesionId={estado.activa} />
          ) : (
            <VistaInicio />
          )}
        </main>
      </div>
      <Notificaciones />
    </div>
  );
}
