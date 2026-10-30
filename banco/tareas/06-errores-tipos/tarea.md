Este proyecto no pasa la comprobación de tipos: `tsc -p .` da un montón de errores. Arréglalos sin silenciar al compilador: nada de `any`, `@ts-ignore`, `@ts-expect-error` ni tocar `tsconfig.json`.

Ojo, que alguno de esos errores esconde un fallo de verdad. Lo que se espera:
- `buscar` devuelve `undefined` si no encuentra el SKU.
- `primeraEtiqueta` devuelve la primera etiqueta en mayúsculas, o cadena vacía si el producto no tiene etiquetas.
- `valorStock` es la suma de precio × stock.
- Los precios del catálogo son números.
