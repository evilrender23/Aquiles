import { calcularImpuesto, TIPOS_IVA, type TipoIva } from "./impuestos";
import { calcImporteLinea, type LineaFactura } from "./factura";

/** Cuota de IVA agrupada por tipo (solo los tipos que aparecen). */
export function cuotasPorTipo(lineas: LineaFactura[]): Partial<Record<TipoIva, number>> {
  const cuotas: Partial<Record<TipoIva, number>> = {};
  for (const l of lineas) {
    // calcularImpuesto redondea cada línea, igual que en la factura
    const cuota = calcularImpuesto(calcImporteLinea(l.precio, l.unidades), l.tipo);
    cuotas[l.tipo] = Math.round(((cuotas[l.tipo] ?? 0) + cuota) * 100) / 100;
  }
  return cuotas;
}

export function describirTipo(tipo: TipoIva): string {
  return `${tipo} (${Math.round(TIPOS_IVA[tipo] * 100)} %)`;
}
