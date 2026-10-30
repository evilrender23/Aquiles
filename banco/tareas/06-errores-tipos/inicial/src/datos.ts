import type { Producto } from "./inventario";

export const CATALOGO: Producto[] = [
  { sku: "A1", nombre: "Lápiz", precio: 0.5, stock: 120, etiquetas: ["papelería"] },
  { sku: "B2", nombre: "Cuaderno", precio: "2.25", stock: 40, etiquetas: ["papelería", "oferta"] },
  { sku: "C3", nombre: "Mochila", precio: 24.9, stock: 0 },
  { sku: "D4", nombre: "Calculadora", precio: 12, stock: 7, etiquetas: ["electrónica"] },
];
