import { formatearPrecio, type Moneda } from "./formato";

export interface LineaTicket {
  concepto: string;
  precio: number;
  cantidad: number;
}

export function lineaTicket(l: LineaTicket, moneda: Moneda = "EUR"): string {
  return `${String(l.cantidad).padStart(3)} x ${l.concepto.padEnd(20)}${formatearPrecio(l.precio * l.cantidad, moneda).padStart(14)}`;
}

export function generarTicket(lineas: LineaTicket[], moneda: Moneda = "EUR"): string {
  const total = lineas.reduce((s, l) => s + l.precio * l.cantidad, 0);
  return [
    ...lineas.map((l) => lineaTicket(l, moneda)),
    "-".repeat(40),
    `TOTAL${formatearPrecio(total, moneda).padStart(35)}`,
  ].join("\n");
}
