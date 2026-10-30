export interface OpcionesCache {
  capacidad: number;
  ttlMs?: number;
  ahora?: () => number;
}

/** Caché LRU con caducidad opcional. */
export class CacheLRU<K, V> {
  constructor(opciones: OpcionesCache) {
    throw new Error("Sin implementar");
  }

  get(clave: K): V | undefined {
    throw new Error("Sin implementar");
  }

  set(clave: K, valor: V): void {
    throw new Error("Sin implementar");
  }

  has(clave: K): boolean {
    throw new Error("Sin implementar");
  }

  delete(clave: K): boolean {
    throw new Error("Sin implementar");
  }

  get size(): number {
    throw new Error("Sin implementar");
  }

  claves(): K[] {
    throw new Error("Sin implementar");
  }
}
