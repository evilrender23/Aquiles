/** Matrículas españolas del sistema actual (desde el año 2000): cuatro cifras y tres letras. */
export function extraerMatriculas(texto: string): string[] {
  return texto.match(/\d{4}[A-Z]{3}/g) ?? [];
}

export function esMatriculaValida(matricula: string): boolean {
  return /\d{4}[A-Z]{3}/.test(matricula);
}
