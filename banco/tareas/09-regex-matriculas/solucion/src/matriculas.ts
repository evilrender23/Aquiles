/** Matrículas españolas del sistema actual (desde el año 2000): cuatro cifras y tres consonantes (sin Ñ ni Q). */
const LETRA = "[BCDFGHJKLMNPRSTVWXYZ]";
const PATRON = String.raw`(\d{4})[ -]?(${LETRA}{3})`;

export function extraerMatriculas(texto: string): string[] {
  const re = new RegExp(String.raw`(?<![\p{L}\p{N}])${PATRON}(?![\p{L}\p{N}])`, "giu");
  return [...texto.matchAll(re)].map((m) => `${m[1]}${m[2]!.toUpperCase()}`);
}

export function esMatriculaValida(matricula: string): boolean {
  return new RegExp(`^${PATRON}$`, "i").test(matricula.trim());
}
