/** Automatizaciones (tablero del lienzo): tareas programadas y canales. */
import type { EjecucionCron, IdCanal, InfoCanal, ModoAprobacion, TareaProgramada } from "@aquiles/protocolo";
import { Boton, Campo, Etiqueta, Interruptor, Titular, clases } from "@aquiles/ui";
import { useEffect, useRef, useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { MODOS, duracionEntre, fechaCompleta, fechaConHora, fechaProxima, fechaRelativa, hora, nombreModelo } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import { CampoCarpeta, ConfirmarBorrado, OpcionesPermisos, ProveedorModelo } from "./Campos";
import { PanelCanales } from "./Canales";

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Nombre del canal según el núcleo (o su id si aún no se han cargado). */
const nombreCanal = (canales: InfoCanal[] | undefined, id: IdCanal) => canales?.find((c) => c.id === id)?.nombre ?? id;

export function VistaAutomatizaciones() {
  const { revisiones } = useEstado();
  const { llamar } = useAcciones();
  const tareas = useCarga("cron", revisiones.cron, async () => (await llamar("cron.listar", {})).tareas);
  const canales = useCarga("canales", revisiones.canales, async () => (await llamar("canales.listar", {})).canales);
  const [creando, setCreando] = useState(false);
  const [abierta, setAbierta] = useState<string>();
  const ahora = useReloj(30_000);

  return (
    <div className="automatizaciones">
      <div className="automatizaciones__pagina">
        <div className="automatizaciones__cabecera">
          <Titular texto="Automatizaciones" tamano="l" />
          {!creando && (
            <Boton variante="principal" iconoFinal="flecha-diagonal" disabled={!!tareas.error && !tareas.datos} onClick={() => setCreando(true)}>
              Nueva tarea
            </Boton>
          )}
        </div>

        <section className="automatizaciones__seccion" aria-labelledby="titulo-tareas">
          <h2 id="titulo-tareas" className="automatizaciones__titulo">
            Tareas programadas
          </h2>
          {tareas.error && (
            <p className="automatizaciones__error" role="alert">
              {tareas.error}
            </p>
          )}
          {creando && (
            <FormularioTarea
              canales={canales.datos}
              alCancelar={() => setCreando(false)}
              alGuardar={(t) => {
                tareas.fijar((l) => [...l, t]);
                setCreando(false);
                setAbierta(t.id);
              }}
            />
          )}
          {tareas.datos?.length === 0 && !creando && <p className="automatizaciones__vacio">Sin tareas</p>}
          {tareas.datos?.map((t) => (
            <FilaTarea
              key={t.id}
              t={t}
              canales={canales.datos}
              abierta={abierta === t.id}
              ahora={ahora}
              alAlternar={() => setAbierta((a) => (a === t.id ? undefined : t.id))}
              alCambiar={(n) => tareas.fijar((l) => l.map((x) => (x.id === n.id ? n : x)))}
              alBorrar={() => tareas.fijar((l) => l.filter((x) => x.id !== t.id))}
            />
          ))}
        </section>

        <section className="automatizaciones__seccion" aria-labelledby="titulo-canales">
          <h2 id="titulo-canales" className="automatizaciones__titulo">
            Canales
          </h2>
          <PanelCanales canales={canales} />
        </section>
      </div>
    </div>
  );
}

function FilaTarea({
  t,
  canales,
  abierta,
  ahora,
  alAlternar,
  alCambiar,
  alBorrar,
}: {
  t: TareaProgramada;
  canales?: InfoCanal[];
  abierta: boolean;
  ahora: number;
  alAlternar: () => void;
  alCambiar: (t: TareaProgramada) => void;
  alBorrar: () => void;
}) {
  const { llamar } = useAcciones();
  const [editando, setEditando] = useState(false);
  const [error, setError] = useState<string>();
  const u = t.ultima;
  const idDetalle = `tarea-${t.id}`;

  const activar = async (activa: boolean) => {
    try {
      alCambiar(await llamar("cron.editar", { id: t.id, activa }));
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    }
  };

  return (
    <article className={clases("tarea-prog", !t.activa && "tarea-prog--inactiva")}>
      <div className="tarea-prog__fila">
        <div className="tarea-prog__cuando" title={t.proxima ? fechaCompleta(t.proxima) : undefined}>
          <span className="tarea-prog__hora">{t.proxima ? hora(t.proxima) : "—"}</span>
          <Etiqueta>{t.proxima ? fechaProxima(t.proxima, ahora).replace(/ \d\d:\d\d$/, "") : "Sin próxima"}</Etiqueta>
        </div>
        <button type="button" className="tarea-prog__nombre" aria-expanded={abierta} aria-controls={idDetalle} onClick={alAlternar}>
          <span className="tarea-prog__titulo">{t.nombre}</span>
          <span className="tarea-prog__descripcion">{t.descripcion}</span>
        </button>
        <span className="tarea-prog__canales">
          {t.entrega.map((e) => (
            <span key={`${e.canal}:${e.destino ?? ""}`} className="tarea-prog__canal">
              {nombreCanal(canales, e.canal)}
            </span>
          ))}
        </span>
        <div className="tarea-prog__ultima">
          {u?.estado === "error" && <span className="tarea-prog__marca tarea-prog__marca--error">Error</span>}
          {u?.estado === "en-curso" && (
            <span className="tarea-prog__marca">
              <i className="nx-punto nx-pulso" aria-hidden="true" />
              En curso
            </span>
          )}
          {u && (
            <span className="tarea-prog__ultima-texto" title={fechaCompleta(u.inicio)}>
              {[fechaRelativa(u.inicio, ahora), u.estado === "error" ? u.error : duracionEntre(u.inicio, u.fin)].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        <Interruptor activo={t.activa} alCambiar={(a) => void activar(a)} aria-label={t.nombre} />
      </div>
      {error && (
        <p className="automatizaciones__error" role="alert">
          {error}
        </p>
      )}
      {abierta && (
        <div id={idDetalle} className="tarea-prog__detalle">
          {editando ? (
            <FormularioTarea
              tarea={t}
              canales={canales}
              alCancelar={() => setEditando(false)}
              alGuardar={(n) => {
                alCambiar(n);
                setEditando(false);
              }}
            />
          ) : (
            <DetalleTarea t={t} canales={canales} ahora={ahora} alEditar={() => setEditando(true)} alBorrar={alBorrar} />
          )}
        </div>
      )}
    </article>
  );
}

function DetalleTarea({ t, canales, ahora, alEditar, alBorrar }: { t: TareaProgramada; canales?: InfoCanal[]; ahora: number; alEditar: () => void; alBorrar: () => void }) {
  const { proveedores, ajustes } = useEstado();
  const { llamar } = useAcciones();
  const [borrando, setBorrando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string>();
  const proveedor = t.proveedor || ajustes?.proveedor;

  const accion = async (f: () => Promise<unknown>) => {
    setOcupado(true);
    try {
      await f();
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <>
      <p className="tarea-prog__prompt">{t.prompt}</p>
      <dl className="tarea-prog__datos">
        <div>
          <dt className="nx-etiqueta">Cuándo</dt>
          <dd className="tarea-prog__mono">{t.cuando}</dd>
        </div>
        <div>
          <dt className="nx-etiqueta">Carpeta</dt>
          <dd className="tarea-prog__mono" title={t.cwd}>
            {t.cwd}
          </dd>
        </div>
        <div>
          <dt className="nx-etiqueta">Modelo</dt>
          <dd>{proveedor ? nombreModelo(proveedor, t.modelo, proveedores) : "Por defecto"}</dd>
        </div>
        <div>
          <dt className="nx-etiqueta">Permisos</dt>
          <dd>{MODOS[t.modoAprobacion]}</dd>
        </div>
        {t.entrega.length > 0 && (
          <div>
            <dt className="nx-etiqueta">Entrega</dt>
            <dd>{t.entrega.map((e) => (e.destino ? `${nombreCanal(canales, e.canal)} · ${e.destino}` : nombreCanal(canales, e.canal))).join(", ")}</dd>
          </div>
        )}
      </dl>
      <div className="tarea-prog__botones">
        <Boton variante="secundario" onClick={alEditar}>
          Editar
        </Boton>
        <Boton variante="secundario" disabled={ocupado} onClick={() => void accion(() => llamar("cron.ejecutar", { id: t.id }))}>
          Ejecutar ahora
        </Boton>
        {borrando ? (
          <ConfirmarBorrado ocupado={ocupado} alBorrar={() => void accion(async () => (await llamar("cron.borrar", { id: t.id }), alBorrar()))} alCancelar={() => setBorrando(false)} />
        ) : (
          <Boton variante="fantasma" icono="papelera" onClick={() => setBorrando(true)}>
            Borrar
          </Boton>
        )}
      </div>
      {error && (
        <p className="automatizaciones__error" role="alert">
          {error}
        </p>
      )}
      <Ejecuciones tareaId={t.id} canales={canales} ahora={ahora} />
    </>
  );
}

/** Historial de ejecuciones de una tarea, con su sesión y el resultado de cada entrega. */
function Ejecuciones({ tareaId, canales, ahora }: { tareaId: string; canales?: InfoCanal[]; ahora: number }) {
  const { revisiones, sesiones } = useEstado();
  const { llamar, abrirSesion } = useAcciones();
  const ejecuciones = useCarga(`ejecuciones:${tareaId}`, revisiones.cron, async () => (await llamar("cron.ejecuciones", { id: tareaId, limite: 20 })).ejecuciones);
  if (ejecuciones.error) {
    return (
      <p className="automatizaciones__error" role="alert">
        {ejecuciones.error}
      </p>
    );
  }
  if (!ejecuciones.datos?.length) return null;
  return (
    <section className="ejecuciones" aria-label="Ejecuciones">
      <Etiqueta>Ejecuciones</Etiqueta>
      <ol className="ejecuciones__lista">
        {ejecuciones.datos.map((x: EjecucionCron) => (
          <li key={x.id} className={clases("ejecucion", `ejecucion--${x.estado}`)}>
            <div className="ejecucion__cabecera">
              <span className="ejecucion__estado">
                {x.estado === "en-curso" ? <i className="nx-punto nx-pulso" aria-hidden="true" /> : <i className="ejecucion__punto" aria-hidden="true" />}
                {x.estado === "en-curso" ? "En curso" : x.estado === "ok" ? "Hecha" : "Error"}
              </span>
              <time className="ejecucion__fecha" dateTime={x.inicio} title={fechaCompleta(x.inicio)}>
                {[fechaConHora(x.inicio, ahora), duracionEntre(x.inicio, x.fin)].filter(Boolean).join(" · ")}
              </time>
              {x.sesionId && (
                <button type="button" className="origen__enlace" onClick={() => abrirSesion(x.sesionId!)}>
                  {sesiones[x.sesionId]?.titulo || "Abrir sesión"}
                </button>
              )}
            </div>
            {(x.error || x.resumen) && <p className="ejecucion__texto">{x.error ?? x.resumen}</p>}
            {x.entregas.length > 0 && (
              <ul className="ejecucion__entregas">
                {x.entregas.map((e) => (
                  <li key={`${e.canal}:${e.destino ?? ""}`} className={clases("entrega", !e.ok && "entrega--fallo")} title={e.error}>
                    {e.ok ? <span aria-hidden="true">✓</span> : <span aria-hidden="true">✗</span>}
                    <span>{[nombreCanal(canales, e.canal), e.destino].filter(Boolean).join(" · ")}</span>
                    {!e.ok && <span className="entrega__error">{e.error ?? "No entregado"}</span>}
                    {e.intentos > 1 && <span className="entrega__intentos">{e.intentos} intentos</span>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Interpreta «cuándo» mientras se escribe (cron.interpretar), con un poco de retraso. */
function useInterpretacion(cuando: string) {
  const { llamar } = useAcciones();
  const [pedido, setPedido] = useState(cuando.trim());
  useEffect(() => {
    const t = setTimeout(() => setPedido(cuando.trim()), 400);
    return () => clearTimeout(t);
  }, [cuando]);
  return useCarga(pedido || null, 0, () => llamar("cron.interpretar", { cuando: pedido }));
}

type Entrega = TareaProgramada["entrega"][number];

function FormularioTarea({
  tarea,
  canales,
  alGuardar,
  alCancelar,
}: {
  tarea?: TareaProgramada;
  canales?: InfoCanal[];
  alGuardar: (t: TareaProgramada) => void;
  alCancelar: () => void;
}) {
  const { ajustes, proveedores } = useEstado();
  const { llamar } = useAcciones();
  const [nombre, setNombre] = useState(tarea?.nombre ?? "");
  const [prompt, setPrompt] = useState(tarea?.prompt ?? "");
  const [cuando, setCuando] = useState(tarea?.cuando ?? "");
  const [cwd, setCwd] = useState(tarea?.cwd ?? ajustes?.carpeta ?? "");
  const [proveedor, setProveedor] = useState(tarea?.proveedor ?? "");
  const [modelo, setModelo] = useState(tarea?.modelo);
  const [modo, setModo] = useState<ModoAprobacion>(tarea?.modoAprobacion ?? ajustes?.modoAprobacion ?? "preguntar-ejecutar");
  const [entrega, setEntrega] = useState<Entrega[]>(tarea?.entrega ?? []);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string>();
  const interpretacion = useInterpretacion(cuando);
  const ahora = useReloj(30_000);
  const formulario = useRef<HTMLFormElement>(null);

  useEffect(() => formulario.current?.querySelector("input")?.focus(), []);

  // Los configurados, más los que ya tuviera la tarea aunque ahora no lo estén.
  const disponibles = (canales ?? []).filter((c) => c.configurado || entrega.some((e) => e.canal === c.id));
  const listo = !!nombre.trim() && !!prompt.trim() && !!cuando.trim() && !interpretacion.error && !guardando;

  const alternarCanal = (canal: IdCanal) =>
    setEntrega((l) => (l.some((e) => e.canal === canal) ? l.filter((e) => e.canal !== canal) : [...l, { canal }]));
  const cambiarDestino = (canal: IdCanal, destino: string) => setEntrega((l) => l.map((e) => (e.canal === canal ? { canal, ...(destino ? { destino } : {}) } : e)));

  const guardar = async () => {
    setGuardando(true);
    try {
      const datos = {
        nombre: nombre.trim(),
        prompt: prompt.trim(),
        cuando: cuando.trim(),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        modoAprobacion: modo,
        entrega: entrega.map((e) => ({ canal: e.canal, ...(e.destino?.trim() ? { destino: e.destino.trim() } : {}) })),
      };
      const t = tarea
        ? // Al editar, proveedor y modelo vacíos vuelven a los de por defecto.
          await llamar("cron.editar", { id: tarea.id, ...datos, proveedor, modelo: modelo ?? "" })
        : await llamar("cron.crear", { ...datos, ...(proveedor ? { proveedor } : {}), ...(modelo ? { modelo } : {}) });
      alGuardar(t);
    } catch (e) {
      setError(mensaje(e));
      setGuardando(false);
    }
  };

  return (
    <form
      ref={formulario}
      className="formulario-tarea"
      onSubmit={(e) => {
        e.preventDefault();
        if (listo) void guardar();
      }}
    >
      <Campo etiqueta="Nombre" value={nombre} maxLength={120} onChange={(e) => setNombre(e.target.value)} />
      <div className="nx-campo">
        <label htmlFor="tarea-prompt" className="nx-etiqueta">
          Prompt
        </label>
        <textarea id="tarea-prompt" className="campo-texto" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </div>
      <div className="formulario-tarea__cuando">
        <Campo
          etiqueta="Cuándo"
          mono
          spellCheck={false}
          placeholder="cada lunes 9:00"
          value={cuando}
          error={cuando.trim() && interpretacion.error ? interpretacion.error : undefined}
          onChange={(e) => setCuando(e.target.value)}
        />
        {cuando.trim() && interpretacion.datos && !interpretacion.error && (
          <div className="formulario-tarea__previa" aria-live="polite">
            <span className="formulario-tarea__descripcion">{interpretacion.datos.descripcion}</span>
            {interpretacion.datos.proximas.length > 0 && (
              <ul className="formulario-tarea__proximas">
                {interpretacion.datos.proximas.map((p) => (
                  <li key={p} title={fechaCompleta(p)}>
                    {fechaProxima(p, ahora)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <CampoCarpeta carpeta={cwd} alCambiar={setCwd} />
      <ProveedorModelo
        proveedores={proveedores}
        proveedor={proveedor}
        modelo={modelo}
        vacio="Por defecto"
        alCambiar={(p, m) => {
          setProveedor(p);
          setModelo(m);
        }}
      />
      <div className="nx-campo">
        <span className="nx-etiqueta" aria-hidden="true">
          Permisos
        </span>
        <OpcionesPermisos leyenda="Permisos" valor={modo} alCambiar={setModo} />
      </div>
      {disponibles.length > 0 && (
        <fieldset className="formulario-tarea__entrega">
          <legend className="nx-etiqueta">Entrega</legend>
          {disponibles.map((c) => {
            const elegido = entrega.find((e) => e.canal === c.id);
            return (
              <div key={c.id} className="formulario-tarea__canal">
                <button type="button" className="nx-chip" aria-pressed={!!elegido} onClick={() => alternarCanal(c.id)}>
                  {c.nombre}
                </button>
                {elegido && (
                  <input
                    className="formulario-tarea__destino"
                    aria-label={`Destino en ${c.nombre}`}
                    placeholder="Destino"
                    spellCheck={false}
                    value={elegido.destino ?? ""}
                    onChange={(e) => cambiarDestino(c.id, e.target.value)}
                  />
                )}
              </div>
            );
          })}
        </fieldset>
      )}
      {error && (
        <p className="automatizaciones__error" role="alert">
          {error}
        </p>
      )}
      <div className="formulario-tarea__botones">
        <Boton type="submit" variante="acento" disabled={!listo}>
          {tarea ? "Guardar" : "Crear"}
        </Boton>
        <Boton variante="fantasma" onClick={alCancelar}>
          Cancelar
        </Boton>
      </div>
    </form>
  );
}

