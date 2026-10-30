import { clases } from "@aquiles/ui";
import { useEffect, useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { fechaCompleta, fechaRelativa } from "../estado/formato";

/** El núcleo marca la coincidencia con «»; los «» sueltos (fragmento recortado) se quitan. */
function trozos(fragmento: string): { texto: string; marca: boolean }[] {
  return fragmento
    .split(/«([^«»]*)»/)
    .map((texto, i) => ({ texto: i % 2 ? texto : texto.replace(/[«»]/g, ""), marca: i % 2 === 1 }))
    .filter((t) => t.texto);
}

/** Valor que solo cambia cuando `valor` lleva `ms` sin cambiar. */
function useRetrasado(valor: string, ms: number): string {
  const [retrasado, setRetrasado] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setRetrasado(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return retrasado;
}

/** Resultados de buscar.sesiones para la barra lateral; al pulsar uno se abre su sesión. */
export function ResultadosBusqueda({ consulta, ahora, alAbrir }: { consulta: string; ahora: number; alAbrir: (sesionId: string) => void }) {
  const estado = useEstado();
  const { buscarSesiones } = useAcciones();
  const pedida = useRetrasado(consulta.trim(), 250);
  const busqueda = useCarga(pedida || null, 0, () => buscarSesiones(pedida));
  const resultados = busqueda.datos ?? [];
  const esperando = pedida !== consulta.trim() || busqueda.cargando;

  return (
    <div className="busqueda" aria-busy={esperando}>
      {busqueda.error && (
        <p className="busqueda__nota" role="alert">
          {busqueda.error}
        </p>
      )}
      {!esperando && busqueda.datos && resultados.length === 0 && <p className="busqueda__nota">Sin resultados</p>}
      {resultados.length > 0 && (
        <ul className="busqueda__lista" aria-label="Resultados">
          {resultados.map((r, i) => {
            const actual = estado.vista === "conversacion" && estado.activa === r.sesionId;
            const titulo = estado.sesiones[r.sesionId]?.titulo ?? r.titulo;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: una sesión puede dar varios resultados con la misma fecha.
              <li key={`${r.sesionId}:${i}`}>
                <button type="button" className={clases("resultado", actual && "resultado--actual")} aria-current={actual ? "page" : undefined} onClick={() => alAbrir(r.sesionId)}>
                  <span className="resultado__cabecera">
                    <span className="resultado__titulo">{titulo || "Sin título"}</span>
                    <span className="resultado__fecha" title={fechaCompleta(r.fecha)}>
                      {fechaRelativa(r.fecha, ahora)}
                    </span>
                  </span>
                  <span className="resultado__fragmento">
                    {trozos(r.fragmento).map((t, j) =>
                      t.marca ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: trozos fijos de un texto que no cambia.
                        <mark key={j} className="resultado__marca">
                          {t.texto}
                        </mark>
                      ) : (
                        t.texto
                      ),
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
