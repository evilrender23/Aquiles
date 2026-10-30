import { Boton, Icono } from "@aquiles/ui";
import { useRef } from "react";
import { useAcciones, useEstado } from "../estado/almacen";

export function AvisoConexion() {
  const { conexion, errorConexion } = useEstado();
  const { reconectar } = useAcciones();
  // Tras una caída, el aviso sigue a la vista mientras se reintenta.
  const caida = useRef(false);
  if (conexion === "caida") caida.current = true;
  if (conexion === "conectada" || conexion === "reiniciando") caida.current = false;

  // Un reinicio pedido (perfil, copia, núcleo remoto) no es un error: aviso neutro hasta que vuelve.
  if (conexion === "reiniciando") {
    return (
      <div className="aviso-conexion aviso-conexion--reinicio" role="status">
        <i className="nx-punto nx-pulso" aria-hidden="true" />
        <span className="aviso-conexion__texto">{errorConexion ? `Reiniciando el núcleo · ${errorConexion}` : "Reiniciando el núcleo"}</span>
      </div>
    );
  }
  if (!caida.current) return null;
  const reintentando = conexion === "conectando";
  return (
    <div className="aviso-conexion" role="alert">
      <Icono nombre="alerta" tamano={18} />
      <span className="aviso-conexion__texto">{reintentando ? "Conectando…" : (errorConexion ?? "Sin conexión con el núcleo")}</span>
      <Boton variante="secundario" icono="recargar" disabled={reintentando} onClick={reconectar}>
        Reconectar
      </Boton>
    </div>
  );
}
