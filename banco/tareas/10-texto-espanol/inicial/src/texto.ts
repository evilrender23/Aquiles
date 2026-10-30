/** Slug para la URL de un artículo: "Año Nuevo en Cádiz" → "ano-nuevo-en-cadiz". */
export function slugificar(titulo: string): string {
  return titulo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Ordena palabras como en un diccionario (devuelve una lista nueva). */
export function ordenarAlfabeticamente(palabras: readonly string[]): string[] {
  return [...palabras].sort();
}

/** Cuántas veces aparece cada palabra, en minúsculas. */
export function contarPalabras(texto: string): Map<string, number> {
  const cuenta = new Map<string, number>();
  for (const palabra of texto.toLowerCase().match(/\w+/g) ?? []) {
    cuenta.set(palabra, (cuenta.get(palabra) ?? 0) + 1);
  }
  return cuenta;
}
