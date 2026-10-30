import { join } from "node:path";
import { comprobar, DIR_TAREA, existe, fallar, ficheros, leer, leerInicial } from "../../comun";

await comprobar(async (dir) => {
  if (!existe(dir, "RESPUESTA.md")) fallar("no existe RESPUESTA.md");
  const primera = leer(dir, "RESPUESTA.md")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!primera) fallar("RESPUESTA.md está vacío");
  const numeros = primera.match(/\d+/g) ?? [];
  if (numeros.length !== 1) fallar(`la primera línea debe tener solo el puerto; tiene: ${JSON.stringify(primera)}`);
  if (numeros[0] !== "7443") fallar(`puerto incorrecto: ${numeros[0]}`);

  // Los ficheros del proyecto no deben cambiar (crear ficheros auxiliares sí se tolera).
  for (const rel of ficheros(join(DIR_TAREA, "inicial"))) {
    if (!existe(dir, rel)) fallar(`se ha borrado ${rel}`);
    if (leer(dir, rel).trimEnd() !== leerInicial(rel).trimEnd()) fallar(`se ha modificado ${rel}`);
  }
});
