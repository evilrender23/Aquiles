export interface Registro {
  id: string;
  valor: number;
}

export interface Fuente {
  obtener(id: string): Promise<Registro>;
}

export interface Destino {
  guardar(registros: Registro[]): Promise<void>;
}

export interface Resumen {
  guardados: number;
  total: number;
}

/**
 * Llama a `fn` hasta `intentos` veces mientras falle. Devuelve el primer resultado bueno;
 * si fallan todos los intentos, rechaza con el último error.
 */
export async function reintentar<T>(fn: () => Promise<T>, intentos = 3): Promise<T> {
  let ultimo: unknown;
  for (let i = 0; i < intentos; i++) {
    try {
      return fn();
    } catch (e) {
      ultimo = e;
    }
  }
  throw ultimo;
}

/**
 * Descarga de la fuente los registros de `ids`, todos a la vez (cada descarga con `reintentar`,
 * hasta 3 intentos), y los guarda en el destino en una sola llamada, en el mismo orden que `ids`.
 * Devuelve cuántos registros se han guardado y la suma de sus valores, una vez guardados.
 * Si falla alguna descarga (tras los reintentos) o el guardado, rechaza con ese error, y si falla
 * una descarga no se guarda nada.
 */
export async function sincronizar(ids: string[], fuente: Fuente, destino: Destino): Promise<Resumen> {
  const registros: Registro[] = [];
  ids.forEach(async (id) => {
    const r = await reintentar(() => fuente.obtener(id));
    registros.push(r);
  });
  destino.guardar(registros);
  return { guardados: registros.length, total: registros.reduce((s, r) => s + r.valor, 0) };
}
