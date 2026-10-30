/** Convierte un texto CSV en filas de campos. Las líneas vacías se ignoran. */
export function parsearCsv(texto: string, separador = ","): string[][] {
  return texto
    .split("\n")
    .filter((linea) => linea.trim() !== "")
    .map((linea) => linea.split(separador));
}

export interface Cliente {
  nombre: string;
  email: string;
  ciudad: string;
  notas: string;
}

/** La primera fila es la cabecera; el orden de las columnas puede variar. */
export function leerClientes(texto: string, separador = ","): Cliente[] {
  const [cabecera, ...filas] = parsearCsv(texto, separador);
  if (!cabecera) return [];
  const columna = (fila: string[], nombre: string) => fila[cabecera.indexOf(nombre)] ?? "";
  return filas.map((f) => ({
    nombre: columna(f, "nombre"),
    email: columna(f, "email"),
    ciudad: columna(f, "ciudad"),
    notas: columna(f, "notas"),
  }));
}
