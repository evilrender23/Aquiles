export interface Producto {
  sku: string;
  nombre: string;
  precio: number;
  stock: number;
  etiquetas?: string[];
}

export function buscar(productos: Producto[], sku: string): Producto | undefined {
  return productos.find((p) => p.sku === sku);
}

export function valorStock(productos: Producto[]): number {
  return productos.reduce((total, p) => total + p.precio * p.stock, 0);
}

export function primeraEtiqueta(p: Producto): string {
  return p.etiquetas?.[0]?.toUpperCase() ?? "";
}

export function agruparPorEtiqueta(productos: Producto[]): Record<string, string[]> {
  const grupos: Record<string, string[]> = {};
  for (const p of productos) {
    for (const e of p.etiquetas ?? []) {
      (grupos[e] ??= []).push(p.sku);
    }
  }
  return grupos;
}

export function aplicarRebaja(p: Producto, porcentaje: number): Producto {
  return { ...p, precio: Math.round(p.precio * (1 - porcentaje / 100) * 100) / 100 };
}

export function estadoStock(p: Producto): "agotado" | "bajo" | "ok" {
  if (p.stock === 0) return "agotado";
  if (p.stock < 10) return "bajo";
  return "ok";
}
