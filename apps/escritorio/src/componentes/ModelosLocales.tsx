/** Modelos locales: GGUF de Hugging Face que ejecuta llama.cpp (proveedor `llamacpp`). */
import type { FicheroModeloHF, ModeloLocalInfo, ProgresoDescargaModelo, ResultadoModeloHF } from "@aquiles/protocolo";
import { Boton, BotonIcono, Campo, CampoBusqueda, Chip, ConMenuContextual, Etiqueta, Icono, LatticeLoader, Medidor, Selector, clases, copiarTexto } from "@aquiles/ui";
import { useId, useState, type ReactNode } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { tokens } from "../estado/formato";
import { abrirCarpeta, puedeMostrarRutas } from "../plataforma/aplicacion";
import { ConfirmarBorrado } from "./Campos";

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

function gigas(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1).replace(".", ",")} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

const compacto = new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 1 });

/** Proyector por defecto: el F16 (el habitual), o el primero. */
const proyectorPreferido = (p: FicheroModeloHF[]) => (p.find((x) => /(^|[^a-z])f16/i.test(x.cuantizacion ?? x.nombre)) ?? p[0])?.nombre;

export function SeccionModelos({
  porDefecto,
  alUsar,
  children,
}: {
  /** Id del modelo local que está como predeterminado, si lo hay. */
  porDefecto?: string;
  alUsar: (id: string) => Promise<void>;
  /** Clave de Hugging Face (la pinta Ajustes, que la guarda con las demás). */
  children?: ReactNode;
}) {
  const { revisiones, descargasModelos } = useEstado();
  const { llamar } = useAcciones();
  // Una descarga que acaba deja un modelo nuevo: se vuelve a pedir la lista aunque no llegue modelos.actualizados.
  const terminadas = Object.values(descargasModelos).filter((d) => d.estado === "terminada").length;
  const estado = useCarga("modelos", revisiones.modelos + terminadas, () => llamar("modelos.listar", {}));
  const [error, setError] = useState<string>();
  const [instalando, setInstalando] = useState(false);
  /** Descargas pedidas aquí que aún no han dado señales. */
  const [iniciadas, setIniciadas] = useState<Record<string, ProgresoDescargaModelo>>({});
  const [quitadas, setQuitadas] = useState<Set<string>>(new Set());

  const datos = estado.datos;
  const descargas = new Map<string, ProgresoDescargaModelo>();
  for (const d of [...Object.values(iniciadas), ...(datos?.descargas ?? []), ...Object.values(descargasModelos)]) descargas.set(d.id, d);
  const visibles = [...descargas.values()].filter((d) => (d.estado === "descargando" || d.estado === "error") && !quitadas.has(d.id));

  const instalar = async () => {
    setInstalando(true);
    setError(undefined);
    try {
      const { ruta } = await llamar("modelos.instalarMotor", {});
      estado.fijar((d) => ({ ...d, motor: { ...d.motor, ruta } }));
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setInstalando(false);
    }
  };
  const borrar = async (id: string) => {
    try {
      await llamar("modelos.borrar", { id });
      estado.fijar((d) => ({ ...d, locales: d.locales.filter((m) => m.id !== id) }));
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    }
  };
  const cancelar = async (id: string) => {
    try {
      await llamar("modelos.cancelar", { id });
      setQuitadas((q) => new Set(q).add(id));
    } catch (e) {
      setError(mensaje(e));
    }
  };
  const usar = async (id: string) => {
    try {
      await alUsar(id);
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    }
  };
  const descargar = async (repo: string, f: FicheroModeloHF, proyector?: string) => {
    const { id } = await llamar("modelos.descargar", { repo, fichero: f.nombre, ...(proyector ? { proyector } : {}) });
    setIniciadas((x) => ({ ...x, [id]: { id, repo, nombre: f.nombre, bytes: 0, total: f.bytes, estado: "descargando" } }));
  };

  if (estado.error && !datos) return <TextoAlerta texto={estado.error} />;
  if (!datos) return null;

  return (
    <div className="modelos">
      {!datos.motor.ruta && (
        <div className="modelos__motor">
          <Boton variante="acento" icono={instalando ? undefined : "descargar"} disabled={instalando} onClick={() => void instalar()}>
            {instalando && <LatticeLoader activo />}
            Instalar llama.cpp
          </Boton>
        </div>
      )}
      <Campo
        etiqueta="Carpeta"
        mono
        readOnly
        value={datos.carpeta}
        sufijo={
          puedeMostrarRutas() ? (
            <Boton variante="chip" tamano="pequeno" icono="carpeta" onClick={() => void abrirCarpeta(datos.carpeta)}>
              Mostrar carpeta
            </Boton>
          ) : undefined
        }
      />
      <TextoAlerta texto={error} />

      {datos.locales.length > 0 && (
        <div className="ajustes__grupo">
          <Etiqueta>Descargados</Etiqueta>
          <ul className="modelos__lista">
            {datos.locales.map((m) => (
              <ModeloLocal key={m.id} m={m} cargado={datos.motor.cargado === m.id} predeterminado={porDefecto === m.id} alUsar={usar} alBorrar={borrar} />
            ))}
          </ul>
        </div>
      )}

      {visibles.length > 0 && (
        <ul className="modelos__lista" aria-label="Descargas">
          {visibles.map((d) => (
            <Descarga key={d.id} d={d} alCancelar={() => void cancelar(d.id)} alQuitar={() => setQuitadas((q) => new Set(q).add(d.id))} />
          ))}
        </ul>
      )}

      <BuscarHF locales={datos.locales} descargas={visibles} alDescargar={descargar} />
      {children}
    </div>
  );
}

function TextoAlerta({ texto }: { texto?: string }) {
  if (!texto) return null;
  return (
    <p className="modelos__error" role="alert">
      {texto}
    </p>
  );
}

function ModeloLocal({
  m,
  cargado,
  predeterminado,
  alUsar,
  alBorrar,
}: {
  m: ModeloLocalInfo;
  cargado: boolean;
  predeterminado: boolean;
  alUsar: (id: string) => Promise<void>;
  alBorrar: (id: string) => Promise<void>;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const borrar = async () => {
    setBorrando(true);
    await alBorrar(m.id);
    setBorrando(false);
    setConfirmando(false);
  };
  return (
    <ConMenuContextual
      construir={() => [
        { texto: "Usar por defecto", icono: "check", deshabilitado: predeterminado, alElegir: () => void alUsar(m.id) },
        { texto: "Copiar id", icono: "copiar", alElegir: () => copiarTexto(m.id) },
        { tipo: "separador" },
        { texto: "Borrar", icono: "papelera", peligrosa: true, alElegir: () => void borrar() },
      ]}
    >
      {(menu) => (
        <li className={clases("modelo-local", cargado && "modelo-local--cargado")} {...menu}>
          <div className="modelo-local__datos">
            <span className="modelo-local__nombre" title={m.id}>
              {m.nombre}
            </span>
            <span className="modelo-local__repo">{m.repo}</span>
          </div>
          <span className="modelo-local__marcas">
            {m.imagenes && <Chip>Visión</Chip>}
            {predeterminado && <Chip>Por defecto</Chip>}
            {cargado && <Chip destacado>Cargado</Chip>}
          </span>
          <span className="modelo-local__tamano">{gigas(m.bytes)}</span>
          {confirmando ? (
            <ConfirmarBorrado ocupado={borrando} alBorrar={() => void borrar()} alCancelar={() => setConfirmando(false)} />
          ) : (
            <BotonIcono etiqueta={`Borrar ${m.nombre}`} icono="papelera" variante="pequeno" onClick={() => setConfirmando(true)} />
          )}
        </li>
      )}
    </ConMenuContextual>
  );
}

function Descarga({ d, alCancelar, alQuitar }: { d: ProgresoDescargaModelo; alCancelar: () => void; alQuitar: () => void }) {
  const fraccion = d.total ? d.bytes / d.total : 0;
  return (
    <li className="descarga-modelo">
      <div className="descarga-modelo__cabecera">
        <span className="modelo-local__datos">
          <span className="modelo-local__nombre" title={`${d.repo}/${d.nombre}`}>
            {d.nombre}
          </span>
          <span className="modelo-local__repo">{d.repo}</span>
        </span>
        <span className="descarga-modelo__cifras">
          {gigas(d.bytes)} / {gigas(d.total)}
        </span>
        {d.estado === "descargando" ? (
          <Boton variante="fantasma" tamano="pequeno" onClick={alCancelar}>
            Cancelar
          </Boton>
        ) : (
          <BotonIcono etiqueta="Quitar" icono="cerrar" variante="pequeno" onClick={alQuitar} />
        )}
      </div>
      {d.estado === "descargando" ? (
        <Medidor valor={fraccion} etiqueta={`Descarga de ${d.nombre}`} />
      ) : (
        <p className="modelos__error" role="alert">
          {d.error ?? "Error"}
        </p>
      )}
    </li>
  );
}

/* ── Buscar en Hugging Face ───────────────────────── */

function BuscarHF({
  locales,
  descargas,
  alDescargar,
}: {
  locales: ModeloLocalInfo[];
  descargas: ProgresoDescargaModelo[];
  alDescargar: (repo: string, f: FicheroModeloHF, proyector?: string) => Promise<void>;
}) {
  const { llamar } = useAcciones();
  const [consulta, setConsulta] = useState("");
  const [busqueda, setBusqueda] = useState<{ cargando: boolean; resultados?: ResultadoModeloHF[]; error?: string }>({ cargando: false });
  const [abierto, setAbierto] = useState<string>();

  const buscar = async () => {
    const q = consulta.trim();
    if (!q) return;
    setBusqueda((b) => ({ ...b, cargando: true, error: undefined }));
    setAbierto(undefined);
    try {
      setBusqueda({ cargando: false, resultados: (await llamar("modelos.buscar", { consulta: q })).resultados });
    } catch (e) {
      setBusqueda({ cargando: false, error: mensaje(e) });
    }
  };

  return (
    <div className="ajustes__grupo">
      <form
        className="modelos__buscar"
        onSubmit={(e) => {
          e.preventDefault();
          void buscar();
        }}
      >
        <CampoBusqueda etiqueta="Buscar en Hugging Face" placeholder="Buscar en Hugging Face" valor={consulta} alCambiar={setConsulta} />
        {busqueda.cargando && <LatticeLoader activo />}
      </form>
      <TextoAlerta texto={busqueda.error} />
      {busqueda.resultados && (busqueda.resultados.length === 0 ? (
        <p className="ajustes__estado">Sin resultados</p>
      ) : (
        <ul className="modelos__resultados">
          {busqueda.resultados.map((r) => (
            <ResultadoHF
              key={r.repo}
              r={r}
              abierto={abierto === r.repo}
              alAlternar={() => setAbierto((a) => (a === r.repo ? undefined : r.repo))}
              locales={locales}
              descargas={descargas}
              alDescargar={alDescargar}
            />
          ))}
        </ul>
      ))}
    </div>
  );
}

function ResultadoHF({
  r,
  abierto,
  alAlternar,
  locales,
  descargas,
  alDescargar,
}: {
  r: ResultadoModeloHF;
  abierto: boolean;
  alAlternar: () => void;
  locales: ModeloLocalInfo[];
  descargas: ProgresoDescargaModelo[];
  alDescargar: (repo: string, f: FicheroModeloHF, proyector?: string) => Promise<void>;
}) {
  const id = useId();
  return (
    <li className={clases("resultado-hf", abierto && "resultado-hf--abierto")}>
      <button type="button" className="resultado-hf__cabecera" aria-expanded={abierto} aria-controls={id} onClick={alAlternar}>
        <span className="resultado-hf__repo">{r.repo}</span>
        <span className="resultado-hf__cifras">
          <span>
            <Icono nombre="descargar" tamano={14} />
            {compacto.format(r.descargas)}
            <span className="nx-sr"> descargas</span>
          </span>
          <span>
            <Icono nombre="corazon" tamano={14} />
            {compacto.format(r.likes)}
            <span className="nx-sr"> me gusta</span>
          </span>
        </span>
        {r.protegido && <Chip>Protegido</Chip>}
        {r.imagenes && <Chip>Visión</Chip>}
        <Icono nombre="chevron-abajo" tamano={16} className={clases("herramienta__chevron", abierto && "herramienta__chevron--abierto")} />
      </button>
      {abierto && (
        <div id={id}>
          <DetalleRepo repo={r.repo} imagenes={!!r.imagenes} locales={locales} descargas={descargas} alDescargar={alDescargar} />
        </div>
      )}
    </li>
  );
}

function DetalleRepo({
  repo,
  imagenes,
  locales,
  descargas,
  alDescargar,
}: {
  repo: string;
  imagenes: boolean;
  locales: ModeloLocalInfo[];
  descargas: ProgresoDescargaModelo[];
  alDescargar: (repo: string, f: FicheroModeloHF, proyector?: string) => Promise<void>;
}) {
  const { llamar } = useAcciones();
  const datos = useCarga(repo, 0, () => llamar("modelos.repo", { repo }));
  const [vision, setVision] = useState(imagenes);
  const [proyector, setProyector] = useState<string>();
  const [pidiendo, setPidiendo] = useState<string>();
  const [error, setError] = useState<string>();
  const idVision = useId();

  if (datos.error) return <TextoAlerta texto={datos.error} />;
  if (!datos.datos)
    return (
      <div className="detalle-hf detalle-hf--cargando">
        <LatticeLoader activo />
      </div>
    );
  const d = datos.datos;
  const elegido = proyector ?? proyectorPreferido(d.proyectores);
  const descargar = async (f: FicheroModeloHF) => {
    setPidiendo(f.nombre);
    setError(undefined);
    try {
      await alDescargar(repo, f, vision && d.proyectores.length ? elegido : undefined);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setPidiendo(undefined);
    }
  };

  return (
    <div className="detalle-hf">
      {(d.ventana || d.proyectores.length > 0) && (
        <div className="detalle-hf__opciones">
          {d.ventana ? <span className="detalle-hf__ventana">Contexto {tokens(d.ventana)}</span> : null}
          {d.proyectores.length > 0 && (
            <label className="casilla" htmlFor={idVision}>
              <input id={idVision} type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
              Incluir visión
            </label>
          )}
          {vision && d.proyectores.length > 1 && (
            <Selector
              etiqueta="Proyector"
              className="detalle-hf__proyector"
              mono
              opciones={d.proyectores.map((p) => ({ valor: p.nombre, texto: `${p.cuantizacion ?? p.nombre} · ${gigas(p.bytes)}` }))}
              valor={elegido ?? ""}
              alCambiar={setProyector}
            />
          )}
        </div>
      )}
      <TextoAlerta texto={error} />
      {d.ficheros.length === 0 ? (
        <p className="ajustes__estado">Sin ficheros GGUF</p>
      ) : (
        <ul className="ficheros-hf">
          {d.ficheros.map((f) => {
            const descargado = locales.some((m) => m.id === `${repo}/${f.nombre}`);
            const enCurso = pidiendo === f.nombre || descargas.some((x) => x.repo === repo && x.nombre === f.nombre && x.estado === "descargando");
            return (
              <li key={f.nombre} className="fichero-hf" title={f.nombre}>
                <span className="fichero-hf__cuantizacion">{f.cuantizacion ?? f.nombre}</span>
                <span className="fichero-hf__tamano">{gigas(f.bytes)}</span>
                <span className="fichero-hf__partes">{f.partes.length > 1 ? `${f.partes.length} partes` : ""}</span>
                {descargado ? (
                  <Chip>Descargado</Chip>
                ) : (
                  <Boton variante="chip" tamano="pequeno" icono="descargar" disabled={enCurso} onClick={() => void descargar(f)}>
                    Descargar
                  </Boton>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
