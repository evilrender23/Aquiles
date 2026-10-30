/** Ajustes → Plugins y Aplicación (arranque con Windows, actualizaciones, perfiles, copias y núcleo remoto). */
import type { InfoCopia } from "@aquiles/protocolo";
import { Boton, Campo, CampoInterruptor, Chip, Etiqueta, Interruptor, Medidor } from "@aquiles/ui";
import { useEffect, useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { fechaCompleta, fechaConHora, fechaRelativa } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import {
  type Actualizacion,
  type EstadoAtajo,
  type ProgresoActualizacion,
  alProgresoActualizacion,
  arranqueActivado,
  atajoActual,
  cambiarAtajo,
  buscarActualizacion,
  cambiarArranque,
  cambiarPerfil,
  conectarRemoto,
  desconectarRemoto,
  instalarActualizacion,
  remotoActual,
  versionApp,
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
        <article key={p.nombre} className="servidor-mcp plugin">
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
      ))}
    </div>
  );
}

export function SeccionAplicacion() {
  const tauri = enTauri();
  return (
    <>
      {tauri && <Arranque />}
      {tauri && <Atajo />}
      {tauri && <Actualizaciones />}
      <Perfiles />
      <Copias />
      {tauri && <Remoto />}
    </>
  );
}

function Arranque() {
  const [activo, setActivo] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    arranqueActivado().then(setActivo, (e) => setError(mensaje(e)));
  }, []);
  return (
    <div className="ajustes__grupo">
      <div className="ajustes__interruptores">
        <CampoInterruptor
          etiqueta="Arrancar con Windows"
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
      </div>
      <TextoError texto={error} />
    </div>
  );
}

/** Atajo global de la entrada rápida: el actual, si se registró (y por qué no), y un campo para cambiarlo. */
function Atajo() {
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
        <Campo etiqueta="Atajo de la entrada rápida" mono spellCheck={false} value={texto} onChange={(e) => setTexto(e.target.value)} />
        <Boton type="submit" variante="secundario" disabled={guardando || !texto.trim() || texto.trim() === estado?.atajo}>
          Cambiar
        </Boton>
      </form>
      {estado && !estado.registrado && <TextoError texto={estado.error ? `No registrado: ${estado.error}` : "No registrado"} />}
      <TextoError texto={error} />
    </div>
  );
}

function Actualizaciones() {
  const [version, setVersion] = useState<string>();
  const [busqueda, setBusqueda] = useState<{ tipo: "buscando" } | { tipo: "al-dia" } | { tipo: "hay"; a: Actualizacion }>();
  const [progreso, setProgreso] = useState<ProgresoActualizacion>();
  const [instalando, setInstalando] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    versionApp().then(setVersion, () => {});
    return alProgresoActualizacion(setProgreso);
  }, []);

  const buscar = async () => {
    setBusqueda({ tipo: "buscando" });
    setError(undefined);
    try {
      const a = await buscarActualizacion();
      setBusqueda(a ? { tipo: "hay", a } : { tipo: "al-dia" });
    } catch (e) {
      setBusqueda(undefined);
      setError(mensaje(e));
    }
  };

  const instalar = async () => {
    setInstalando(true);
    setError(undefined);
    try {
      // Si va bien, el instalador cierra y relanza la app: esto solo vuelve si falla.
      await instalarActualizacion();
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setInstalando(false);
      setProgreso(undefined);
    }
  };

  const fraccion = progreso?.total ? progreso.descargados / progreso.total : undefined;
  return (
    <div className="ajustes__grupo">
      <Etiqueta>Actualizaciones</Etiqueta>
      <div className="aplicacion__fila">
        {version && <span className="aplicacion__dato">Versión {version}</span>}
        <Boton variante="secundario" tamano="pequeno" disabled={busqueda?.tipo === "buscando" || instalando} onClick={() => void buscar()}>
          Buscar
        </Boton>
        {busqueda?.tipo === "al-dia" && <span className="ajustes__estado">Al día</span>}
      </div>
      {busqueda?.tipo === "hay" && (
        <div className="aplicacion__actualizacion">
          <span className="aplicacion__nueva">Versión {busqueda.a.version}</span>
          {busqueda.a.notas && <p className="aplicacion__notas">{busqueda.a.notas}</p>}
          {instalando ? (
            <div className="aplicacion__progreso">
              {fraccion !== undefined && <Medidor valor={fraccion} etiqueta="Descarga de la actualización" />}
              <span className="ajustes__estado">
                {progreso ? (progreso.total ? `${tamano(progreso.descargados)} de ${tamano(progreso.total)}` : tamano(progreso.descargados)) : "Descargando"}
              </span>
            </div>
          ) : (
            <div>
              <Boton variante="acento" tamano="pequeno" onClick={() => void instalar()}>
                Instalar
              </Boton>
            </div>
          )}
        </div>
      )}
      <TextoError texto={error} />
    </div>
  );
}

function Perfiles() {
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
      <Etiqueta>Perfiles</Etiqueta>
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

function Copias() {
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
      <Etiqueta>Copias</Etiqueta>
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

function Remoto() {
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
      <Etiqueta>Núcleo remoto</Etiqueta>
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
