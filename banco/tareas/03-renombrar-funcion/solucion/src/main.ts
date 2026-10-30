import { calcularImpuesto, cuotasPorTipo, describirTipo, totalesFactura, type LineaFactura } from "./index";

const lineas: LineaFactura[] = [
  { concepto: "Portátil", precio: 899.99, unidades: 1, tipo: "general" },
  { concepto: "Libro", precio: 19.9, unidades: 3, tipo: "superreducido" },
  { concepto: "Menú del día", precio: 12.5, unidades: 2, tipo: "reducido" },
];

const t = totalesFactura(lineas);
console.log(`Base: ${t.base.toFixed(2)} · IVA: ${t.cuota.toFixed(2)} · Total: ${t.total.toFixed(2)}`);
for (const [tipo, cuota] of Object.entries(cuotasPorTipo(lineas))) {
  console.log(`  ${describirTipo(tipo as LineaFactura["tipo"])}: ${cuota.toFixed(2)}`);
}
console.log(`IVA de 100 € al tipo general: ${calcularImpuesto(100).toFixed(2)}`);
