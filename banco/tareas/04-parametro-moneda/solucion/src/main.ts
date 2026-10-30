import type { Moneda } from "./formato";
import { generarTicket } from "./ticket";

const moneda = (process.argv[2] ?? "EUR") as Moneda;

console.log(
  generarTicket(
    [
      { concepto: "Café", precio: 1.4, cantidad: 2 },
      { concepto: "Tostada", precio: 2.25, cantidad: 1 },
      { concepto: "Cafetera", precio: 1299, cantidad: 1 },
    ],
    moneda,
  ),
);
