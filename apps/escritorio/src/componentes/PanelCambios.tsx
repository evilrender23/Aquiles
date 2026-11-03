/**
 * Cambios y registro de una sesión (cambios.listar, cambios.deshacer, auditoria.leer):
 * - Cambios: por turno, los ficheros que creó, modificó o borró, y «Deshacer» para dejarlos como estaban.
 * - Registro: cada herramienta que se ejecutó (o se denegó), quién la aprobó, si salió bien y cuánto tardó.
 */
import type { CambiosTurno, EntradaAuditoria, ResultadoDeshacer } from "@aquiles/protocolo";
import { BotonIcono, Boton, Pestanas, clases, idPestana, useMenuContextual } from "@aquiles/ui";
import { useCallback, useEffect, useState } from "react";
import { useAcciones } from "../estado/almacen";
import { duracion, fechaConHora, hora } from "../estado/formato";
import { MarcoPanel } from "./Artefactos";

type Pestana = "cambios" | "registro";
const PANEL = "panel-cambios";

const APROBACION: Record<EntradaAuditoria["aprobacion"], string> = {
  automatica: "sin preguntar",
  usuario: "lo permitiste",
  siempre: "permitido siempre",
  guardian: "el guardián",
  denegada: "denegada",
};
const ACCION = { creado: "creado", modificado: "modificado", borrado: "borrado" } as const;

/** Ruta relativa a la carpeta de la sesión si está dentro; si no, entera. */
function rutaVisible(ruta: string, cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  const dentro = ruta.toLowerCase().startsWith(base.toLowerCase()) && /[\\/]/.test(ruta[base.length] ?? "");
  return dentro ? ruta.slice(base.length + 1) : ruta;
}

export function PanelCambios({ sesionId, cwd, trabajando, alCerrar }: { sesionId: string; cwd: string; trabajando: boolean; alCerrar: () => void }) {
  const { llamar } = useAcciones();
  const [pestana, setPestana] = useState<Pestana>("cambios");
  const [turnos, setTurnos] = useState<CambiosTurno[]>();
  const [registro, setRegistro] = useState<EntradaAuditoria[]>();
  const [error, setError] = useState<string>();
  const [confirmando, setConfirmando] = useState<string>();
  const [resultado, setResultado] = useState<{ turno: string; r: ResultadoDeshacer }>();

  const cargar = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([llamar("cambios.listar", { sesionId }), llamar("auditoria.leer", { sesionId })]);
      setTurnos(c.turnos);
      setRegistro(a.entradas.slice().reverse());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [llamar, sesionId]);

  // Al abrir y cada vez que acaba un turno.
  useEffect(() => {
    if (!trabajando) void cargar();
  }, [trabajando, cargar]);

  const deshacer = async (turno: string) => {
    setConfirmando(undefined);
    try {
      setResultado({ turno, r: await llamar("cambios.deshacer", { sesionId, turno }) });
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const menu = useMenuContextual(() => [
    { texto: "Recargar", icono: "recargar", alElegir: () => void cargar() },
    { tipo: "separador" },
    { texto: "Cerrar", icono: "cerrar", alElegir: alCerrar },
  ]);

  return (
    <MarcoPanel titulo="Cambios de la sesión" icono="reloj" menu={menu} alCerrar={alCerrar}>
      <div className="panel-artefacto__barra">
        <Pestanas
          etiqueta="Cambios y registro"
          className="panel-artefacto__pestanas"
          pestanas={[
            { id: "cambios", texto: "Cambios" },
            { id: "registro", texto: "Registro" },
          ]}
          activa={pestana}
          alElegir={setPestana}
          idPanel={PANEL}
        />
        <span className="panel-artefacto__acciones">
          <BotonIcono etiqueta="Recargar" icono="recargar" onClick={() => void cargar()} />
        </span>
      </div>
      <div className="panel-artefacto__cuerpo cambios" role="tabpanel" id={PANEL} aria-labelledby={idPestana(PANEL, pestana)}>
        {error && (
          <p className="panel-artefacto__aviso panel-artefacto__aviso--error" role="alert">
            {error}
          </p>
        )}
        {pestana === "cambios" ? (
          turnos === undefined ? null : turnos.length === 0 ? (
            <p className="cambios__vacio">Aún no ha cambiado ningún fichero en esta sesión. Lo que haga la terminal no aparece aquí (ver Registro).</p>
          ) : (
            <ol className="cambios__turnos">
              {turnos.map((t) => (
                <li key={t.turno} className={clases("cambios__turno", t.deshecho && "cambios__turno--deshecho")}>
                  <div className="cambios__cabecera">
                    <span className="cambios__hora">{fechaConHora(t.fecha)}</span>
                    {t.deshecho ? (
                      <span className="cambios__estado">Deshecho</span>
                    ) : confirmando === t.turno ? (
                      <span className="cambios__confirmar">
                        <Boton variante="acento" tamano="pequeno" disabled={trabajando} onClick={() => void deshacer(t.turno)}>
                          Deshacer {t.ficheros.length === 1 ? "1 fichero" : `${t.ficheros.length} ficheros`}
                        </Boton>
                        <Boton variante="fantasma" tamano="pequeno" onClick={() => setConfirmando(undefined)}>
                          Cancelar
                        </Boton>
                      </span>
                    ) : (
                      <Boton
                        variante="fantasma"
                        tamano="pequeno"
                        icono="recargar"
                        disabled={trabajando}
                        title={trabajando ? "Espera a que acabe el turno" : undefined}
                        onClick={() => setConfirmando(t.turno)}
                      >
                        Deshacer
                      </Boton>
                    )}
                  </div>
                  {t.pedido && <p className="cambios__pedido">{t.pedido}</p>}
                  <ul className="cambios__ficheros">
                    {t.ficheros.map((f) => (
                      <li key={f.ruta} title={f.ruta}>
                        <span className={`cambios__accion cambios__accion--${f.accion}`}>{ACCION[f.accion]}</span>
                        <span className="cambios__ruta">{rutaVisible(f.ruta, cwd)}</span>
                        {!f.deshacible && <span className="cambios__nota">sin copia (muy grande)</span>}
                      </li>
                    ))}
                  </ul>
                  {resultado?.turno === t.turno && (
                    <p className="cambios__resultado" role="status">
                      {resultado.r.restaurados.length} restaurado{resultado.r.restaurados.length === 1 ? "" : "s"}
                      {resultado.r.conflictos.map((c) => (
                        <span key={c.ruta} className="cambios__conflicto">
                          {rutaVisible(c.ruta, cwd)}: {c.motivo}
                        </span>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )
        ) : registro === undefined ? null : registro.length === 0 ? (
          <p className="cambios__vacio">Aún no se ha usado ninguna herramienta en esta sesión.</p>
        ) : (
          <ol className="registro">
            {registro.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: el registro solo crece por el final y se pinta al revés.
              <li key={i} className={clases("registro__fila", !e.ok && "registro__fila--fallo")}>
                <span className="registro__hora">{hora(e.fecha)}</span>
                <span className="registro__herramienta">{e.herramienta}</span>
                <span className="registro__resumen" title={e.resumen}>
                  {e.resumen}
                </span>
                <span className={clases("registro__aprobacion", e.aprobacion === "denegada" && "registro__aprobacion--denegada")}>{APROBACION[e.aprobacion]}</span>
                <span className="registro__resultado">{e.aprobacion === "denegada" ? "" : e.ok ? duracion(e.ms) : "error"}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </MarcoPanel>
  );
}
