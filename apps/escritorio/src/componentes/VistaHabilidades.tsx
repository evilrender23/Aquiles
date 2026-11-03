import type { InfoSkill, VersionSkill } from "@aquiles/protocolo";
import { Boton, CampoBusqueda, CampoInterruptor, Etiqueta, Icono, Titular, clases, copiarTexto, t, useMenuContextual } from "@aquiles/ui";
import { useEffect, useRef, useState } from "react";
import { cwdActiva, useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { fechaCompleta, fechaConHora, fechaCorta, fechaRelativa } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import { abrirCarpeta, puedeMostrarRutas } from "../plataforma/aplicacion";
import { Markdown } from "./Markdown";

type Origen = InfoSkill["origen"];
type Filtro = "todas" | Origen | "desactivadas" | "obsoletas" | "archivadas";

// Funciones y no constantes: los textos se traducen al pintar, en el idioma de ese momento.
const origenes = (): Record<Origen, { una: string; varias: string }> => ({
  incluida: { una: t("Incluida"), varias: t("Incluidas") },
  manual: { una: t("Manual"), varias: t("Manuales") },
  aprendida: { una: t("Aprendida"), varias: t("Aprendidas") },
});
const ubicaciones = (): Record<InfoSkill["ubicacion"], string | undefined> => ({ perfil: t("Perfil"), proyecto: t("Proyecto"), incluida: undefined });
const vigencias = (): Record<InfoSkill["vigencia"], string | undefined> => ({ vigente: undefined, obsoleta: t("Obsoleta"), archivada: t("Archivada") });
const motivos = (): Record<string, string> => ({ parchear: t("Parche"), escribir: t("Escritura"), propuesta: t("Propuesta"), restaurar: t("Restauración"), crear: t("Creación") });

/** Sin mayúsculas ni tildes, para buscar. */
const normalizar = (texto: string) =>
  texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const usos = (n: number) => (n === 1 ? t("1 uso") : t("{n} usos", { n }));
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
    { id: "todas", texto: t("Todas") },
    ...(["incluida", "manual", "aprendida"] as const).map((o) => ({ id: o, texto: origenes()[o].varias })),
    { id: "desactivadas", texto: t("Desactivadas") },
    { id: "obsoletas", texto: t("Obsoletas") },
    { id: "archivadas", texto: t("Archivadas") },
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
        <Titular id="titulo-habilidades" texto={t("Habilidades")} tamano="l" />

        <div className="habilidades__filtros">
          <CampoBusqueda className="habilidades__buscar" etiqueta={t("Buscar habilidades")} placeholder={t("Buscar por nombre o descripción")} valor={texto} alCambiar={setTexto} />
          {lista.datos && (
            <fieldset className="habilidades__chips">
              <legend className="nx-sr">{t("Filtrar")}</legend>
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

        {lista.datos && skills.length > 0 && visibles.length === 0 && <p className="habilidades__vacio">{t("Sin resultados")}</p>}

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
        <aside ref={detalle} className="habilidades__detalle" aria-label={t("Detalle de la habilidad")}>
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
    { texto: t("Ver"), icono: "flecha-diagonal", alElegir },
    { tipo: "separador" },
    !archivada && { texto: s.activa ? t("Desactivar") : t("Activar"), alElegir: () => cambiar(() => ajustarSkill(s.nombre, !s.activa, cwd)) },
    delPerfil && !archivada && { texto: s.fijada ? t("Quitar fijación") : t("Fijar"), alElegir: () => cambiar(() => fijarSkill(s.nombre, !s.fijada)) },
    delPerfil &&
      (archivada
        ? { texto: t("Restaurar"), icono: "recargar", alElegir: () => cambiar(() => restaurarSkill(s.nombre)) }
        : { texto: t("Archivar"), alElegir: () => cambiar(() => archivarSkill(s.nombre)) }),
    delPerfil && { texto: t("Versiones"), alElegir: alVersiones },
    { tipo: "separador" },
    { texto: t("Copiar ruta"), icono: "copiar", alElegir: () => copiarTexto(s.ruta) },
    puedeMostrarRutas() && { texto: t("Mostrar carpeta"), icono: "carpeta", alElegir: () => abrirCarpeta(s.ruta) },
  ]);
  const meta = [s.activa ? undefined : t("Desactivada"), origenes()[s.origen].una, usos(s.usos), s.ultimoUso && fechaRelativa(s.ultimoUso, ahora)].filter(Boolean).join(" · ");
  const vigencia = vigencias()[s.vigencia];
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
          {s.fijada && <span className="habilidad__marca habilidad__marca--fijada">{t("Fijada")}</span>}
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
  const ubicacion = ubicaciones()[s.ubicacion];
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
      <Etiqueta>{[origenes()[s.origen].una, ubicacion, vigencias()[s.vigencia]].filter(Boolean).join(" · ")}</Etiqueta>
      <h2 className="habilidad-detalle__nombre">{s.nombre}</h2>
      {s.descripcion && <p className="habilidad-detalle__descripcion">{s.descripcion}</p>}

      {!archivada && (
        <div className="habilidad-detalle__ajustes">
          <CampoInterruptor etiqueta={t("Activa")} activo={s.activa} disabled={cambiando} alCambiar={(a) => void cambiar(() => ajustarSkill(s.nombre, a, cwd))} />
          {delPerfil && <CampoInterruptor etiqueta={t("Fijada")}activo={s.fijada} disabled={cambiando} alCambiar={(f) => void cambiar(() => fijarSkill(s.nombre, f))} />}
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
          <Etiqueta>{t("Usos")}</Etiqueta>
        </div>
        <div className="cifra" title={fechaCompleta(s.actualizada)}>
          <span className="cifra__valor">{fechaCorta(s.actualizada)}</span>
          <Etiqueta>{t("Actualizada")}</Etiqueta>
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
          <Etiqueta>{t("Ficheros")}</Etiqueta>
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
              {t("Versiones")}
            </Boton>
            {archivada ? (
              <Boton variante="secundario" disabled={cambiando} onClick={() => void cambiar(() => restaurarSkill(s.nombre))}>
                {t("Restaurar")}
              </Boton>
            ) : (
              <Boton variante="secundario" disabled={cambiando} onClick={() => void cambiar(() => archivarSkill(s.nombre))}>
                {t("Archivar")}
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
    <section className="versiones" aria-label={t("Versiones")}>
      {versiones.error && (
        <p className="habilidad-detalle__error" role="alert">
          {versiones.error}
        </p>
      )}
      {versiones.datos?.length === 0 && <p className="habilidades__vacio">{t("Sin versiones")}</p>}
      {versiones.datos && versiones.datos.length > 0 && (
        <ol className="versiones__lista">
          {versiones.datos.map((v) => (
            <li key={v.id} className="version">
              <div className="version__datos" title={v.ficheros.join("\n")}>
                <time className="version__fecha" dateTime={v.fecha} title={fechaCompleta(v.fecha)}>
                  {fechaConHora(v.fecha, ahora)}
                </time>
                <span className="version__motivo">{motivos()[v.motivo] ?? v.motivo}</span>
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
                  {t("Restaurar")}
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
        {t("Restaurar")}
      </Boton>
      <Boton variante="fantasma" tamano="pequeno" ref={cancelar} onClick={alCancelar} onKeyDown={(e) => e.key === "Escape" && alCancelar()}>
        {t("Cancelar")}
      </Boton>
    </span>
  );
}
