import { calcImp, type TipoIva } from "./impuestos";

export interface LineaFactura {
  concepto: string;
  precio: number;
  unidades: number;
  tipo: TipoIva;
}

/** Base imponible de una línea. */
export function calcImporteLinea(precio: number, unidades: number): number {
  return Math.round(precio * unidades * 100) / 100;
}

export function totalesFactura(lineas: LineaFactura[]) {
  let base = 0;
  let cuota = 0;
  for (const l of lineas) {
    const importe = calcImporteLinea(l.precio, l.unidades);
    base += importe;
    cuota += calcImp(importe, l.tipo);
  }
  return { base: redondear(base), cuota: redondear(cuota), total: redondear(base + cuota) };
}

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}
