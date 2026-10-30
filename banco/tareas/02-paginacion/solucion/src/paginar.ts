export interface Pagina<T> {
  elementos: T[];
  /** Página devuelta (ya ajustada al rango válido). */
  pagina: number;
  totalPaginas: number;
  hayAnterior: boolean;
  haySiguiente: boolean;
}

/**
 * Devuelve la página `pagina` (la primera es la 1) de `elementos`, con `porPagina` elementos
 * por página. La última página puede quedar incompleta. Una lista vacía tiene una única página,
 * vacía. Si `pagina` se sale del rango, se devuelve la primera o la última página.
 */
export function paginar<T>(elementos: readonly T[], pagina: number, porPagina = 10): Pagina<T> {
  const totalPaginas = Math.max(1, Math.ceil(elementos.length / porPagina));
  const actual = Math.min(Math.max(pagina, 1), totalPaginas);
  const inicio = (actual - 1) * porPagina;
  return {
    elementos: elementos.slice(inicio, inicio + porPagina),
    pagina: actual,
    totalPaginas,
    hayAnterior: actual > 1,
    haySiguiente: actual < totalPaginas,
  };
}
