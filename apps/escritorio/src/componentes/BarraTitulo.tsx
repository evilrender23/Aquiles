import { BotonIcono } from "@aquiles/ui";
import { alternarMaximizar, cerrarVentana, esMac, minimizar, useMaximizada } from "../plataforma/ventana";

/** Barra de título propia (la ventana va sin decoraciones). Todo lo que no es botón arrastra la ventana. */
export function BarraTitulo({ ruta, alMenu }: { ruta?: string; alMenu: () => void }) {
  return (
    <header className="barra-titulo" data-tauri-drag-region>
      <BotonIcono className="barra-titulo__menu" variante="ventana" etiqueta="Barra lateral" icono="menu" onClick={alMenu} />
      <span className="barra-titulo__ruta" data-tauri-drag-region title={ruta}>
        {ruta}
      </span>
      <div className="barra-titulo__hueco" data-tauri-drag-region />
      {!esMac && <BotonesVentana />}
    </header>
  );
}

function BotonesVentana() {
  const maximizada = useMaximizada();
  return (
    <>
      <BotonIcono variante="ventana" etiqueta="Minimizar" icono="menos" onClick={() => void minimizar()} />
      <BotonIcono
        variante="ventana"
        etiqueta={maximizada ? "Restaurar" : "Maximizar"}
        icono={maximizada ? "restaurar" : "maximizar"}
        tamanoIcono={14}
        onClick={() => void alternarMaximizar()}
      />
      <BotonIcono variante="ventana" etiqueta="Cerrar" icono="cerrar" onClick={() => void cerrarVentana()} />
    </>
  );
}
