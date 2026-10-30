Implementa la clase `CacheLRU` de `src/cache.ts` (ahora es solo el esqueleto). Es una caché en memoria con capacidad limitada y caducidad opcional:

- `new CacheLRU({ capacidad, ttlMs?, ahora? })`. `capacidad` es un entero ≥ 1; si no, el constructor lanza `RangeError`. `ahora` es el reloj en milisegundos (por defecto `Date.now`) y sirve para los tests.
- `set(clave, valor)` guarda o actualiza. Tanto guardar como actualizar dejan la entrada como la usada más recientemente y reinician su caducidad. Si al guardar se supera la capacidad, se expulsa la entrada usada hace más tiempo.
- `get(clave)` devuelve el valor (o `undefined`) y cuenta como uso: la entrada pasa a ser la más reciente.
- `has(clave)` dice si está, pero no cuenta como uso.
- `delete(clave)` la quita y devuelve si estaba.
- `size` es el número de entradas vigentes.
- `claves()` devuelve las claves vigentes de la usada más recientemente a la que lleva más tiempo sin usarse.
- Con `ttlMs`, una entrada caduca cuando han pasado `ttlMs` milisegundos o más desde su último `set`. Las caducadas se comportan como si no estuvieran (en `get`, `has`, `size` y `claves`) y no ocupan sitio a la hora de expulsar. Sin `ttlMs`, nada caduca.
