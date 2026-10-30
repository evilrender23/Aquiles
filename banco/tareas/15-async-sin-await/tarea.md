La sincronización de `src/sincronizar.ts` se porta raro: a veces devuelve un resumen con 0 registros aunque haya descargado cosas, otras veces guarda listas a medias, y cuando falla una descarga el error no le llega a quien llama. Además, `reintentar` parece que no reintenta: al primer fallo se rinde.

Arréglalo para que haga lo que dicen los comentarios del fichero.
