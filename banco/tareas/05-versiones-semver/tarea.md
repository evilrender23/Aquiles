Implementa las tres funciones de `src/versiones.ts`, que ahora solo lanzan "Sin implementar". Trabajan con versiones semánticas (SemVer 2.0.0):

- Formato `MAYOR.MENOR.PARCHE`: números enteros sin ceros a la izquierda (`0` sí vale, `01` no). Puede llevar una `v` inicial (`v1.2.3`), que se ignora.
- Opcionalmente, `-prelanzamiento`: identificadores separados por puntos, no vacíos, solo con `[0-9A-Za-z-]`; los que son solo cifras no pueden tener ceros a la izquierda. Ej.: `1.0.0-alpha`, `1.0.0-rc.1`, `1.0.0-x-y.7`.
- Opcionalmente, `+metadatos`: identificadores con los mismos caracteres (aquí sí se permiten ceros a la izquierda). Se ignoran al comparar.

Precedencia:
1. Se comparan mayor, menor y parche numéricamente.
2. Con el mismo número, una versión con prelanzamiento es menor que sin él (`1.0.0-rc.1 < 1.0.0`).
3. Dos prelanzamientos se comparan identificador a identificador: los numéricos como números, los demás alfabéticamente por código ASCII, un numérico siempre es menor que uno alfanumérico, y si todos coinciden, el que tiene más identificadores es mayor.

Ejemplo de orden: `1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0`.

Comportamiento:
- `esVersionValida(v)` devuelve `true` o `false` (nunca lanza). No admite espacios.
- `compararVersiones(a, b)` devuelve `-1`, `0` o `1`, y lanza un `Error` si alguna no es válida.
- `ordenarVersiones(lista)` devuelve una lista nueva ordenada de menor a mayor, sin modificar la original; las que son iguales en precedencia mantienen su orden relativo. Lanza si alguna no es válida.
