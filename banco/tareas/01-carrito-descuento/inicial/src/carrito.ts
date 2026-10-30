export interface Linea {
  producto: string;
  /** Euros por unidad. */
  precio: number;
  cantidad: number;
}

/** Suma bruta del carrito: precio × cantidad de cada línea. */
export function subtotal(lineas: Linea[]): number {
  return lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
}

/**
 * Total a pagar: aplica un descuento en porcentaje (0–100) al subtotal, añade el envío
 * y redondea a céntimos. Los pedidos de 50 € o más (ya con el descuento) no pagan envío;
 * el resto paga 4,95 €. Un carrito vacío cuesta 0.
 */
export function total(lineas: Linea[], descuentoPct = 0): number {
  if (lineas.length === 0) return 0;
  const conDescuento = subtotal(lineas) - descuentoPct;
  const envio = conDescuento > 50 ? 0 : ENVIO;
  return redondear(conDescuento + envio);
}

const ENVIO = 4.95;

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}
