/** Antigüedad máxima, en días, de los pedidos que se mostraban en el panel viejo. */
export const UMBRAL_ANTIGUO = 90;

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2026-03-07" → "7 mar 2026". */
export function formatearFecha(iso: string): string {
  const [anio, mes, dia] = iso.split("-").map(Number);
  return `${dia} ${MESES[mes! - 1]} ${anio}`;
}

/** Junta espacios repetidos y quita los de los extremos. */
function normalizarEspacios(texto: string): string {
  return texto.trim().replace(/\s+/g, " ");
}

/** "  ana   garcía " → "Ana García". */
export function capitalizar(texto: string): string {
  return normalizarEspacios(texto)
    .split(" ")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

export function invertirCadena(texto: string): string {
  return [...texto].reverse().join("");
}

function rellenarIzquierda(texto: string, ancho: number): string {
  return texto.padStart(ancho, " ");
}
