export interface Venta {
  fecha: string;
  cliente: string;
  importe: number;
}

export interface Compra {
  fecha: string;
  proveedor: string;
  importe: number;
  iva: number;
}

export interface Devolucion {
  fecha: string;
  cliente: string;
  importe: number;
  motivo: string;
}

interface Fila {
  nombre: string;
  importe: number;
  extra?: string[];
}

const ANCHO = 44;

function columnaNombre(nombre: string): string {
  return nombre.length > 20 ? `${nombre.slice(0, 19)}…` : nombre.padEnd(20);
}

function informe<T extends { fecha: string }>(titulo: string, movimientos: T[], fila: (m: T) => Fila): string {
  const lineas = [`INFORME DE ${titulo.toUpperCase()}`, "=".repeat(ANCHO)];
  let total = 0;
  const ordenados = [...movimientos].sort((a, b) => a.fecha.localeCompare(b.fecha));
  for (const m of ordenados) {
    const f = fila(m);
    lineas.push(`${m.fecha}  ${columnaNombre(f.nombre)}${f.importe.toFixed(2).padStart(12)}`, ...(f.extra ?? []));
    total += f.importe;
  }
  lineas.push("-".repeat(ANCHO));
  lineas.push(`${"TOTAL".padEnd(32)}${total.toFixed(2).padStart(12)}`);
  lineas.push(`${ordenados.length} ${ordenados.length === 1 ? "movimiento" : "movimientos"}`);
  return lineas.join("\n");
}

export function informeVentas(ventas: Venta[], titulo = "VENTAS"): string {
  return informe(titulo, ventas, (v) => ({ nombre: v.cliente, importe: v.importe }));
}

export function informeCompras(compras: Compra[], titulo = "COMPRAS"): string {
  return informe(titulo, compras, (c) => ({ nombre: c.proveedor, importe: c.importe * (1 + c.iva) }));
}

export function informeDevoluciones(devoluciones: Devolucion[], titulo = "DEVOLUCIONES"): string {
  return informe(titulo, devoluciones, (d) => ({
    nombre: d.cliente,
    importe: -d.importe,
    extra: [`            motivo: ${d.motivo}`],
  }));
}
