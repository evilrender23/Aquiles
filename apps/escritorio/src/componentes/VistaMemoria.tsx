import type { BloqueMemoria, DestinoMemoria } from "@aquiles/protocolo";
import { Boton, BotonIcono, Medidor, Pestanas, Titular, idPestana, type Pestana } from "@aquiles/ui";
import { useEffect, useRef, useState } from "react";
import { cwdActiva, useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";

type IdPestana = DestinoMemoria | "alma";

const PANEL = "memoria-panel";
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cifra = (n: number) => n.toLocaleString("es-ES");

export function VistaMemoria() {
  const estado = useEstado();
  const { leerMemoria } = useAcciones();
  const cwd = cwdActiva(estado);
  const memoria = useCarga(`memoria:${cwd ?? ""}`, estado.revisiones.memoria, () => leerMemoria(cwd));
  const [elegida, setElegida] = useState<IdPestana>("usuario");
  const m = memoria.datos;

  const pestanas: Pestana<IdPestana>[] = [
    { id: "usuario", texto: "Tú" },
    { id: "agente", texto: "Agente" },
    ...(m?.proyecto ? [{ id: "proyecto" as const, texto: "Proyecto", titulo: m.proyecto.cwd }] : []),
    { id: "alma", texto: "Personalidad" },
  ];
  const activa = pestanas.some((p) => p.id === elegida) ? elegida : "usuario";

  const guardado = (destino: DestinoMemoria) => (b: BloqueMemoria) =>
    memoria.fijar((d) => (destino === "proyecto" ? (d.proyecto ? { ...d, proyecto: { ...b, cwd: d.proyecto.cwd } } : d) : { ...d, [destino]: b }));

  const bloque = activa === "alma" || !m ? undefined : activa === "proyecto" ? m.proyecto : m[activa];

  return (
    <div className="memoria">
      <div className="memoria__pagina">
        <Titular texto="Memoria" tamano="l" />
        {memoria.error && (
          <p className="memoria__error" role="alert">
            {memoria.error}
          </p>
        )}
        {m && (
          <>
            <Pestanas etiqueta="Memoria" pestanas={pestanas} activa={activa} alElegir={setElegida} idPanel={PANEL} />
            <div role="tabpanel" id={PANEL} aria-labelledby={idPestana(PANEL, activa)} className="memoria__panel">
              {activa === "alma" ? (
                <EditorAlma texto={m.alma} alGuardado={(alma) => memoria.fijar((d) => ({ ...d, alma }))} />
              ) : (
                bloque && (
                  <BloqueEditable
                    key={activa}
                    destino={activa}
                    bloque={bloque}
                    cwd={activa === "proyecto" ? m.proyecto?.cwd : undefined}
                    alGuardado={guardado(activa)}
                  />
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Dónde está ahora una entrada que se abrió en la posición `i` (el agente puede haber escrito mientras tanto). */
function posicion(entradas: string[], i: number, original: string): number {
  return entradas[i] === original ? i : entradas.indexOf(original);
}

type Edicion = { tipo: "editar"; i: number; original: string } | { tipo: "quitar"; i: number; original: string } | { tipo: "nueva" };

function BloqueEditable({
  destino,
  bloque,
  cwd,
  alGuardado,
}: {
  destino: DestinoMemoria;
  bloque: BloqueMemoria;
  cwd?: string;
  alGuardado: (b: BloqueMemoria) => void;
}) {
  const { guardarMemoria } = useAcciones();
  const [edicion, setEdicion] = useState<Edicion>();
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string>();
  const { entradas, usados, limite } = bloque;

  const cerrar = () => {
    setEdicion(undefined);
    setError(undefined);
  };

  const guardar = async (nuevas: string[]) => {
    setGuardando(true);
    try {
      alGuardado(await guardarMemoria(destino, nuevas, cwd));
      cerrar();
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setGuardando(false);
    }
  };

  const editar = (i: number, original: string, texto: string) => {
    const j = posicion(entradas, i, original);
    void guardar(j < 0 ? [...entradas, texto] : entradas.with(j, texto));
  };
  const quitar = (i: number, original: string) => {
    const j = posicion(entradas, i, original);
    if (j < 0) return cerrar();
    void guardar(entradas.filter((_, k) => k !== j));
  };

  const etiquetaUso = `${cifra(usados)} de ${cifra(limite)} caracteres`;

  return (
    <div className="memoria__bloque">
      <div className="memoria__uso">
        <div className="memoria__cifras">
          <span className="memoria__usados">{cifra(usados)}</span>
          <span className="memoria__limite">de {cifra(limite)} caracteres</span>
        </div>
        <Medidor valor={limite > 0 ? usados / limite : 0} etiqueta={etiquetaUso} />
      </div>

      {(entradas.length > 0 || edicion?.tipo === "nueva") && (
        <ul className="memoria__entradas">
          {entradas.map((texto, i) => {
            const esta = edicion && edicion.tipo !== "nueva" && edicion.i === i ? edicion.tipo : undefined;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: dos entradas pueden tener el mismo texto; la posición es su identidad.
              <li key={i} className="entrada">
                {esta === "editar" ? (
                  <EditorEntrada
                    etiqueta="Entrada"
                    inicial={texto}
                    guardando={guardando}
                    error={error}
                    alGuardar={(t) => editar(i, texto, t)}
                    alCancelar={cerrar}
                  />
                ) : (
                  <>
                    <p className="entrada__texto">{texto}</p>
                    {esta === "quitar" ? (
                      <ConfirmarQuitar guardando={guardando} error={error} alQuitar={() => quitar(i, texto)} alCancelar={cerrar} />
                    ) : (
                      <span className="entrada__acciones">
                        <BotonIcono
                          variante="pequeno"
                          etiqueta="Editar"
                          icono="lapiz"
                          tamanoIcono={15}
                          onClick={() => {
                            setError(undefined);
                            setEdicion({ tipo: "editar", i, original: texto });
                          }}
                        />
                        <BotonIcono
                          variante="pequeno"
                          etiqueta="Quitar"
                          icono="papelera"
                          tamanoIcono={15}
                          onClick={() => {
                            setError(undefined);
                            setEdicion({ tipo: "quitar", i, original: texto });
                          }}
                        />
                      </span>
                    )}
                  </>
                )}
              </li>
            );
          })}
          {edicion?.tipo === "nueva" && (
            <li className="entrada">
              <EditorEntrada etiqueta="Nueva entrada" inicial="" guardando={guardando} error={error} alGuardar={(t) => void guardar([...entradas, t])} alCancelar={cerrar} />
            </li>
          )}
        </ul>
      )}

      {edicion?.tipo !== "nueva" && (
        <div>
          <Boton
            variante="secundario"
            icono="mas"
            onClick={() => {
              setError(undefined);
              setEdicion({ tipo: "nueva" });
            }}
          >
            Añadir
          </Boton>
        </div>
      )}
    </div>
  );
}

/** Confirmación en la propia fila, con el foco en «Cancelar» (como al borrar una sesión). */
function ConfirmarQuitar({ guardando, error, alQuitar, alCancelar }: { guardando: boolean; error?: string; alQuitar: () => void; alCancelar: () => void }) {
  const cancelar = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelar.current?.focus(), []);
  return (
    <span className="entrada__confirmar">
      <Boton variante="acento" tamano="pequeno" disabled={guardando} onClick={alQuitar}>
        Quitar
      </Boton>
      <Boton variante="fantasma" tamano="pequeno" ref={cancelar} onClick={alCancelar} onKeyDown={(e) => e.key === "Escape" && alCancelar()}>
        Cancelar
      </Boton>
      {error && (
        <span className="entrada__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** Enter guarda, Mayús+Enter salta de línea, Escape cancela. */
function EditorEntrada({
  etiqueta,
  inicial,
  guardando,
  error,
  alGuardar,
  alCancelar,
}: {
  etiqueta: string;
  inicial: string;
  guardando: boolean;
  error?: string;
  alGuardar: (texto: string) => void;
  alCancelar: () => void;
}) {
  const [texto, setTexto] = useState(inicial);
  const caja = useRef<HTMLTextAreaElement>(null);
  const limpio = texto.trim();
  const listo = !!limpio && limpio !== inicial.trim() && !guardando;

  useEffect(() => {
    const t = caja.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);

  return (
    <div className="entrada-editor">
      <textarea
        ref={caja}
        aria-label={etiqueta}
        aria-invalid={error ? true : undefined}
        className="entrada-editor__texto"
        rows={2}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            alCancelar();
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (listo) alGuardar(limpio);
          }
        }}
      />
      <div className="entrada-editor__botones">
        <Boton variante="acento" tamano="pequeno" disabled={!listo} onClick={() => alGuardar(limpio)}>
          Guardar
        </Boton>
        <Boton variante="fantasma" tamano="pequeno" onClick={alCancelar}>
          Cancelar
        </Boton>
      </div>
      {error && (
        <p className="entrada__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** SOUL.md. Si llega una versión nueva del núcleo mientras se edita, se conserva lo escrito. */
function EditorAlma({ texto, alGuardado }: { texto: string; alGuardado: (texto: string) => void }) {
  const { guardarAlma } = useAcciones();
  const [borrador, setBorrador] = useState<string>();
  const [estado, setEstado] = useState<{ tipo: "guardando" } | { tipo: "ok" } | { tipo: "error"; texto: string }>();
  const valor = borrador ?? texto;
  const cambiado = borrador !== undefined && borrador !== texto;

  const guardar = async () => {
    if (borrador === undefined) return;
    setEstado({ tipo: "guardando" });
    try {
      alGuardado(await guardarAlma(borrador));
      setBorrador(undefined);
      setEstado({ tipo: "ok" });
    } catch (e) {
      setEstado({ tipo: "error", texto: mensaje(e) });
    }
  };

  return (
    <div className="alma">
      <textarea
        aria-label="Personalidad"
        className="alma__texto"
        spellCheck={false}
        value={valor}
        onChange={(e) => {
          setBorrador(e.target.value);
          setEstado(undefined);
        }}
      />
      <div className="alma__pie">
        <Boton variante="principal" iconoFinal="flecha-diagonal" disabled={!cambiado || estado?.tipo === "guardando"} onClick={() => void guardar()}>
          Guardar
        </Boton>
        {estado?.tipo === "ok" && <span className="alma__estado">Guardado</span>}
        {estado?.tipo === "error" && (
          <span className="alma__estado alma__estado--error" role="alert">
            {estado.texto}
          </span>
        )}
      </div>
    </div>
  );
}
