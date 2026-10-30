/** Formatea un importe en euros al estilo español: 1.234,50 € */
export function formatearPrecio(cantidad: number): string {
  const [entero, decimales] = Math.abs(cantidad).toFixed(2).split(".");
  const conMiles = entero!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${cantidad < 0 ? "-" : ""}${conMiles},${decimales} €`;
}
