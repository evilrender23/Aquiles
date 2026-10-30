Al CLI de notas (`bun src/cli.ts`) le falta poder marcar notas como hechas. Añade:

- Un subcomando `hecha <id>` que marque esa nota como hecha y escriba `Nota <id> marcada como hecha`. Si el id no existe o no es un número, que escriba un error por la salida de errores y termine con código 1 sin tocar el fichero de notas.
- Una opción `--pendientes` para `listar`, que muestre solo las notas que no están hechas.

Actualiza también el texto de ayuda. Lo que ya existe (`agregar`, `listar`, el formato de las líneas y el fichero de notas) tiene que seguir funcionando igual.
