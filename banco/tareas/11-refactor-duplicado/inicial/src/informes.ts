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

export function informeVentas(ventas: Venta[], titulo = "VENTAS"): string {
  const lineas: string[] = [];
  lineas.push(`INFORME DE ${titulo.toUpperCase()}`);
  lineas.push("=".repeat(44));
  let total = 0;
  const ordenadas = [...ventas].sort((a, b) => a.fecha.localeCompare(b.fecha));
  for (const v of ordenadas) {
    const nombre = v.cliente.length > 20 ? `${v.cliente.slice(0, 19)}…` : v.cliente.padEnd(20);
    lineas.push(`${v.fecha}  ${nombre}${v.importe.toFixed(2).padStart(12)}`);
    total += v.importe;
  }
  lineas.push("-".repeat(44));
  lineas.push(`${"TOTAL".padEnd(32)}${total.toFixed(2).padStart(12)}`);
  lineas.push(`${ordenadas.length} ${ordenadas.length === 1 ? "movimiento" : "movimientos"}`);
  return lineas.join("\n");
}

export function informeCompras(compras: Compra[], titulo = "COMPRAS"): string {
  const lineas: string[] = [];
  lineas.push(`INFORME DE ${titulo.toUpperCase()}`);
  lineas.push("=".repeat(44));
  let total = 0;
  const ordenadas = [...compras].sort((a, b) => a.fecha.localeCompare(b.fecha));
  for (const c of ordenadas) {
    const nombre = c.proveedor.length > 20 ? `${c.proveedor.slice(0, 19)}…` : c.proveedor.padEnd(20);
    const importe = c.importe * (1 + c.iva);
    lineas.push(`${c.fecha}  ${nombre}${importe.toFixed(2).padStart(12)}`);
    total += importe;
  }
  lineas.push("-".repeat(44));
  lineas.push(`${"TOTAL".padEnd(32)}${total.toFixed(2).padStart(12)}`);
  lineas.push(`${ordenadas.length} ${ordenadas.length === 1 ? "movimiento" : "movimientos"}`);
  return lineas.join("\n");
}

export function informeDevoluciones(devoluciones: Devolucion[], titulo = "DEVOLUCIONES"): string {
  const lineas: string[] = [];
  lineas.push(`INFORME DE ${titulo.toUpperCase()}`);
  lineas.push("=".repeat(44));
  let total = 0;
  const ordenadas = [...devoluciones].sort((a, b) => a.fecha.localeCompare(b.fecha));
  for (const d of ordenadas) {
    const nombre = d.cliente.length > 20 ? `${d.cliente.slice(0, 19)}…` : d.cliente.padEnd(20);
    lineas.push(`${d.fecha}  ${nombre}${(-d.importe).toFixed(2).padStart(12)}`);
    lineas.push(`            motivo: ${d.motivo}`);
    total -= d.importe;
  }
  lineas.push("-".repeat(44));
  lineas.push(`${"TOTAL".padEnd(32)}${total.toFixed(2).padStart(12)}`);
  lineas.push(`${ordenadas.length} ${ordenadas.length === 1 ? "movimiento" : "movimientos"}`);
  return lineas.join("\n");
}
