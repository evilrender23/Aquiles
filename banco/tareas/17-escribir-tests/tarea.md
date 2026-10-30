`src/validador.ts` no tiene ni un test y lo vamos a tocar pronto. Escribe tests con `bun:test` (en `test/`) que cubran bien su comportamiento actual, para que cualquier cambio que lo rompa se note:

- `validarDocumento`: DNI y NIE válidos, letra de control incorrecta, minúsculas, espacios y guiones, NIE con X, Y y Z, y formatos incorrectos (longitud, letras donde van cifras...).
- `normalizarTelefono`: con y sin prefijo `+34` o `0034`, con espacios, guiones y puntos, y casos que devuelven `null` (no empieza por 6, 7, 8 o 9, longitud incorrecta...). Comprueba también el formato exacto de lo que devuelve.

No cambies `src/validador.ts`: el código está bien, lo que faltan son los tests. Tienen que pasar con `bun test`.
