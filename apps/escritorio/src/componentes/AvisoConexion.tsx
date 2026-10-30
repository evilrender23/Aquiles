import { Boton, Icono } from "@aquiles/ui";
import { useRef } from "react";
import { useAcciones, useEstado } from "../estado/almacen";

export function AvisoConexion() {
  const { conexion, errorConexion } = useEstado();
  const { reconectar } = useAcciones();
  // Tras una caída, el aviso sigue a la vista mientras se reintenta.
  const caida = useRef(false);
  if (conexion === "caida") caida.current = true;
  if (conexion === "conectada") caida.current = false;
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
