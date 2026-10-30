import { formatearPrecio } from "./formato";

export interface LineaTicket {
  concepto: string;
  precio: number;
  cantidad: number;
}

export function lineaTicket(l: LineaTicket): string {
  return `${String(l.cantidad).padStart(3)} x ${l.concepto.padEnd(20)}${formatearPrecio(l.precio * l.cantidad).padStart(14)}`;
}

export function generarTicket(lineas: LineaTicket[]): string {
  const total = lineas.reduce((s, l) => s + l.precio * l.cantidad, 0);
  return [
    ...lineas.map(lineaTicket),
    "-".repeat(40),
    `TOTAL${formatearPrecio(total).padStart(35)}`,
  ].join("\n");
}
