import { formatearFecha } from "../util";
import type { Pedido } from "../pedidos";

/** Exportación XML para el ERP antiguo (dado de baja en 2024). */
export function exportarXml(pedidos: Pedido[]): string {
  const filas = pedidos.map((p) => `  <pedido cliente="${p.cliente}" fecha="${formatearFecha(p.fecha)}" base="${p.base}"/>`);
  return `<pedidos>\n${filas.join("\n")}\n</pedidos>`;
}
