import { CATALOGO } from "./datos";
import { aplicarRebaja, estadoStock, valorStock, type Producto } from "./inventario";

export function rebajasDeVerano(productos: Producto[] = CATALOGO): Producto[] {
  return productos.map((p) => (p.etiquetas?.includes("oferta") ? aplicarRebaja(p, 20) : p));
}

export function resumen(productos: Producto[] = CATALOGO): string[] {
  const lineas = productos.map((p) => `${p.sku} ${p.nombre}: ${estadoStock(p)}`);
  lineas.push(`Valor total: ${valorStock(productos).toFixed(2)}`);
  return lineas;
}
