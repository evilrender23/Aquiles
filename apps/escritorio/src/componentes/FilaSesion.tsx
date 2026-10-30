import type { InfoSesion } from "@aquiles/protocolo";
import { Boton, BotonIcono, clases } from "@aquiles/ui";
import { useEffect, useRef, useState } from "react";
import { useAcciones } from "../estado/almacen";
import { fechaRelativa } from "../estado/formato";

type Modo = "ver" | "renombrar" | "borrar";

export function FilaSesion({
  sesion,
  actual,
  pendiente,
  ahora,
  alAbrir,
}: {
  sesion: InfoSesion;
  actual: boolean;
  pendiente?: "aprobacion" | "pregunta";
  ahora: number;
  alAbrir: () => void;
}) {
  const { renombrar, borrar } = useAcciones();
  const [modo, setModo] = useState<Modo>("ver");
  const [error, setError] = useState<string>();
  const resuelto = useRef(false);
  const entrada = useRef<HTMLInputElement>(null);
  const cancelar = useRef<HTMLButtonElement>(null);

  // Foco al entrar en cada modo: el título seleccionado al renombrar, «Cancelar» al confirmar el borrado.
  useEffect(() => {
    if (modo === "renombrar") {
      entrada.current?.focus();
      entrada.current?.select();
    }
    if (modo === "borrar") cancelar.current?.focus();
  }, [modo]);
  const titulo = sesion.titulo || "Sin título";

  const intentar = async (f: () => Promise<void>) => {
    try {
      await f();
      setModo("ver");
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (modo === "renombrar") {
    const guardar = (valor: string) => {
      // Enter y luego el blur al desmontar: solo cuenta el primero.
      if (resuelto.current) return;
      resuelto.current = true;
      const t = valor.trim();
      if (!t || t === sesion.titulo) return setModo("ver");
      void intentar(() => renombrar(sesion.sesionId, t.slice(0, 120)));
    };
    return (
      <input
        className="fila-sesion__entrada"
        aria-label="Título de la sesión"
        defaultValue={sesion.titulo ?? ""}
        ref={entrada}
        maxLength={120}
        onBlur={(e) => guardar(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") guardar(e.currentTarget.value);
          if (e.key === "Escape") {
            resuelto.current = true;
            setModo("ver");
          }
        }}
      />
    );
  }

  if (modo === "borrar") {
    return (
      <div className="fila-sesion fila-sesion--confirmar" title={error}>
        <Boton variante="acento" tamano="pequeno" className="fila-sesion__boton" onClick={() => void intentar(() => borrar(sesion.sesionId))}>
          Borrar
        </Boton>
        <Boton variante="fantasma" tamano="pequeno" ref={cancelar} className="fila-sesion__boton" onClick={() => setModo("ver")} onKeyDown={(e) => e.key === "Escape" && setModo("ver")}>
          Cancelar
        </Boton>
      </div>
    );
  }

  return (
    <div className={clases("fila-sesion", actual && "fila-sesion--actual")} title={error}>
      <button type="button" className="fila-sesion__abrir" title={titulo} onClick={alAbrir}>
        {titulo}
      </button>
      <span className="fila-sesion__estado">
        {pendiente ? (
          <span className="fila-sesion__pendiente">{pendiente === "aprobacion" ? "permiso" : "pregunta"}</span>
        ) : sesion.trabajando ? (
          <i className="nx-punto nx-pulso" role="img" aria-label="Trabajando" />
        ) : (
          <span className="fila-sesion__fecha">{fechaRelativa(sesion.actualizada, ahora)}</span>
        )}
      </span>
      <span className="fila-sesion__acciones">
        <BotonIcono
          variante="pequeno"
          etiqueta="Renombrar"
          icono="lapiz"
          tamanoIcono={14}
          onClick={() => {
            resuelto.current = false;
            setModo("renombrar");
          }}
        />
        <BotonIcono variante="pequeno" etiqueta="Borrar" icono="papelera" tamanoIcono={14} onClick={() => setModo("borrar")} />
      </span>
    </div>
  );
}
