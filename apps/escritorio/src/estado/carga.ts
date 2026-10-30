import { useCallback, useEffect, useRef, useState } from "react";

export interface Carga<T> {
  datos?: T;
  error?: string;
  cargando: boolean;
  /** Cambia lo cargado sin volver a pedirlo (p. ej. con lo que devuelve un guardado). */
  fijar: (f: (datos: T) => T) => void;
}

/**
 * Pide algo al núcleo y lo vuelve a pedir cuando cambian `id` o `revision`.
 * Un `id` nuevo es otra cosa (se vacía lo anterior); una `revision` nueva es la misma, actualizada
 * (se sigue viendo lo anterior mientras llega). Con `id` null no pide nada. Las respuestas viejas se descartan.
 */
export function useCarga<T>(id: string | null, revision: number, cargar: () => Promise<T>): Carga<T> {
  const [estado, setEstado] = useState<Omit<Carga<T>, "fijar">>({ cargando: id !== null });
  const funcion = useRef(cargar);
  funcion.current = cargar;
  const vez = useRef(0);
  const idAnterior = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` es el disparador (algo cambió en el núcleo), no un dato que se lea.
  useEffect(() => {
    const n = ++vez.current;
    const otro = idAnterior.current !== id;
    idAnterior.current = id;
    if (id === null) {
      setEstado({ cargando: false });
      return;
    }
    setEstado((e) => (otro ? { cargando: true } : { ...e, cargando: true }));
    funcion.current().then(
      (datos) => {
        if (n === vez.current) setEstado({ datos, cargando: false });
      },
      (e: unknown) => {
        if (n === vez.current) setEstado((x) => ({ ...x, error: e instanceof Error ? e.message : String(e), cargando: false }));
      },
    );
  }, [id, revision]);

  const fijar = useCallback((f: (datos: T) => T) => setEstado((e) => (e.datos === undefined ? e : { ...e, datos: f(e.datos) })), []);
  return { ...estado, fijar };
}
