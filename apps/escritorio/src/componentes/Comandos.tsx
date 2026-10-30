import type { InfoComando } from "@aquiles/protocolo";
import { clases } from "@aquiles/ui";
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAcciones } from "../estado/almacen";
import "./Comandos.css";

/** `/` al principio de la caja y el nombre a medio escribir, hasta el cursor. */
const EN_CURSO = /^\/([^\s/]*)$/;
/** Un comando entero: `/nombre` y, si hay, lo que va detrás. */
const COMANDO = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

/** Un comando que resuelve la propia app, sin llegar al núcleo. `false` = no se pudo: el texto se queda en la caja. */
export interface ComandoApp extends InfoComando {
  ejecutar: (argumentos: string) => boolean | undefined;
}

/** Los comandos de una caja: los del núcleo (`comandos.listar`) y los de la app. */
export interface FuenteComandos {
  listar: () => Promise<InfoComando[]>;
  app: ComandoApp[];
}

/**
 * Comandos de la caja de una sesión o, sin `sesionId`, de Nueva sesión. Los de la app solo tienen sentido con sesión:
 * `/nueva` (volver a Nueva sesión) y `/renombrar`.
 */
export function useFuenteComandos(sesionId?: string): FuenteComandos {
  const { llamar, nuevaSesion, renombrar } = useAcciones();
  return useMemo(
    () => ({
      listar: async () => (await llamar("comandos.listar", sesionId ? { sesionId } : {})).comandos,
      app: sesionId
        ? [
            { nombre: "nueva", descripcion: "Abre una sesión nueva", origen: "aquiles", ejecutar: () => (nuevaSesion(), true) },
            {
              nombre: "renombrar",
              argumentos: "<título>",
              descripcion: "Cambia el título de esta sesión",
              origen: "aquiles",
              ejecutar: (titulo) => {
                if (!titulo) return false;
                void renombrar(sesionId, titulo.slice(0, 120)).catch(() => {});
                return true;
              },
            },
          ]
        : [],
    }),
    [sesionId, llamar, nuevaSesion, renombrar],
  );
}

/** Primero los de Aquiles y luego las skills, cada grupo por nombre. Un comando de la app tapa a uno del núcleo que se llame igual. */
function juntar(app: ComandoApp[], nucleo: InfoComando[]): InfoComando[] {
  const deApp = new Set(app.map((c) => c.nombre));
  return [...app, ...nucleo.filter((c) => !deApp.has(c.nombre))].sort(
    (a, b) => Number(a.origen === "skill") - Number(b.origen === "skill") || a.nombre.localeCompare(b.nombre),
  );
}

/** Los que encajan con lo escrito: los que empiezan así, luego los que lo contienen y luego los que lo dicen en la descripción. */
function filtrar(lista: InfoComando[], consulta: string): InfoComando[] {
  const q = consulta.toLowerCase();
  const nota = (c: InfoComando) => {
    const n = c.nombre.toLowerCase();
    return n.startsWith(q) ? 0 : n.includes(q) ? 1 : c.descripcion.toLowerCase().includes(q) ? 2 : -1;
  };
  return lista
    .map((c) => ({ c, n: nota(c) }))
    .filter((x) => x.n >= 0)
    .sort((a, b) => a.n - b.n)
    .map((x) => x.c);
}

/**
 * Comandos con `/` al principio de una caja de texto. Elegir uno con argumentos deja `/nombre ` para escribirlos; uno
 * sin argumentos se envía en el acto. Los de la app se ejecutan aquí; los demás van al núcleo como texto
 * (prompt.enviar), que los reconoce. Con `soloApp` (hay un turno en marcha y el texto iría como steer) solo se
 * ofrecen los de la app.
 */
export function useComandos(
  caja: RefObject<HTMLTextAreaElement | null>,
  texto: string,
  setTexto: (t: string) => void,
  o: { fuente?: FuenteComandos; soloApp?: boolean; enviar: (texto: string) => void },
) {
  const [consulta, setConsulta] = useState<string>();
  const [todos, setTodos] = useState<InfoComando[]>([]);
  const [activa, setActiva] = useState(0);
  // Cerrada con Escape: no se vuelve a abrir hasta que la caja deje de empezar por `/`.
  const [descartada, setDescartada] = useState(false);
  const id = useId();
  // La fuente cambia de identidad con cada render de quien la pasa: pedir la lista no debe depender de eso.
  const fuente = useRef(o.fuente);
  fuente.current = o.fuente;
  const hayFuente = !!o.fuente;
  const abriendo = consulta !== undefined;

  const detectar = useCallback(() => {
    const c = caja.current;
    if (!c || !hayFuente) {
      setConsulta(undefined);
      return;
    }
    if (!c.value.startsWith("/")) setDescartada(false);
    const m = descartada ? null : EN_CURSO.exec(c.value.slice(0, c.selectionStart));
    setConsulta(m ? (m[1] ?? "") : undefined);
  }, [caja, hayFuente, descartada]);

  // La lista se pide cada vez que se abre: así recoge las skills que se hayan activado o creado.
  useEffect(() => {
    const f = fuente.current;
    if (!abriendo || !f) return;
    let vigente = true;
    setTodos(juntar(f.app, []));
    f.listar().then(
      (nucleo) => vigente && setTodos(juntar(f.app, nucleo)),
      () => {},
    );
    return () => {
      vigente = false;
    };
  }, [abriendo]);

  const deApp = useMemo(() => new Set((o.fuente?.app ?? []).map((c) => c.nombre)), [o.fuente]);
  const sugerencias = useMemo(
    () => (consulta === undefined ? [] : filtrar(o.soloApp ? todos.filter((c) => deApp.has(c.nombre)) : todos, consulta)),
    [consulta, todos, o.soloApp, deApp],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar lo escrito o la lista, la primera vuelve a ser la activa.
  useEffect(() => {
    setActiva(0);
  }, [consulta, todos]);

  const abierta = sugerencias.length > 0;

  // Con muchas skills la lista se desplaza: la activa tiene que verse. (Sin devolver lo que da scrollIntoView.)
  useEffect(() => {
    if (abierta) document.getElementById(`${id}-${activa}`)?.scrollIntoView({ block: "nearest" });
  }, [abierta, activa, id]);

  const cerrar = () => {
    setDescartada(true);
    setConsulta(undefined);
  };

  /** Si `t` es un comando de la app, lo ejecuta: true si se hizo, false si no se pudo; undefined si no es de la app. */
  const ejecutarApp = (t: string): boolean | undefined => {
    const m = COMANDO.exec(t.trim());
    const c = m && fuente.current?.app.find((x) => x.nombre === m[1]);
    if (!c) return undefined;
    return c.ejecutar((m[2] ?? "").trim()) !== false;
  };

  const elegir = (c: InfoComando) => {
    const el = caja.current;
    if (!el) return;
    setConsulta(undefined);
    if (!c.argumentos) {
      o.enviar(`/${c.nombre}`);
      return;
    }
    const inicio = `/${c.nombre} `;
    setTexto(inicio + texto.slice(el.selectionStart).replace(/^\s+/, ""));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(inicio.length, inicio.length);
    });
  };

  /** Las teclas de la lista (flechas, Enter o Tab para elegir, Escape para cerrarla). true si era para ella. */
  const alTecla = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!abierta) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const paso = e.key === "ArrowDown" ? 1 : -1;
      setActiva((a) => (a + paso + sugerencias.length) % sugerencias.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
      e.preventDefault();
      const c = sugerencias[activa];
      if (c) elegir(c);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cerrar();
      return true;
    }
    return false;
  };

  /** Atributos ARIA para la caja: es un combobox cuya lista son los comandos. */
  const aria = {
    "aria-autocomplete": "list" as const,
    "aria-expanded": abierta,
    ...(abierta ? { "aria-controls": id, "aria-activedescendant": `${id}-${activa}` } : {}),
  };

  const lista = abierta ? (
    <div id={id} role="listbox" aria-label="Comandos" className="comandos">
      {sugerencias.map((c, i) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: el teclado se maneja desde la caja (aria-activedescendant).
        <div
          key={c.nombre}
          id={`${id}-${i}`}
          tabIndex={-1}
          role="option"
          aria-selected={i === activa}
          className={clases("comandos__opcion", i === activa && "comandos__opcion--activa")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => elegir(c)}
          onMouseEnter={() => setActiva(i)}
        >
          <span className="comandos__nombre">/{c.nombre}</span>
          {c.argumentos && <span className="comandos__argumentos">{c.argumentos}</span>}
          <span className="comandos__descripcion">{c.descripcion}</span>
        </div>
      ))}
    </div>
  ) : null;

  return { detectar, alTecla, aria, lista, abierta, ejecutarApp };
}
