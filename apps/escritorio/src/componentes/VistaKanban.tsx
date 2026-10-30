/** Kanban multiagente: tarjetas en columnas; cada una se puede encargar a un agente, que trabaja en su propia sesión. */
import type { ColumnaKanban, TarjetaKanban } from "@aquiles/protocolo";
import { COLUMNAS_KANBAN } from "@aquiles/protocolo";
import { Boton, BotonIcono, Campo, Etiqueta, Titular, clases, useMenuContextual } from "@aquiles/ui";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { cwdActiva, useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { nombreCarpeta } from "../estado/formato";
import { CampoCarpeta, ConfirmarBorrado } from "./Campos";

const COLUMNAS: Record<ColumnaKanban, string> = { pendiente: "Pendiente", "en-curso": "En curso", revision: "Revisión", hecha: "Hecha" };
const AGENTE: Record<NonNullable<TarjetaKanban["agente"]>, string> = { trabajando: "Trabajando", terminado: "Terminado", error: "Error" };
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));
const porOrden = (a: TarjetaKanban, b: TarjetaKanban) => a.orden - b.orden;

/** Orden para quedar en la posición `i` de `lista` (ya sin la tarjeta que se mueve): entre sus vecinas. */
function ordenEn(lista: TarjetaKanban[], i: number): number {
  const antes = lista[i - 1]?.orden;
  const despues = lista[i]?.orden;
  if (antes !== undefined && despues !== undefined) return (antes + despues) / 2;
  if (antes !== undefined) return antes + 1;
  if (despues !== undefined) return despues - 1;
  return 0;
}

export function VistaKanban() {
  const estado = useEstado();
  const { llamar } = useAcciones();
  const tarjetas = useCarga("kanban", estado.revisiones.kanban, async () => (await llamar("kanban.listar", {})).tarjetas);
  const [creando, setCreando] = useState(false);
  const [arrastrada, setArrastrada] = useState<string>();
  const [destino, setDestino] = useState<{ columna: ColumnaKanban; indice: number }>();
  const [error, setError] = useState<string>();
  const lista = tarjetas.datos ?? [];

  const actualizar = (t: TarjetaKanban) => tarjetas.fijar((l) => (l.some((x) => x.id === t.id) ? l.map((x) => (x.id === t.id ? t : x)) : [...l, t]));

  const mover = async (id: string, columna: ColumnaKanban, indice: number) => {
    const resto = lista.filter((x) => x.columna === columna && x.id !== id).sort(porOrden);
    const orden = ordenEn(resto, indice);
    const previa = lista.find((x) => x.id === id);
    if (!previa || (previa.columna === columna && previa.orden === orden)) return;
    // Se mueve ya en pantalla; si el núcleo no lo acepta, vuelve a su sitio.
    actualizar({ ...previa, columna, orden });
    try {
      actualizar(await llamar("kanban.editar", { id, columna, orden }));
      setError(undefined);
    } catch (e) {
      actualizar(previa);
      setError(mensaje(e));
    }
  };

  /** Dónde caería lo arrastrado según la altura del puntero sobre las tarjetas de la columna. */
  const indiceDeCaida = (e: DragEvent<HTMLElement>): number => {
    const tarjetasColumna = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-tarjeta]")].filter((n) => n.dataset.tarjeta !== arrastrada);
    const i = tarjetasColumna.findIndex((n) => {
      const r = n.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return i < 0 ? tarjetasColumna.length : i;
  };

  return (
    <div className="kanban">
      <div className="kanban__cabecera">
        <Titular texto="Kanban" tamano="l" />
        {!creando && (
          <Boton variante="principal" iconoFinal="flecha-diagonal" disabled={!tarjetas.datos} onClick={() => setCreando(true)}>
            Nueva tarjeta
          </Boton>
        )}
      </div>
      {(tarjetas.error || error) && (
        <p className="automatizaciones__error" role="alert">
          {error ?? tarjetas.error}
        </p>
      )}
      {creando && (
        <FormularioTarjeta
          cwd={cwdActiva(estado) ?? estado.ajustes?.carpeta ?? ""}
          alCancelar={() => setCreando(false)}
          alGuardar={(t) => {
            actualizar(t);
            setCreando(false);
          }}
        />
      )}
      {tarjetas.datos && (
        <div className="kanban__columnas">
          {COLUMNAS_KANBAN.map((columna, ci) => {
            const enColumna = lista.filter((x) => x.columna === columna).sort(porOrden);
            const visibles = enColumna.filter((x) => x.id !== arrastrada);
            return (
              <section
                key={columna}
                className={clases("kanban__columna", destino?.columna === columna && "kanban__columna--destino")}
                aria-labelledby={`kanban-${columna}`}
                onDragOver={(e) => {
                  if (!arrastrada) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const indice = indiceDeCaida(e);
                  if (destino?.columna !== columna || destino.indice !== indice) setDestino({ columna, indice });
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDestino(undefined);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData("text/plain") || arrastrada;
                  const indice = indiceDeCaida(e);
                  setArrastrada(undefined);
                  setDestino(undefined);
                  if (id) void mover(id, columna, indice);
                }}
              >
                <div className="kanban__titulo-columna">
                  <Etiqueta id={`kanban-${columna}`}>{COLUMNAS[columna]}</Etiqueta>
                  <span className="kanban__cuenta">{enColumna.length}</span>
                </div>
                <ol className="kanban__lista">
                  {visibles.map((t, i) => (
                    <li key={t.id} data-tarjeta={t.id} className={clases(destino?.columna === columna && destino.indice === i && "kanban__hueco-antes")}>
                      <Tarjeta
                        t={t}
                        alArrastrar={(a) => {
                          setArrastrada(a ? t.id : undefined);
                          if (!a) setDestino(undefined);
                        }}
                        alMover={(d) => {
                          const otra = COLUMNAS_KANBAN[ci + d];
                          if (otra) void mover(t.id, otra, lista.filter((x) => x.columna === otra).length);
                        }}
                        alMoverA={(otra) => void mover(t.id, otra, lista.filter((x) => x.columna === otra).length)}
                        puedeIzquierda={ci > 0}
                        puedeDerecha={ci < COLUMNAS_KANBAN.length - 1}
                        alCambiar={actualizar}
                        alBorrar={() => tarjetas.fijar((l) => l.filter((x) => x.id !== t.id))}
                      />
                    </li>
                  ))}
                  {destino?.columna === columna && destino.indice >= visibles.length && <li className="kanban__hueco" aria-hidden="true" />}
                </ol>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Tarjeta({
  t,
  alArrastrar,
  alMover,
  alMoverA,
  puedeIzquierda,
  puedeDerecha,
  alCambiar,
  alBorrar,
}: {
  t: TarjetaKanban;
  alArrastrar: (arrastrando: boolean) => void;
  alMover: (direccion: -1 | 1) => void;
  alMoverA: (columna: ColumnaKanban) => void;
  puedeIzquierda: boolean;
  puedeDerecha: boolean;
  alCambiar: (t: TarjetaKanban) => void;
  alBorrar: () => void;
}) {
  const { sesiones } = useEstado();
  const { llamar, abrirSesion, detener } = useAcciones();
  const [editando, setEditando] = useState(false);
  const [encargando, setEncargando] = useState(false);
  const [error, setError] = useState<string>();

  const encargar = async () => {
    setEncargando(true);
    try {
      alCambiar(await llamar("kanban.ejecutar", { id: t.id }));
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setEncargando(false);
    }
  };

  // Encargar o Parar según el agente en el momento de abrir el menú.
  const menu = useMenuContextual(() => [
    t.agente === "trabajando" && t.sesionId
      ? { texto: "Parar", icono: "detener", alElegir: () => detener(t.sesionId!) }
      : { texto: "Encargar", icono: "play", alElegir: () => void encargar() },
    t.sesionId && sesiones[t.sesionId] && { texto: "Abrir sesión", icono: "flecha-diagonal", alElegir: () => abrirSesion(t.sesionId!) },
    {
      tipo: "submenu",
      texto: "Mover a",
      elementos: COLUMNAS_KANBAN.filter((c) => c !== t.columna).map((c) => ({ texto: COLUMNAS[c], alElegir: () => alMoverA(c) })),
    },
    { tipo: "separador" },
    { texto: "Editar", icono: "lapiz", alElegir: () => setEditando(true) },
    {
      texto: "Borrar",
      icono: "papelera",
      peligrosa: true,
      alElegir: () =>
        void llamar("kanban.borrar", { id: t.id }).then(alBorrar, (e: unknown) => setError(mensaje(e))),
    },
  ]);

  if (editando) {
    return (
      <FormularioTarjeta
        tarjeta={t}
        alCancelar={() => setEditando(false)}
        alGuardar={(n) => {
          alCambiar(n);
          setEditando(false);
        }}
        alBorrar={alBorrar}
      />
    );
  }

  return (
    <article
      className={clases("tarjeta-kanban", t.agente && `tarjeta-kanban--${t.agente}`)}
      draggable
      {...menu}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
        alArrastrar(true);
      }}
      onDragEnd={() => alArrastrar(false)}
    >
      <h3 className="tarjeta-kanban__titulo">{t.titulo}</h3>
      {t.descripcion && (
        <p className="tarjeta-kanban__descripcion" title={t.descripcion}>
          {t.descripcion}
        </p>
      )}
      <span className="tarjeta-kanban__carpeta" title={t.cwd}>
        {nombreCarpeta(t.cwd)}
      </span>
      {t.agente && (
        <div className="tarjeta-kanban__agente">
          <span className="tarjeta-kanban__estado">
            {t.agente === "trabajando" ? <i className="nx-punto nx-pulso" aria-hidden="true" /> : <i className="tarjeta-kanban__punto" aria-hidden="true" />}
            {AGENTE[t.agente]}
          </span>
          {t.sesionId && (
            <button type="button" className="origen__enlace" onClick={() => abrirSesion(t.sesionId!)}>
              {sesiones[t.sesionId]?.titulo || "Sesión"}
            </button>
          )}
        </div>
      )}
      {(t.error || error) && (
        <p className="tarjeta-kanban__error" role="alert">
          {error ?? t.error}
        </p>
      )}
      <div className="tarjeta-kanban__botones">
        {t.agente !== "trabajando" && (
          <Boton variante="acento" tamano="pequeno" disabled={encargando} onClick={() => void encargar()}>
            Encargar
          </Boton>
        )}
        <span className="tarjeta-kanban__hueco" />
        <BotonIcono variante="pequeno" etiqueta="Mover a la columna anterior" icono="chevron-derecha" className="tarjeta-kanban__izquierda" tamanoIcono={15} disabled={!puedeIzquierda} onClick={() => alMover(-1)} />
        <BotonIcono variante="pequeno" etiqueta="Mover a la columna siguiente" icono="chevron-derecha" tamanoIcono={15} disabled={!puedeDerecha} onClick={() => alMover(1)} />
        <BotonIcono variante="pequeno" etiqueta="Editar" icono="lapiz" tamanoIcono={15} onClick={() => setEditando(true)} />
      </div>
    </article>
  );
}

function FormularioTarjeta({
  tarjeta,
  cwd: cwdInicial = "",
  alGuardar,
  alCancelar,
  alBorrar,
}: {
  tarjeta?: TarjetaKanban;
  cwd?: string;
  alGuardar: (t: TarjetaKanban) => void;
  alCancelar: () => void;
  alBorrar?: () => void;
}) {
  const { llamar } = useAcciones();
  const [titulo, setTitulo] = useState(tarjeta?.titulo ?? "");
  const [descripcion, setDescripcion] = useState(tarjeta?.descripcion ?? "");
  const [cwd, setCwd] = useState(tarjeta?.cwd ?? cwdInicial);
  const [guardando, setGuardando] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const [error, setError] = useState<string>();
  const formulario = useRef<HTMLFormElement>(null);
  const listo = !!titulo.trim() && !guardando;

  useEffect(() => formulario.current?.querySelector("input")?.focus(), []);

  const guardar = async () => {
    setGuardando(true);
    try {
      alGuardar(
        tarjeta
          ? await llamar("kanban.editar", { id: tarjeta.id, titulo: titulo.trim(), descripcion })
          : await llamar("kanban.crear", { titulo: titulo.trim(), ...(descripcion.trim() ? { descripcion } : {}), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }),
      );
    } catch (e) {
      setError(mensaje(e));
      setGuardando(false);
    }
  };

  const borrar = async () => {
    if (!tarjeta) return;
    try {
      await llamar("kanban.borrar", { id: tarjeta.id });
      alBorrar?.();
    } catch (e) {
      setError(mensaje(e));
    }
  };

  return (
    <form
      ref={formulario}
      className={clases("formulario-tarea", "formulario-kanban", tarjeta && "formulario-kanban--tarjeta")}
      onSubmit={(e) => {
        e.preventDefault();
        if (listo) void guardar();
      }}
      onKeyDown={(e) => e.key === "Escape" && alCancelar()}
    >
      <Campo etiqueta="Título" value={titulo} maxLength={200} onChange={(e) => setTitulo(e.target.value)} />
      <div className="nx-campo">
        <label htmlFor={`kanban-descripcion-${tarjeta?.id ?? "nueva"}`} className="nx-etiqueta">
          Descripción
        </label>
        <textarea
          id={`kanban-descripcion-${tarjeta?.id ?? "nueva"}`}
          className="campo-texto"
          rows={3}
          maxLength={20_000}
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
        />
      </div>
      {!tarjeta && <CampoCarpeta carpeta={cwd} alCambiar={setCwd} />}
      {error && (
        <p className="automatizaciones__error" role="alert">
          {error}
        </p>
      )}
      <div className="formulario-tarea__botones">
        <Boton type="submit" variante="acento" tamano={tarjeta ? "pequeno" : "normal"} disabled={!listo}>
          {tarjeta ? "Guardar" : "Crear"}
        </Boton>
        <Boton variante="fantasma" tamano={tarjeta ? "pequeno" : "normal"} onClick={alCancelar}>
          Cancelar
        </Boton>
        {tarjeta &&
          (borrando ? (
            <ConfirmarBorrado alBorrar={() => void borrar()} alCancelar={() => setBorrando(false)} />
          ) : (
            <Boton variante="fantasma" tamano="pequeno" icono="papelera" onClick={() => setBorrando(true)}>
              Borrar
            </Boton>
          ))}
      </div>
    </form>
  );
}
