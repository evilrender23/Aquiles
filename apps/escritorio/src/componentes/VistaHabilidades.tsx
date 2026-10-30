import type { InfoSkill, VersionSkill } from "@aquiles/protocolo";
import { Boton, CampoBusqueda, CampoInterruptor, Etiqueta, Icono, Titular, clases, copiarTexto, useMenuContextual } from "@aquiles/ui";
import { useEffect, useRef, useState } from "react";
import { cwdActiva, useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { fechaCompleta, fechaConHora, fechaCorta, fechaRelativa } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import { abrirCarpeta, puedeMostrarRutas } from "../plataforma/aplicacion";
import { Markdown } from "./Markdown";

type Origen = InfoSkill["origen"];
type Filtro = "todas" | Origen | "desactivadas" | "obsoletas" | "archivadas";

const ORIGEN: Record<Origen, { una: string; varias: string }> = {
  incluida: { una: "Incluida", varias: "Incluidas" },
  manual: { una: "Manual", varias: "Manuales" },
  aprendida: { una: "Aprendida", varias: "Aprendidas" },
};
const UBICACION: Record<InfoSkill["ubicacion"], string | undefined> = { perfil: "Perfil", proyecto: "Proyecto", incluida: undefined };
const VIGENCIA: Record<InfoSkill["vigencia"], string | undefined> = { vigente: undefined, obsoleta: "Obsoleta", archivada: "Archivada" };
const MOTIVOS: Record<string, string> = { parchear: "Parche", escribir: "Escritura", propuesta: "Propuesta", restaurar: "Restauración", crear: "Creación" };

/** Sin mayúsculas ni tildes, para buscar. */
const normalizar = (t: string) =>
  t
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const usos = (n: number) => (n === 1 ? "1 uso" : `${n} usos`);
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** La ruta cambia al archivar; el nombre y la ubicación, no. */
const clave = (s: InfoSkill) => `${s.ubicacion}:${s.nombre}`;

/** El SKILL.md sin la cabecera YAML (nombre y descripción ya se ven arriba). */
const sinCabecera = (md: string) => md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");

function pasaFiltro(s: InfoSkill, f: Filtro): boolean {
  // Las archivadas no se cargan en las sesiones: solo aparecen con su chip.
  if (f === "archivadas") return s.vigencia === "archivada";
  if (s.vigencia === "archivada") return false;
  if (f === "todas") return true;
  if (f === "desactivadas") return !s.activa;
  if (f === "obsoletas") return s.vigencia === "obsoleta";
  return s.origen === f;
}

export function VistaHabilidades() {
  const estado = useEstado();
  const { listarSkills } = useAcciones();
  const cwd = cwdActiva(estado);
  const lista = useCarga(`skills:${cwd ?? ""}`, estado.revisiones.skills, () => listarSkills(cwd));
  const [texto, setTexto] = useState("");
  const [filtro, setFiltro] = useState<Filtro>("todas");
  const [elegida, setElegida] = useState<string>();
  const detalle = useRef<HTMLElement>(null);
  const ahora = useReloj(60_000);

  const skills = lista.datos ?? [];
  const buscado = normalizar(texto.trim());
  const visibles = skills.filter((s) => pasaFiltro(s, filtro) && (!buscado || normalizar(`${s.nombre} ${s.descripcion}`).includes(buscado)));
  const seleccion = skills.find((s) => clave(s) === elegida) ?? visibles[0];

  const cuenta = (f: Filtro) => skills.filter((s) => pasaFiltro(s, f)).length;
  const todos: { id: Filtro; texto: string }[] = [
    { id: "todas", texto: "Todas" },
    ...(["incluida", "manual", "aprendida"] as const).map((o) => ({ id: o, texto: ORIGEN[o].varias })),
    { id: "desactivadas", texto: "Desactivadas" },
    { id: "obsoletas", texto: "Obsoletas" },
    { id: "archivadas", texto: "Archivadas" },
  ];
  // Sin chips que no filtrarían nada (salvo el elegido, para poder volver).
  const filtros = todos.map((f) => ({ ...f, n: cuenta(f.id) })).filter((f) => f.id === "todas" || f.n > 0 || f.id === filtro);

  /** «Versiones» desde el menú de una tarjeta: el detalle abre su sección. */
  const [pedirVersiones, setPedirVersiones] = useState(0);

  const elegir = (s: InfoSkill) => {
    setElegida(clave(s));
    // En una sola columna el detalle queda debajo de la lista.
    if (window.matchMedia("(max-width: 1239px)").matches) detalle.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="habilidades">
      <section className="habilidades__lista" aria-labelledby="titulo-habilidades">
        <Titular id="titulo-habilidades" texto="Habilidades" tamano="l" />

        <div className="habilidades__filtros">
          <CampoBusqueda className="habilidades__buscar" etiqueta="Buscar habilidades" placeholder="Buscar por nombre o descripción" valor={texto} alCambiar={setTexto} />
          {lista.datos && (
            <fieldset className="habilidades__chips">
              <legend className="nx-sr">Filtrar</legend>
              {filtros.map((f) => (
                <button key={f.id} type="button" className="nx-chip habilidades__chip" aria-pressed={f.id === filtro} onClick={() => setFiltro(f.id)}>
                  {f.texto} · {f.n}
                </button>
              ))}
            </fieldset>
          )}
        </div>

        {lista.error && (
          <p className="habilidades__error" role="alert">
            {lista.error}
          </p>
        )}

        {lista.datos && skills.length > 0 && visibles.length === 0 && <p className="habilidades__vacio">Sin resultados</p>}

        {visibles.length > 0 && (
          <div className="habilidades__rejilla">
            {visibles.map((s) => (
              <TarjetaHabilidad
                key={clave(s)}
                skill={s}
                cwd={cwd}
                numero={skills.indexOf(s) + 1}
                actual={clave(s) === (seleccion && clave(seleccion))}
                ahora={ahora}
                alElegir={() => elegir(s)}
                alVersiones={() => {
                  elegir(s);
                  setPedirVersiones((n) => n + 1);
                }}
                alCambiar={(nueva) => lista.fijar((l) => l.map((x) => (clave(x) === clave(nueva) ? nueva : x)))}
              />
            ))}
          </div>
        )}
      </section>

      {seleccion && (
        <aside ref={detalle} className="habilidades__detalle" aria-label="Detalle de la habilidad">
          <DetalleHabilidad
            key={clave(seleccion)}
            skill={seleccion}
            cwd={cwd}
            alCambiar={(nueva) => lista.fijar((l) => l.map((x) => (clave(x) === clave(nueva) ? nueva : x)))}
            abrirVersiones={pedirVersiones}
          />
        </aside>
      )}
    </div>
  );
}

function TarjetaHabilidad({
  skill: s,
  cwd,
  numero,
  actual,
  ahora,
  alElegir,
  alVersiones,
  alCambiar,
}: {
  skill: InfoSkill;
  cwd?: string;
  numero: number;
  actual: boolean;
  ahora: number;
  alElegir: () => void;
  alVersiones: () => void;
  alCambiar: (s: InfoSkill) => void;
}) {
  const { ajustarSkill, fijarSkill, archivarSkill, restaurarSkill } = useAcciones();
  const delPerfil = s.ubicacion === "perfil";
  const archivada = s.vigencia === "archivada";
  const cambiar = (f: () => Promise<InfoSkill>) => void f().then(alCambiar, () => {});
  // Lo que se puede hacer depende de la ubicación y de la vigencia de la skill al abrir el menú.
  const menu = useMenuContextual(() => [
    { texto: "Ver", icono: "flecha-diagonal", alElegir },
    { tipo: "separador" },
    !archivada && { texto: s.activa ? "Desactivar" : "Activar", alElegir: () => cambiar(() => ajustarSkill(s.nombre, !s.activa, cwd)) },
    delPerfil && !archivada && { texto: s.fijada ? "Quitar fijación" : "Fijar", alElegir: () => cambiar(() => fijarSkill(s.nombre, !s.fijada)) },
    delPerfil && (archivada ? { texto: "Restaurar", icono: "recargar", alElegir: () => cambiar(() => restaurarSkill(s.nombre)) } : { texto: "Archivar", alElegir: () => cambiar(() => archivarSkill(s.nombre)) }),
    delPerfil && { texto: "Versiones", alElegir: alVersiones },
    { tipo: "separador" },
    { texto: "Copiar ruta", icono: "copiar", alElegir: () => copiarTexto(s.ruta) },
    puedeMostrarRutas() && { texto: "Mostrar carpeta", icono: "carpeta", alElegir: () => abrirCarpeta(s.ruta) },
  ]);
  const meta = [s.activa ? undefined : "Desactivada", ORIGEN[s.origen].una, usos(s.usos), s.ultimoUso && fechaRelativa(s.ultimoUso, ahora)].filter(Boolean).join(" · ");
  const vigencia = VIGENCIA[s.vigencia];
  return (
    <button
      type="button"
      className={clases("habilidad", (!s.activa || s.vigencia === "archivada") && "habilidad--inactiva", s.vigencia === "archivada" && "habilidad--archivada")}
      aria-pressed={actual}
      onClick={alElegir}
      {...menu}
    >
      <span className="habilidad__arriba">
        <span className="habilidad__numero">{String(numero).padStart(2, "0")}</span>
        <span className="habilidad__marcas">
          {vigencia && <span className="habilidad__marca">{vigencia}</span>}
          {s.fijada && <span className="habilidad__marca habilidad__marca--fijada">Fijada</span>}
        </span>
        <Icono nombre="flecha-diagonal" tamano={18} />
      </span>
      <span className="habilidad__cuerpo">
        <span className="habilidad__nombre">{s.nombre}</span>
        {s.descripcion && <span className="habilidad__descripcion">{s.descripcion}</span>}
      </span>
      <span className="nx-etiqueta" title={s.ultimoUso ? fechaCompleta(s.ultimoUso) : undefined}>
        {meta}
      </span>
    </button>
  );
}

function DetalleHabilidad({ skill: s, cwd, alCambiar, abrirVersiones }: { skill: InfoSkill; cwd?: string; alCambiar: (s: InfoSkill) => void; abrirVersiones: number }) {
  const { revisiones } = useEstado();
  const { leerSkill, ajustarSkill, fijarSkill, archivarSkill, restaurarSkill } = useAcciones();
  const doc = useCarga(`skill:${s.ruta}`, revisiones.skills, () => leerSkill(s.nombre, cwd));
  const [cambiando, setCambiando] = useState(false);
  const [error, setError] = useState<string>();
  const [verVersiones, setVerVersiones] = useState(false);
  useEffect(() => {
    if (abrirVersiones) setVerVersiones(true);
  }, [abrirVersiones]);
  const ubicacion = UBICACION[s.ubicacion];
  // El curador (fijar, archivar) y las copias solo existen para las del perfil.
  const delPerfil = s.ubicacion === "perfil";
  const archivada = s.vigencia === "archivada";

  const cambiar = async (f: () => Promise<InfoSkill>) => {
    setCambiando(true);
    try {
      alCambiar(await f());
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setCambiando(false);
    }
  };

  return (
    <div className="habilidad-detalle">
      <Etiqueta>{[ORIGEN[s.origen].una, ubicacion, VIGENCIA[s.vigencia]].filter(Boolean).join(" · ")}</Etiqueta>
      <h2 className="habilidad-detalle__nombre">{s.nombre}</h2>
      {s.descripcion && <p className="habilidad-detalle__descripcion">{s.descripcion}</p>}

      {!archivada && (
        <div className="habilidad-detalle__ajustes">
          <CampoInterruptor etiqueta="Activa" activo={s.activa} disabled={cambiando} alCambiar={(a) => void cambiar(() => ajustarSkill(s.nombre, a, cwd))} />
          {delPerfil && <CampoInterruptor etiqueta="Fijada" activo={s.fijada} disabled={cambiando} alCambiar={(f) => void cambiar(() => fijarSkill(s.nombre, f))} />}
        </div>
      )}
      {error && (
        <p className="habilidad-detalle__error" role="alert">
          {error}
        </p>
      )}

      <div className="habilidad-detalle__cifras">
        <div className="cifra">
          <span className="cifra__valor cifra__valor--lima">{s.usos}</span>
          <Etiqueta>Usos</Etiqueta>
        </div>
        <div className="cifra" title={fechaCompleta(s.actualizada)}>
          <span className="cifra__valor">{fechaCorta(s.actualizada)}</span>
          <Etiqueta>Actualizada</Etiqueta>
        </div>
      </div>

      <div className="habilidad-detalle__documento">
        <span className="habilidad-detalle__ruta" title={s.ruta}>
          {s.ruta}
        </span>
        {doc.error && (
          <p className="habilidad-detalle__error" role="alert">
            {doc.error}
          </p>
        )}
        {doc.datos && (
          <div className="habilidad-detalle__md">
            <Markdown texto={sinCabecera(doc.datos.contenido)} compacto />
          </div>
        )}
      </div>

      {doc.datos && doc.datos.ficheros.length > 0 && (
        <div className="habilidad-detalle__ficheros">
          <Etiqueta>Ficheros</Etiqueta>
          <ul>
            {doc.datos.ficheros.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      {delPerfil && (
        <>
          <div className="habilidad-detalle__botones">
            <Boton variante="secundario" iconoFinal="chevron-abajo" aria-expanded={verVersiones} className={clases(verVersiones && "boton--abierto")} onClick={() => setVerVersiones((v) => !v)}>
              Versiones
            </Boton>
            {archivada ? (
              <Boton variante="secundario" disabled={cambiando} onClick={() => void cambiar(() => restaurarSkill(s.nombre))}>
                Restaurar
              </Boton>
            ) : (
              <Boton variante="secundario" disabled={cambiando} onClick={() => void cambiar(() => archivarSkill(s.nombre))}>
                Archivar
              </Boton>
            )}
          </div>
          {verVersiones && <Versiones nombre={s.nombre} alRestaurar={alCambiar} />}
        </>
      )}
    </div>
  );
}

/** Copias guardadas antes de cada cambio; restaurar una pide confirmación. */
function Versiones({ nombre, alRestaurar }: { nombre: string; alRestaurar: (s: InfoSkill) => void }) {
  const { revisiones } = useEstado();
  const { versionesSkill, restaurarVersionSkill } = useAcciones();
  const versiones = useCarga(`versiones:${nombre}`, revisiones.skills, () => versionesSkill(nombre));
  const [confirmando, setConfirmando] = useState<string>();
  const [restaurando, setRestaurando] = useState(false);
  const [error, setError] = useState<string>();
  const ahora = useReloj(60_000);

  const restaurar = async (v: VersionSkill) => {
    setRestaurando(true);
    try {
      alRestaurar(await restaurarVersionSkill(nombre, v.id));
      setConfirmando(undefined);
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setRestaurando(false);
    }
  };

  return (
    <section className="versiones" aria-label="Versiones">
      {versiones.error && (
        <p className="habilidad-detalle__error" role="alert">
          {versiones.error}
        </p>
      )}
      {versiones.datos?.length === 0 && <p className="habilidades__vacio">Sin versiones</p>}
      {versiones.datos && versiones.datos.length > 0 && (
        <ol className="versiones__lista">
          {versiones.datos.map((v) => (
            <li key={v.id} className="version">
              <div className="version__datos" title={v.ficheros.join("\n")}>
                <time className="version__fecha" dateTime={v.fecha} title={fechaCompleta(v.fecha)}>
                  {fechaConHora(v.fecha, ahora)}
                </time>
                <span className="version__motivo">{MOTIVOS[v.motivo] ?? v.motivo}</span>
              </div>
              {confirmando === v.id ? (
                <ConfirmarRestaurar restaurando={restaurando} alRestaurar={() => void restaurar(v)} alCancelar={() => setConfirmando(undefined)} />
              ) : (
                <Boton
                  variante="fantasma"
                  tamano="pequeno"
                  onClick={() => {
                    setError(undefined);
                    setConfirmando(v.id);
                  }}
                >
                  Restaurar
                </Boton>
              )}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p className="habilidad-detalle__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ConfirmarRestaurar({ restaurando, alRestaurar, alCancelar }: { restaurando: boolean; alRestaurar: () => void; alCancelar: () => void }) {
  const cancelar = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelar.current?.focus(), []);
  return (
    <span className="version__confirmar">
      <Boton variante="acento" tamano="pequeno" disabled={restaurando} onClick={alRestaurar}>
        Restaurar
      </Boton>
      <Boton variante="fantasma" tamano="pequeno" ref={cancelar} onClick={alCancelar} onKeyDown={(e) => e.key === "Escape" && alCancelar()}>
        Cancelar
      </Boton>
    </span>
  );
}
