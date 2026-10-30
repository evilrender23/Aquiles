# Banco de tareas

Mide si el motor del agente mejora o empeora: 20 encargos pequeños (de 1 a 3 minutos para un modelo bueno), cada uno con un comprobador que el agente no ve.

## Ejecutar

```bash
bun banco/ejecutar.ts --validar                      # sin agente: cada comprobador falla en inicial/ y pasa con solucion/
bun banco/ejecutar.ts --proveedor simulado --tareas 01   # prueba de la fontanería (la tarea falla, es lo esperado)
bun banco/ejecutar.ts --proveedor agy                # el banco completo con un modelo real (gasta cuota)
bun run banco -- --proveedor agy --modelo X --tareas 01,05,17 --paralelo 3
```

| Opción | Por defecto | Qué hace |
|---|---|---|
| `--proveedor` | `agy` | Nombre para `crearProveedor`. Se crea un proveedor por tarea. |
| `--modelo` | el del proveedor | Modelo que se pide al proveedor. |
| `--tareas` | todas | Lista separada por comas: `01,5,17-escribir-tests`. |
| `--paralelo` | 2 | Tareas a la vez. |
| `--max-iteraciones` | 40 | Límite del bucle del agente. |
| `--tiempo-max` | 900 | Segundos por tarea; al agotarse se aborta el agente y se comprueba lo que haya. |
| `--detalle` | no | Muestra en consola las herramientas que va usando el agente. |
| `--conservar` | no | No borra las carpetas de trabajo de las tareas aprobadas. |
| `--validar` | no | Solo valida las tareas; no usa el agente ni guarda resultados. |

Cada tarea se copia a `%TEMP%\aquiles-banco\<fecha>-<pid>\<tarea>`, el agente trabaja ahí (con `ejecutarTarea` del núcleo y sus herramientas por defecto) y después se ejecuta `comprobar.ts` sobre esa carpeta. Junto a las carpetas queda `<tarea>.log` con el enunciado, el texto del agente, cada llamada a herramienta con su resultado y la salida del comprobador. Las carpetas de las tareas aprobadas se borran; las de las fallidas se quedan para mirarlas.

Mientras corre el banco, `node_modules/.bin` del repo va delante en el `PATH`, así que el agente tiene `tsc` sin descargar nada (lo necesita la tarea 06).

Ctrl+C para las tareas en curso, guarda los resultados parciales y sale con 130. Un segundo Ctrl+C sale en el acto.

## Resultados

Cada ejecución con agente guarda `banco/resultados/<AAAAMMDD-HHMM>-<proveedor>[-<modelo>].json` (se versionan) e imprime una tabla y la puntuación.

- `resumen`: `aprobadas`, `total`, `puntuacion` (`aprobadas/total`), `porcentaje`, `tokens` sumados, `llamadas` sumadas, `segundosAgente` (suma de los tiempos de agente), `segundosTotal` (reloj de pared) e `interrumpido`.
- `tareas[]`, una por tarea:
  - `id`: carpeta de la tarea.
  - `ok`: el comprobador ha pasado.
  - `motivo`: salida del comprobador (`OK` o por qué falla), o por qué no se comprobó (interrumpido, error del banco).
  - `fin`: cómo terminó el turno del agente: `fin` (respondió sin pedir más herramientas), `limite` (agotó `--max-iteraciones`), `parado` (abortado por Ctrl+C o por `--tiempo-max`) o `error`.
  - `segundos`: tiempo del agente. `segundosComprobar`: tiempo del comprobador.
  - `tokens`: `entrada`, `salida`, `razonamiento` y `total` (la suma de los tres), según el uso que devuelve el proveedor.
  - `llamadas`: llamadas a herramientas del agente.
  - `error`: error del agente o del proveedor (o `tiempo agotado`), si lo hubo.
  - `carpeta`: carpeta de trabajo, solo si la tarea no se aprobó (o con `--conservar`).
  - `registro`: el `.log` de la tarea.

## Tareas

| Id | Qué mide | Cómo se comprueba |
|---|---|---|
| 01 | Arreglar un bug con un test visible que falla (y otro que solo está en el comentario) | Casos ocultos importando el módulo + el test visible sin cambios y en verde |
| 02 | Off-by-one en una paginación | Casos ocultos |
| 03 | Renombrar una función en código, tests y README sin tocar otra de nombre parecido | Búsqueda del nombre viejo, exportaciones, salida exacta de `bun src/main.ts`, `bun test` |
| 04 | Añadir un parámetro opcional y propagarlo (incluye la trampa de `.map(fn)`) | Lo antiguo idéntico a la versión original; lo nuevo con casos ocultos; el script con argumento |
| 05 | Implementar a partir de una especificación (SemVer) | Casos ocultos |
| 06 | Errores de tipos con `tsc`, sin `any` ni `@ts-ignore`; alguno esconde un bug | `tsc` del repo, `tsconfig.json` intacto, sin trampas, comportamiento oculto |
| 07 | Parsear CSV con comillas, `""`, saltos de línea y CRLF | Casos ocultos y el fichero de ejemplo |
| 08 | Fechas en zonas horarias con horario de verano y desfases | Casos ocultos con `TZ` del proceso distinta |
| 09 | Expresión regular (matrículas) con límites de palabra | Casos ocultos |
| 10 | Texto en español: slugs, orden alfabético con ñ y tildes, palabras con tilde | Casos ocultos |
| 11 | Refactor de código duplicado sin cambiar la salida | Salida idéntica a la original con datos variados; fragmentos duplicados y tamaño |
| 12 | Cambiar un JSON de configuración y el código que dependía de lo quitado | JSON esperado, sin restos de `legacy`, la app arranca y su salida |
| 13 | Buscar un dato siguiendo cómo se carga la configuración (la documentación miente) | Primera línea de `RESPUESTA.md` y nada más modificado |
| 14 | Añadir un subcomando y una opción a un CLI | Se ejecuta el CLI con un fichero de notas temporal: salidas, códigos y fichero |
| 15 | Promesas sin `await` (`forEach` async, `return` sin `await` en un `try`) | Casos ocultos con retardos: orden, concurrencia, errores, reintentos |
| 16 | Quitar código muerto (exportaciones, imports, ramas, un fichero) sin cambiar la API | API idéntica a la original, sin los nombres muertos, `bun test` |
| 17 | Escribir los tests que faltan | Tienen que pasar y detectar 11 versiones rotas inyectadas una a una |
| 18 | Investigar ejecutando por qué fallan los tests tras un cambio de datos | `bun test` sin tocar tests ni datos + otra exportación oculta |
| 19 | Implementar una clase (caché LRU con caducidad y reloj inyectable) | Casos ocultos |
| 20 | Rendimiento (algoritmos cuadráticos con 200.000 contactos) | Igual que la original en datos pequeños + carga en un proceso aparte con límite de 4 s |

## Añadir una tarea

1. Crea `banco/tareas/<nn-nombre>/` con:
   - `tarea.md`: el encargo, como lo escribiría un usuario. Es el prompt tal cual.
   - `inicial/`: proyecto TypeScript/Bun pequeño con `package.json` sin dependencias.
   - `solucion/`: los ficheros que, copiados encima de `inicial/`, resuelven la tarea. Si la solución borra ficheros, lístalos (uno por línea, relativos al proyecto) en `solucion/.borrar`.
   - `comprobar.ts`: recibe la carpeta de trabajo como argumento y sale con 0 si está bien o con 1 y un motivo. Usa `comprobar()` de `banco/comun.ts`, que también trae `importar`, `importarInicial`, `igual`, `bunTest`, `ejecutar`, `sinCambios`, `buscar`… Comprueba con casos que el agente no vea (importando sus módulos o ejecutando sus comandos), sin red y en menos de 10 s.
2. Los tests que tengan que estar en el proyecto se guardan como `x.test.ts.plantilla`: al copiar se quita el sufijo, y así el `bun test` de la raíz no los ejecuta.
3. `bun banco/ejecutar.ts --validar --tareas <nn>` tiene que dar la tarea como válida.
