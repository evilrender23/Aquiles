# facturas

Cálculo de facturas con IVA.

- `calcularImpuesto(base, tipo)` devuelve la cuota de IVA de una base imponible (tipos `general`, `reducido` y `superreducido`).
- `totalesFactura(lineas)` suma bases y cuotas. Usa `calcularImpuesto` línea a línea.
- `calcImporteLinea(precio, unidades)` calcula la base de una línea.

Ejemplo: `bun src/main.ts`.
