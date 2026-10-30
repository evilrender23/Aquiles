Necesitamos sacar tickets en otras monedas. Añade un parámetro opcional `moneda` (`"EUR"`, `"USD"` o `"GBP"`; por defecto `"EUR"`) a `formatearPrecio`, `lineaTicket` y `generarTicket`, y haz que el ticket lo use en todas sus cifras. El script de ejemplo tiene que aceptar la moneda como primer argumento: `bun src/main.ts USD`.

Formatos:
- EUR se queda exactamente como está ahora: `1.234,50 €`.
- USD y GBP llevan el símbolo delante y formato inglés: `$1,234.50`, `£1,234.50`. Los negativos, `-$3.00`.

Lo que ya funciona no puede cambiar: sin moneda todo tiene que salir igual que ahora.
