import type { InfoSkill } from "@aquiles/protocolo";
import { CampoBusqueda, Etiqueta, Icono, Interruptor, Titular, clases } from "@aquiles/ui";
import { useRef, useState } from "react";
import { cwdActiva, useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { fechaCompleta, fechaCorta, fechaRelativa } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import { Markdown } from "./Markdown";

type Origen = InfoSkill["origen"];
type Filtro = "todas" | Origen | "desactivadas";

const ORIGEN: Record<Origen, { una: string; varias: string }> = {
  incluida: { una: "Incluida", varias: "Incluidas" },
  manual: { una: "Manual", varias: "Manuales" },
  aprendida: { una: "Aprendida", varias: "Aprendidas" },
};
const UBICACION: Record<InfoSkill["ubicacion"], string | undefined> = { perfil: "Perfil", proyecto: "Proyecto", incluida: undefined };

/** Sin mayúsculas ni tildes, para buscar. */
const normalizar = (t: string) =>
  t
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const usos = (n: number) => (n === 1 ? "1 uso" : `${n} usos`);

/** El SKILL.md sin la cabecera YAML (nombre y descripción ya se ven arriba). */
const sinCabecera = (md: string) => md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");

function pasaFiltro(s: InfoSkill, f: Filtro): boolean {
  if (f === "todas") return true;
  if (f === "desactivadas") return !s.activa;
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
  const seleccion = skills.find((s) => s.ruta === elegida) ?? visibles[0];

  const todos: { id: Filtro; texto: string; n: number }[] = [
    { id: "todas", texto: "Todas", n: skills.length },
    ...(["incluida", "manual", "aprendida"] as const).map((o) => ({ id: o, texto: ORIGEN[o].varias, n: skills.filter((s) => s.origen === o).length })),
    { id: "desactivadas", texto: "Desactivadas", n: skills.filter((s) => !s.activa).length },
  ];
  // Sin chips que no filtrarían nada (salvo el elegido, para poder volver).
  const filtros = todos.filter((f) => f.id === "todas" || f.n > 0 || f.id === filtro);

  const elegir = (s: InfoSkill) => {
    setElegida(s.ruta);
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
              <TarjetaHabilidad key={s.ruta} skill={s} numero={skills.indexOf(s) + 1} actual={s.ruta === seleccion?.ruta} ahora={ahora} alElegir={() => elegir(s)} />
            ))}
          </div>
        )}
      </section>

      {seleccion && (
        <aside ref={detalle} className="habilidades__detalle" aria-label="Detalle de la habilidad">
          <DetalleHabilidad
            key={seleccion.ruta}
            skill={seleccion}
            cwd={cwd}
            alCambiar={(nueva) => lista.fijar((l) => l.map((x) => (x.ruta === nueva.ruta ? nueva : x)))}
          />
        </aside>
      )}
    </div>
  );
}

function TarjetaHabilidad({ skill: s, numero, actual, ahora, alElegir }: { skill: InfoSkill; numero: number; actual: boolean; ahora: number; alElegir: () => void }) {
  const meta = [s.activa ? undefined : "Desactivada", ORIGEN[s.origen].una, usos(s.usos), s.ultimoUso && fechaRelativa(s.ultimoUso, ahora)].filter(Boolean).join(" · ");
  return (
    <button type="button" className={clases("habilidad", !s.activa && "habilidad--inactiva")} aria-pressed={actual} onClick={alElegir}>
      <span className="habilidad__arriba">
        <span className="habilidad__numero">{String(numero).padStart(2, "0")}</span>
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

function DetalleHabilidad({ skill: s, cwd, alCambiar }: { skill: InfoSkill; cwd?: string; alCambiar: (s: InfoSkill) => void }) {
  const { revisiones } = useEstado();
  const { leerSkill, ajustarSkill } = useAcciones();
  const doc = useCarga(`skill:${s.ruta}`, revisiones.skills, () => leerSkill(s.nombre, cwd));
  const [cambiando, setCambiando] = useState(false);
  const [error, setError] = useState<string>();
  const ubicacion = UBICACION[s.ubicacion];

  const alternar = async (activa: boolean) => {
    setCambiando(true);
    try {
      alCambiar(await ajustarSkill(s.nombre, activa));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCambiando(false);
    }
  };

  return (
    <div className="habilidad-detalle">
      <div className="habilidad-detalle__cabecera">
        <Etiqueta>{ubicacion ? `${ORIGEN[s.origen].una} · ${ubicacion}` : ORIGEN[s.origen].una}</Etiqueta>
        <Interruptor activo={s.activa} alCambiar={(a) => void alternar(a)} disabled={cambiando} aria-label="Activa" />
      </div>
      {error && (
        <p className="habilidad-detalle__error" role="alert">
          {error}
        </p>
      )}
      <h2 className="habilidad-detalle__nombre">{s.nombre}</h2>
      {s.descripcion && <p className="habilidad-detalle__descripcion">{s.descripcion}</p>}

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
    </div>
  );
}
