export type Moneda = "EUR" | "USD" | "GBP";

const SIMBOLOS: Record<Exclude<Moneda, "EUR">, string> = { USD: "$", GBP: "£" };

/**
 * Formatea un importe. EUR al estilo español (1.234,50 €); USD y GBP al estilo inglés con el
 * símbolo delante ($1,234.50).
 */
export function formatearPrecio(cantidad: number, moneda: Moneda = "EUR"): string {
  const [entero, decimales] = Math.abs(cantidad).toFixed(2).split(".");
  const signo = cantidad < 0 ? "-" : "";
  if (moneda === "EUR") {
    const conMiles = entero!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${signo}${conMiles},${decimales} €`;
  }
  const conMiles = entero!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${signo}${SIMBOLOS[moneda]}${conMiles}.${decimales}`;
}
