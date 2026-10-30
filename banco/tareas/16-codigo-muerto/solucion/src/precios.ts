const IVA = 0.21;

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}

export function precioConIva(base: number): number {
  return redondear(base * (1 + IVA));
}

/** Aplica un descuento en porcentaje; nunca baja de 0. */
export function aplicarDescuento(precio: number, porcentaje: number): number {
  const pct = Math.min(Math.max(porcentaje, 0), 100);
  return redondear(precio * (1 - pct / 100));
}
