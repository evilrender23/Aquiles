import { Boton, Medidor } from "@aquiles/ui";
import { useEffect, useState } from "react";
import {
  alActualizacionLista,
  alErrorActualizacion,
  alProgresoActualizacion,
  aplicarActualizacion,
  buscarActualizacion,
  type EstadoActualizacion,
  estadoActualizacion,
  instalarActualizacion,
} from "../plataforma/aplicacion";
import { enTauri } from "../plataforma/tauri";

/**
 * La actualización en la barra lateral, solo cuando hay algo que hacer: una versión nueva en `main`, la compilación
 * en marcha, la versión lista para reiniciar o un fallo. El detalle sigue en Ajustes → Aplicación.
 */
export function AvisoActualizacion({ alVerDetalle }: { alVerDetalle: () => void }) {
  const [estado, setEstado] = useState<EstadoActualizacion>({ fase: "inactiva" });
  const [hayNueva, setHayNueva] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enTauri()) return;
    estadoActualizacion().then((e) => e && setEstado(e), () => {});
    // Al abrir la app; con «Actualizar solo», la propia app la compila más tarde y llegan sus eventos.
    buscarActualizacion().then((i) => setHayNueva(!!i && !i.desarrollo && i.hayNueva), () => {});
    const soltar = [
      alProgresoActualizacion((p) => setEstado({ fase: "compilando", ...p })),
      alActualizacionLista((d) => setEstado({ fase: "lista", commit: d.commit })),
      alErrorActualizacion((d) => setEstado({ fase: "error", texto: d.texto })),
    ];
    return () => {
      for (const f of soltar) f();
    };
  }, []);

  const actuar = (f: () => Promise<void>) => () =>
    void f().then(
      () => setError(undefined),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );

  if (estado.fase === "compilando")
    return (
      <button type="button" className="lateral__actualizacion" onClick={alVerDetalle} title={estado.texto}>
        <span className="lateral__actualizacion-texto">{estado.total > 0 ? `Actualizando · ${estado.paso} de ${estado.total}` : "Actualizando"}</span>
        {estado.total > 0 && <Medidor valor={estado.paso / estado.total} etiqueta="Compilación de la actualización" />}
      </button>
    );
  if (estado.fase === "lista")
    return (
      <Boton variante="acento" tamano="pequeno" ancho onClick={actuar(aplicarActualizacion)} title={`Versión ${estado.commit}`}>
        Reiniciar para actualizar
      </Boton>
    );
  if (estado.fase === "error" || error)
    return (
      <Boton variante="secundario" tamano="pequeno" ancho onClick={alVerDetalle} title={error ?? (estado.fase === "error" ? estado.texto : undefined)}>
        No se pudo actualizar
      </Boton>
    );
  if (hayNueva)
    return (
      <Boton variante="acento" tamano="pequeno" ancho onClick={actuar(instalarActualizacion)}>
        Actualizar
      </Boton>
    );
  return null;
}
