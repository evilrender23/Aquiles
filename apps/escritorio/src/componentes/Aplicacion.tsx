/** Piezas de Ajustes: plugins (Herramientas), arranque y atajo (General), actualizaciones, perfiles, copias y núcleo remoto (Aplicación). */
import type { InfoCopia } from "@aquiles/protocolo";
import { Boton, Campo, CampoInterruptor, Chip, ConMenuContextual, Interruptor, Medidor, copiarTexto } from "@aquiles/ui";
import { useCallback, useEffect, useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { fechaCompleta, fechaConHora, fechaRelativa } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import {
  type EstadoActualizacion,
  abrirCarpeta,
  puedeMostrarRutas,
  type EstadoAtajo,
  type InfoActualizacion,
  actualizarSolo,
  alActualizacionLista,
  alErrorActualizacion,
  alProgresoActualizacion,
  aplicarActualizacion,
  arranqueActivado,
  atajoActual,
  buscarActualizacion,
  cambiarActualizarSolo,
  cambiarArranque,
  cambiarAtajo,
  cambiarPerfil,
  conectarRemoto,
  desconectarRemoto,
  estadoActualizacion,
  instalarActualizacion,
  remotoActual,
} from "../plataforma/aplicacion";
import { enTauri } from "../plataforma/tauri";
import { ConfirmarBorrado } from "./Campos";

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NOMBRE_PERFIL = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** 820 kB, 12,3 MB… */
function tamano(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function TextoError({ texto }: { texto?: string }) {
  if (!texto) return null;
  return (
    <p className="ajustes__estado ajustes__estado--error" role="alert">
      {texto}
    </p>
  );
}

export function SeccionPlugins() {
  const { revisiones } = useEstado();
  const { llamar } = useAcciones();
  const plugins = useCarga("plugins", revisiones.plugins, async () => (await llamar("plugins.listar", {})).plugins);
  const [error, setError] = useState<string>();

  if (plugins.error) return <TextoError texto={plugins.error} />;
  if (!plugins.datos) return null;
  if (!plugins.datos.length) return <p className="ajustes__estado">Sin plugins</p>;

  const activar = async (nombre: string, activo: boolean) => {
    try {
      const p = await llamar("plugins.activar", { nombre, activo });
      plugins.fijar((l) => l.map((x) => (x.nombre === p.nombre ? p : x)));
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    }
  };

  return (
    <div className="plugins">
      <TextoError texto={error} />
      {plugins.datos.map((p) => (
        <ConMenuContextual
          key={p.nombre}
          construir={() => [
            { texto: p.activo ? "Desactivar" : "Activar", alElegir: () => void activar(p.nombre, !p.activo) },
            { tipo: "separador" },
            { texto: "Copiar ruta", icono: "copiar", alElegir: () => copiarTexto(p.ruta) },
            puedeMostrarRutas() && { texto: "Mostrar carpeta", icono: "carpeta", alElegir: () => abrirCarpeta(p.ruta) },
          ]}
        >
          {(menu) => (
        <article className="servidor-mcp plugin" {...menu}>
          <div className="servidor-mcp__cabecera">
            <div className="servidor-mcp__datos">
              <span className="servidor-mcp__nombre">{p.nombre}</span>
              <span className="servidor-mcp__origen" title={p.ruta}>
                {p.ruta}
              </span>
            </div>
            <Interruptor activo={p.activo} alCambiar={(a) => void activar(p.nombre, a)} aria-label={`${p.nombre} activo`} />
          </div>
          {p.descripcion && <p className="plugin__descripcion">{p.descripcion}</p>}
          {p.error && (
            <p className="servidor-mcp__error" role="alert">
              {p.error}
            </p>
          )}
          {p.activo && !p.error && <span className="plugin__estado">{p.cargado ? "Cargado" : "Sin cargar"}</span>}
          {p.herramientas.length > 0 && (
            <ul className="plugin__herramientas">
              {p.herramientas.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
        </article>
          )}
        </ConMenuContextual>
      ))}
    </div>
  );
}

export function Arranque() {
  const [activo, setActivo] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    arranqueActivado().then(setActivo, (e) => setError(mensaje(e)));
  }, []);
  return (
    <>
      <Interruptor
        aria-label="Arrancar con Windows"
        activo={!!activo}
        disabled={activo === undefined}
        alCambiar={async (a) => {
          try {
            await cambiarArranque(a);
            setActivo(await arranqueActivado());
            setError(undefined);
          } catch (e) {
            setError(mensaje(e));
          }
        }}
      />
      <TextoError texto={error} />
    </>
  );
}

/** Atajo global de la entrada rápida: el actual, si se registró (y por qué no), y un campo para cambiarlo. */
export function Atajo() {
  const [estado, setEstado] = useState<EstadoAtajo>();
  const [texto, setTexto] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    atajoActual().then(
      (e) => {
        setEstado(e);
        setTexto(e?.atajo ?? "");
      },
      (e) => setError(mensaje(e)),
    );
  }, []);

  const cambiar = async () => {
    setGuardando(true);
    try {
      const e = await cambiarAtajo(texto.trim());
      setEstado(e);
      if (e) setTexto(e.atajo);
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="ajustes__grupo">
      <form
        className="aplicacion__crear"
        onSubmit={(e) => {
          e.preventDefault();
          if (texto.trim() && texto.trim() !== estado?.atajo) void cambiar();
        }}
      >
        <Campo etiqueta="Teclas" mono spellCheck={false} value={texto} onChange={(e) => setTexto(e.target.value)} />
        <Boton type="submit" variante="secundario" disabled={guardando || !texto.trim() || texto.trim() === estado?.atajo}>
          Cambiar
        </Boton>
      </form>
      {estado && !estado.registrado && <TextoError texto={estado.error ? `No registrado: ${estado.error}` : "No registrado"} />}
      <TextoError texto={error} />
    </div>
  );
}

/**
 * Actualizaciones: la app se compila desde `main`. Versión = commit; «Actualizar» compila en segundo plano
 * (por pasos) y, cuando está lista, «Reiniciar para actualizar» cambia las carpetas y vuelve a abrir la app.
 */
export function Actualizaciones() {
  const [info, setInfo] = useState<InfoActualizacion>();
  const [buscando, setBuscando] = useState(false);
  const [estado, setEstado] = useState<EstadoActualizacion>({ fase: "inactiva" });
  const [solo, setSolo] = useState<boolean>();
  const [error, setError] = useState<string>();
  const ahora = useReloj(60_000);

  const buscar = useCallback(async () => {
    setBuscando(true);
    try {
      setInfo(await buscarActualizacion());
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setBuscando(false);
    }
  }, []);

  useEffect(() => {
    void buscar();
    estadoActualizacion().then((e) => e && setEstado(e), () => {});
    actualizarSolo().then(setSolo, () => {});
    const soltar = [
      alProgresoActualizacion((p) => setEstado({ fase: "compilando", ...p })),
      alActualizacionLista((d) => setEstado({ fase: "lista", commit: d.commit })),
      alErrorActualizacion((d) => setEstado({ fase: "error", texto: d.texto })),
    ];
    return () => {
      for (const f of soltar) f();
    };
  }, [buscar]);

  const actuar = async (f: () => Promise<void>) => {
    try {
      await f();
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    }
  };

  const fecha = info?.fecha && !Number.isNaN(new Date(info.fecha).getTime()) ? fechaRelativa(info.fecha, ahora) : info?.fecha;
  const compilando = estado.fase === "compilando";
  return (
    <div className="ajustes__grupo">
      <div className="aplicacion__fila">
        {info && <span className="aplicacion__dato">{info.desarrollo ? "Compilación de desarrollo" : info.actual ? `Versión ${info.actual}` : "Versión desconocida"}</span>}
        {info?.desarrollo ? (
          // Una copia suelta no se actualiza: se instala desde main (%LOCALAPPDATA%\Aquiles) y esa sí.
          estado.fase !== "compilando" &&
          estado.fase !== "lista" && (
            <Boton variante="acento" tamano="pequeno" onClick={() => void actuar(instalarActualizacion)}>
              Instalar con actualizaciones
            </Boton>
          )
        ) : (
          <>
            <Boton variante="secundario" tamano="pequeno" disabled={buscando || compilando} onClick={() => void buscar()}>
              Buscar
            </Boton>
            {info && !info.hayNueva && !buscando && <span className="ajustes__estado">Al día</span>}
          </>
        )}
      </div>
      {info?.hayNueva && (
        <div className="aplicacion__actualizacion">
          <span className="aplicacion__nueva">
            {info.ultimo}
            {fecha && <span className="aplicacion__detalle"> · {fecha}</span>}
          </span>
          {info.mensaje && <p className="aplicacion__notas">{info.mensaje}</p>}
          {estado.fase !== "compilando" && estado.fase !== "lista" && (
            <div>
              <Boton variante="acento" tamano="pequeno" onClick={() => void actuar(instalarActualizacion)}>
                Actualizar
              </Boton>
            </div>
          )}
        </div>
      )}
      {estado.fase === "compilando" && (
        <div className="aplicacion__progreso">
          {estado.total > 0 && <Medidor valor={estado.paso / estado.total} etiqueta="Compilación de la actualización" />}
          <span className="ajustes__estado">{estado.total > 0 ? `${estado.texto} · ${estado.paso} de ${estado.total}` : estado.texto}</span>
        </div>
      )}
      {estado.fase === "lista" && (
        <div className="aplicacion__fila">
          <span className="aplicacion__dato">Versión {estado.commit}</span>
          <Boton variante="acento" tamano="pequeno" onClick={() => void actuar(aplicarActualizacion)}>
            {info?.desarrollo ? "Abrir la versión instalada" : "Reiniciar para actualizar"}
          </Boton>
        </div>
      )}
      {estado.fase === "error" && <TextoError texto={estado.texto} />}
      {solo !== undefined && (
        <div className="ajustes__interruptores">
          <CampoInterruptor
            etiqueta="Actualizar solo"
            activo={solo}
            alCambiar={(a) =>
              void actuar(async () => {
                await cambiarActualizarSolo(a);
                setSolo(await actualizarSolo());
              })
            }
          />
        </div>
      )}
      <TextoError texto={error} />
    </div>
  );
}

export function Perfiles() {
  const { llamar, prepararReinicio, reconectar } = useAcciones();
  const perfiles = useCarga("perfiles", 0, () => llamar("perfiles.listar", {}));
  const [nombre, setNombre] = useState("");
  const [error, setError] = useState<string>();
  const ahora = useReloj(60_000);
  const valido = NOMBRE_PERFIL.test(nombre);

  const crear = async () => {
    try {
      const p = await llamar("perfiles.crear", { nombre });
      perfiles.fijar((d) => ({ ...d, perfiles: [...d.perfiles.filter((x) => x.nombre !== p.nombre), p] }));
      setNombre("");
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    }
  };

  const cambiar = async (n: string) => {
    // El núcleo se relanza con el otro perfil: la desconexión no es un error.
    prepararReinicio(`Perfil ${n}`);
    try {
      await cambiarPerfil(n);
    } catch (e) {
      setError(mensaje(e));
      reconectar();
    }
  };

  return (
    <div className="ajustes__grupo">
      <TextoError texto={perfiles.error} />
      {perfiles.datos && (
        <ul className="aplicacion__lista">
          {perfiles.datos.perfiles.map((p) => {
            const actual = p.nombre === perfiles.datos?.actual;
            return (
              <li key={p.nombre} className="aplicacion__elemento">
                <div className="aplicacion__datos">
                  <span className="aplicacion__nombre">
                    {p.nombre}
                    {actual && <Chip destacado>Actual</Chip>}
                  </span>
                  <span className="aplicacion__detalle" title={p.actualizado ? fechaCompleta(p.actualizado) : undefined}>
                    {[p.sesiones === 1 ? "1 sesión" : `${p.sesiones} sesiones`, p.actualizado && fechaRelativa(p.actualizado, ahora)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                {!actual && enTauri() && (
                  <Boton variante="fantasma" tamano="pequeno" onClick={() => void cambiar(p.nombre)}>
                    Cambiar
                  </Boton>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="aplicacion__crear"
        onSubmit={(e) => {
          e.preventDefault();
          if (valido) void crear();
        }}
      >
        <Campo
          etiqueta="Nuevo perfil"
          mono
          spellCheck={false}
          maxLength={40}
          value={nombre}
          error={nombre && !valido ? "Minúsculas, cifras, - y _" : undefined}
          onChange={(e) => setNombre(e.target.value)}
        />
        <Boton type="submit" variante="secundario" disabled={!valido}>
          Crear
        </Boton>
      </form>
      <TextoError texto={error} />
    </div>
  );
}

export function Copias() {
  const { llamar, prepararReinicio } = useAcciones();
  const copias = useCarga("copias", 0, async () => (await llamar("copias.listar", {})).copias);
  const [creando, setCreando] = useState(false);
  const [restaurando, setRestaurando] = useState<string>();
  const [error, setError] = useState<string>();
  const ahora = useReloj(60_000);

  const crear = async () => {
    setCreando(true);
    try {
      const c = await llamar("copias.crear", {});
      copias.fijar((l) => [c, ...l.filter((x) => x.nombre !== c.nombre)]);
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setCreando(false);
    }
  };

  const restaurar = async (c: InfoCopia) => {
    try {
      await llamar("copias.restaurar", { nombre: c.nombre });
      prepararReinicio("Restaurando la copia");
    } catch (e) {
      setError(mensaje(e));
      setRestaurando(undefined);
    }
  };

  return (
    <div className="ajustes__grupo">
      <TextoError texto={copias.error} />
      {copias.datos && copias.datos.length > 0 && (
        <ul className="aplicacion__lista">
          {copias.datos.map((c) => (
            <li key={c.nombre} className="aplicacion__elemento">
              <div className="aplicacion__datos">
                <time className="aplicacion__nombre" dateTime={c.fecha} title={fechaCompleta(c.fecha)}>
                  {fechaConHora(c.fecha, ahora)}
                </time>
                <span className="aplicacion__detalle">
                  {c.perfil} · {tamano(c.bytes)}
                </span>
              </div>
              {restaurando === c.nombre ? (
                <ConfirmarBorrado texto="Restaurar" alBorrar={() => void restaurar(c)} alCancelar={() => setRestaurando(undefined)} />
              ) : (
                <Boton variante="fantasma" tamano="pequeno" onClick={() => setRestaurando(c.nombre)}>
                  Restaurar
                </Boton>
              )}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Boton variante="secundario" disabled={creando || !copias.datos} onClick={() => void crear()}>
          Crear copia
        </Boton>
      </div>
      <TextoError texto={error} />
    </div>
  );
}

export function Remoto() {
  const { prepararReinicio, reconectar } = useAcciones();
  const [actual, setActual] = useState<string | null>();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    remotoActual().then(setActual, (e) => setError(mensaje(e)));
  }, []);

  /** Cambia de núcleo: la conexión cae a propósito y vuelve con el nuevo. */
  const cambiar = async (f: () => Promise<void>, motivo: string) => {
    prepararReinicio(motivo);
    try {
      await f();
      setActual(await remotoActual());
      setToken("");
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
      reconectar();
    }
  };

  return (
    <div className="ajustes__grupo">
      {actual ? (
        <div className="aplicacion__fila">
          <span className="aplicacion__dato aplicacion__dato--mono">{actual}</span>
          <Boton variante="secundario" tamano="pequeno" onClick={() => void cambiar(desconectarRemoto, "Núcleo local")}>
            Desconectar
          </Boton>
        </div>
      ) : (
        <form
          className="aplicacion__remoto"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() && token.trim()) void cambiar(() => conectarRemoto(url.trim(), token.trim()), "Núcleo remoto");
          }}
        >
          <div className="ajustes__rejilla">
            <Campo etiqueta="URL" mono spellCheck={false} placeholder="wss://host:puerto" value={url} onChange={(e) => setUrl(e.target.value)} />
            <Campo etiqueta="Token" type="password" mono autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div>
            <Boton type="submit" variante="secundario" disabled={!url.trim() || !token.trim()}>
              Conectar
            </Boton>
          </div>
        </form>
      )}
      <TextoError texto={error} />
    </div>
  );
}
