El detector de matrículas de `src/matriculas.ts` falla mucho. Las matrículas españolas actuales son 4 cifras y 3 letras, pero las letras son solo consonantes: no se usan vocales, ni la Ñ ni la Q.

Lo que tiene que hacer:
- `extraerMatriculas(texto)` devuelve las matrículas que aparecen en el texto, en orden y normalizadas como `1234BCD`. En el texto pueden venir en minúsculas y con un espacio o un guion entre cifras y letras (`1234 bcd`, `1234-BCD`). No vale sacarlas de trozos de algo más largo: en `12345BCD` o `1234BCDF` no hay ninguna matrícula.
- `esMatriculaValida(m)` dice si la cadena entera es una matrícula con esas mismas reglas (admite espacios al principio y al final).
