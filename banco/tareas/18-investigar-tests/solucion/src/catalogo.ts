import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Producto {
  sku: string;
  nombre: string;
  /** Euros. */
  precio: number;
  categorias: string[];
  activo: boolean;
}

/** Producto tal como llega en la exportación del ERP (formato 2). */
interface ProductoErp {
  sku: string;
  nombre: string;
  precio_centimos: number;
  /** Separadas por `|`. */
  categorias: string;
  activo: "sí" | "no";
}

const RUTA_POR_DEFECTO = fileURLToPath(new URL("../datos/catalogo.json", import.meta.url));

/** Lee la exportación del ERP y la convierte en productos. */
export function cargarCatalogo(ruta = RUTA_POR_DEFECTO): Producto[] {
  const datos = JSON.parse(readFileSync(ruta, "utf8")) as { productos: ProductoErp[] };
  return datos.productos.map((p) => ({
    sku: p.sku,
    nombre: p.nombre,
    precio: p.precio_centimos / 100,
    categorias: p.categorias.split("|").filter(Boolean),
    activo: p.activo === "sí",
  }));
}

export function productosActivos(catalogo: Producto[]): Producto[] {
  return catalogo.filter((p) => p.activo);
}

/** Precio medio (redondeado a céntimos) de los productos activos de una categoría; 0 si no hay ninguno. */
export function precioMedio(catalogo: Producto[], categoria: string): number {
  const deLaCategoria = productosActivos(catalogo).filter((p) => p.categorias.includes(categoria));
  if (deLaCategoria.length === 0) return 0;
  const suma = deLaCategoria.reduce((s, p) => s + p.precio, 0);
  return Math.round((suma / deLaCategoria.length) * 100) / 100;
}

/** Los `n` productos activos más caros, de más a menos caro. */
export function masCaros(catalogo: Producto[], n: number): Producto[] {
  return [...productosActivos(catalogo)].sort((a, b) => b.precio - a.precio).slice(0, n);
}
