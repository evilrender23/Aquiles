/** Objetivo de la sesión: tras cada turno un juez decide si se cumplió; si no, Aquiles sigue solo hasta agotar los intentos. */
import type { InfoSesion, ObjetivoSesion } from "@aquiles/protocolo";
import { Boton, Etiqueta, clases, t } from "@aquiles/ui";
import { useEffect, useRef, useState } from "react";
import { useAcciones } from "../estado/almacen";

function nombreEstado(estado: ObjetivoSesion["estado"]): string {
  if (estado === "activo") return t("Activo");
  if (estado === "cumplido") return t("Cumplido");
  return t("Agotado");
}
const INTENTOS_POR_DEFECTO = 5;

/** El objetivo puesto (con su estado y el último veredicto del juez) o el editor para ponerlo. */
export function PanelObjetivo({ sesion, editando, alEditar }: { sesion: InfoSesion; editando: boolean; alEditar: (e: boolean) => void }) {
  const { ponerObjetivo } = useAcciones();
  const [error, setError] = useState<string>();
  const o = sesion.objetivo;

  const quitar = async () => {
    try {
      await ponerObjetivo(sesion.sesionId, null);
      setError(undefined);
      alEditar(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (editando) return <EditorObjetivo sesion={sesion} alCerrar={() => alEditar(false)} alQuitar={o ? () => void quitar() : undefined} />;
  if (!o) return null;
  return (
    <section className={clases("objetivo", `objetivo--${o.estado}`)} aria-label={t("Objetivo")}>
      <div className="objetivo__cabecera">
        <Etiqueta>{t("Objetivo")}</Etiqueta>
        <span className="objetivo__estado">
          {o.estado === "activo" && <i className="nx-punto nx-pulso" aria-hidden="true" />}
          {nombreEstado(o.estado)}
        </span>
        <span className="objetivo__intentos" title={t("Intentos")}>
          {o.intentos} / {o.maxIntentos}
        </span>
        <span className="objetivo__hueco" />
        <Boton variante="fantasma" tamano="pequeno" onClick={() => alEditar(true)}>
          {t("Editar")}
        </Boton>
        <Boton variante="fantasma" tamano="pequeno" onClick={() => void quitar()}>
          {t("Quitar")}
        </Boton>
      </div>
      <p className="objetivo__texto">{o.texto}</p>
      {o.motivo && <p className="objetivo__motivo">{o.motivo}</p>}
      {error && (
        <p className="objetivo__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function EditorObjetivo({ sesion, alCerrar, alQuitar }: { sesion: InfoSesion; alCerrar: () => void; alQuitar?: () => void }) {
  const { ponerObjetivo } = useAcciones();
  const [texto, setTexto] = useState(sesion.objetivo?.texto ?? "");
  const [intentos, setIntentos] = useState(String(sesion.objetivo?.maxIntentos ?? INTENTOS_POR_DEFECTO));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string>();
  const caja = useRef<HTMLTextAreaElement>(null);
  const n = Number(intentos);
  const intentosValidos = Number.isInteger(n) && n >= 1 && n <= 20;
  const listo = !!texto.trim() && intentosValidos && !guardando;

  useEffect(() => caja.current?.focus(), []);

  const guardar = async () => {
    setGuardando(true);
    try {
      await ponerObjetivo(sesion.sesionId, texto.trim(), n);
      alCerrar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGuardando(false);
    }
  };

  return (
    <form
      className="objetivo objetivo--editor"
      aria-label={t("Objetivo")}
      onSubmit={(e) => {
        e.preventDefault();
        if (listo) void guardar();
      }}
    >
      <div className="objetivo__editor">
        <textarea
          ref={caja}
          className="objetivo__entrada"
          aria-label={t("Objetivo")}
          rows={2}
          maxLength={2000}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && alCerrar()}
        />
        <label className="objetivo__campo-intentos">
          <span className="nx-etiqueta">{t("Intentos")}</span>
          <input
            className="objetivo__numero"
            type="number"
            inputMode="numeric"
            min={1}
            max={20}
            value={intentos}
            aria-invalid={intentosValidos ? undefined : true}
            onChange={(e) => setIntentos(e.target.value)}
          />
        </label>
      </div>
      {error && (
        <p className="objetivo__error" role="alert">
          {error}
        </p>
      )}
      <div className="objetivo__botones">
        <Boton type="submit" variante="acento" tamano="pequeno" disabled={!listo}>
          {t("Guardar")}
        </Boton>
        <Boton variante="fantasma" tamano="pequeno" onClick={alCerrar}>
          {t("Cancelar")}
        </Boton>
        {alQuitar && (
          <Boton variante="fantasma" tamano="pequeno" onClick={alQuitar}>
            {t("Quitar")}
          </Boton>
        )}
      </div>
    </form>
  );
}
