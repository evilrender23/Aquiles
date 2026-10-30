export interface OpcionesCache {
  capacidad: number;
  ttlMs?: number;
  ahora?: () => number;
}

interface Entrada<V> {
  valor: V;
  guardada: number;
}

/** Caché LRU con caducidad opcional. Un Map conserva el orden de inserción: el último es el más reciente. */
export class CacheLRU<K, V> {
  private readonly entradas = new Map<K, Entrada<V>>();
  private readonly capacidad: number;
  private readonly ttlMs?: number;
  private readonly ahora: () => number;

  constructor(opciones: OpcionesCache) {
    if (!Number.isInteger(opciones.capacidad) || opciones.capacidad < 1) {
      throw new RangeError(`capacidad no válida: ${opciones.capacidad}`);
    }
    this.capacidad = opciones.capacidad;
    this.ttlMs = opciones.ttlMs;
    this.ahora = opciones.ahora ?? Date.now;
  }

  private caducada(e: Entrada<V>): boolean {
    return this.ttlMs !== undefined && this.ahora() - e.guardada >= this.ttlMs;
  }

  private purgar(): void {
    for (const [k, e] of this.entradas) if (this.caducada(e)) this.entradas.delete(k);
  }

  get(clave: K): V | undefined {
    const e = this.entradas.get(clave);
    if (!e) return undefined;
    this.entradas.delete(clave);
    if (this.caducada(e)) return undefined;
    this.entradas.set(clave, e);
    return e.valor;
  }

  set(clave: K, valor: V): void {
    this.entradas.delete(clave);
    this.entradas.set(clave, { valor, guardada: this.ahora() });
    if (this.entradas.size > this.capacidad) this.purgar();
    while (this.entradas.size > this.capacidad) {
      const masAntigua = this.entradas.keys().next().value as K;
      this.entradas.delete(masAntigua);
    }
  }

  has(clave: K): boolean {
    const e = this.entradas.get(clave);
    return e !== undefined && !this.caducada(e);
  }

  delete(clave: K): boolean {
    const e = this.entradas.get(clave);
    if (!e) return false;
    this.entradas.delete(clave);
    return !this.caducada(e);
  }

  get size(): number {
    this.purgar();
    return this.entradas.size;
  }

  claves(): K[] {
    this.purgar();
    return [...this.entradas.keys()].reverse();
  }
}
