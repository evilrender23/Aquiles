import type { Evento, PeticionesCliente, TareaVisible } from "@aquiles/protocolo";
import { useEffect, useReducer, useRef, useState } from "react";
import { datosConexion } from "./conexion";
import { ClienteRpc } from "./rpc";

type Elemento =
  | { tipo: "usuario"; texto: string }
  | { tipo: "asistente"; texto: string; abierto: boolean }
  | { tipo: "herramienta"; id: string; nombre: string; resumen: string; estado: "en-curso" | "ok" | "fallo"; resultado?: string }
  | { tipo: "tareas"; tareas: TareaVisible[] }
  | { tipo: "aviso"; nivel: "AVISO" | "FALLO"; texto: string };

type Accion = { tipo: "usuario"; texto: string } | { tipo: "evento"; evento: Evento } | { tipo: "aviso"; nivel: "AVISO" | "FALLO"; texto: string };

type Pendiente =
  | { tipo: "aprobacion"; params: PeticionesCliente["aprobacion.pedir"]["params"]; responder: (d: "permitir" | "siempre" | "denegar") => void }
  | { tipo: "pregunta"; params: PeticionesCliente["pregunta.hacer"]["params"]; responder: (r: string) => void };

const MARCA_TAREA = { hecha: "[x]", "en-curso": "[>]", pendiente: "[ ]" } as const;

function reducir(lista: Elemento[], a: Accion): Elemento[] {
  if (a.tipo === "usuario") return [...lista, { tipo: "usuario", texto: a.texto }];
  if (a.tipo === "aviso") return [...lista, { tipo: "aviso", nivel: a.nivel, texto: a.texto }];
  const e = a.evento;
  const cerrar = (l: Elemento[]) => l.map((x) => (x.tipo === "asistente" && x.abierto ? { ...x, abierto: false } : x));
  switch (e.tipo) {
    case "mensaje.delta": {
      const ultimo = lista.at(-1);
      if (ultimo?.tipo === "asistente" && ultimo.abierto) return [...lista.slice(0, -1), { ...ultimo, texto: ultimo.texto + e.texto }];
      return [...lista, { tipo: "asistente", texto: e.texto, abierto: true }];
    }
    case "herramienta.inicio":
      return [...cerrar(lista), { tipo: "herramienta", id: e.id, nombre: e.nombre, resumen: e.resumen ?? resumenArgs(e.argumentos), estado: "en-curso" }];
    case "herramienta.progreso":
      return lista.map((x) => (x.tipo === "herramienta" && x.id === e.id ? { ...x, resultado: ((x.resultado ?? "") + e.texto).slice(-4000) } : x));
    case "herramienta.fin":
      return lista.map((x) => (x.tipo === "herramienta" && x.id === e.id ? { ...x, estado: e.error ? "fallo" : "ok", resultado: e.resultado } : x));
    case "tareas": {
      const sinViejas = lista.filter((x) => x.tipo !== "tareas");
      return [...cerrar(sinViejas), { tipo: "tareas", tareas: e.tareas }];
    }
    case "turno.reintento":
      return [...cerrar(lista), { tipo: "aviso", nivel: "AVISO", texto: `reintento ${e.intento} en ${Math.round(e.esperaMs / 1000)} s: ${e.motivo}` }];
    case "contexto.compactado":
      return [...lista, { tipo: "aviso", nivel: "AVISO", texto: `contexto compactado (${e.metodo})` }];
    case "contexto.uso":
      return lista;
    case "turno.fin": {
      const l = cerrar(lista);
      if (e.motivo === "error") return [...l, { tipo: "aviso", nivel: "FALLO", texto: e.error ?? "error desconocido" }];
      if (e.motivo === "limite") return [...l, { tipo: "aviso", nivel: "AVISO", texto: "se alcanzó el límite de pasos del turno" }];
      if (e.motivo === "parado") return [...l, { tipo: "aviso", nivel: "AVISO", texto: "parado" }];
      return l;
    }
  }
}

function resumenArgs(args: unknown): string {
  if (args && typeof args === "object" && "ruta" in args) return String((args as { ruta: unknown }).ruta);
  return JSON.stringify(args);
}

export function App() {
  const [elementos, despachar] = useReducer(reducir, []);
  const [cliente, setCliente] = useState<ClienteRpc>();
  const [sesionId, setSesionId] = useState<string>();
  const [trabajando, setTrabajando] = useState(false);
  const [pendiente, setPendiente] = useState<Pendiente>();
  const [texto, setTexto] = useState("");
  const final = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let vivo = true;
    let c: ClienteRpc | undefined;
    (async () => {
      try {
        const { url, token } = await datosConexion();
        c = await ClienteRpc.conectar(url, token);
        if (!vivo) return c.cerrar();
        c.alEvento((evento) => {
          despachar({ tipo: "evento", evento });
          if (evento.tipo === "turno.fin") {
            setTrabajando(false);
            setPendiente(undefined);
          }
        });
        c.atender("aprobacion.pedir", (params) => new Promise((ok) => setPendiente({ tipo: "aprobacion", params, responder: (decision) => ok({ decision }) })));
        c.atender("pregunta.hacer", (params) => new Promise((ok) => setPendiente({ tipo: "pregunta", params, responder: (respuesta) => ok({ respuesta }) })));
        c.alCerrar(() => vivo && despachar({ tipo: "aviso", nivel: "FALLO", texto: "se perdió la conexión con el núcleo" }));
        const s = await c.llamar("sesion.crear", {});
        setCliente(c);
        setSesionId(s.sesionId);
      } catch (e) {
        despachar({ tipo: "aviso", nivel: "FALLO", texto: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      vivo = false;
      c?.cerrar();
    };
  }, []);

  useEffect(() => {
    // Sin devolver nada: en Chromium reciente scrollIntoView devuelve una promesa y React la tomaría por limpieza.
    final.current?.scrollIntoView({ block: "end" });
  }, [elementos, pendiente]);

  const resolver = (f: () => void) => {
    f();
    setPendiente(undefined);
  };

  const enviar = async () => {
    const t = texto.trim();
    if (!t || !cliente || !sesionId) return;
    setTexto("");
    if (pendiente?.tipo === "pregunta") return resolver(() => pendiente.responder(t));
    despachar({ tipo: "usuario", texto: t });
    try {
      if (trabajando) await cliente.llamar("prompt.steer", { sesionId, texto: t });
      else {
        setTrabajando(true);
        await cliente.llamar("prompt.enviar", { sesionId, texto: t });
      }
    } catch (e) {
      setTrabajando(false);
      despachar({ tipo: "aviso", nivel: "FALLO", texto: e instanceof Error ? e.message : String(e) });
    }
  };

  const parar = () => cliente && sesionId && void cliente.llamar("prompt.parar", { sesionId });

  return (
    <main className="app">
      <section className="conversacion">
        {elementos.map((x, i) => {
          if (x.tipo === "usuario") return <p key={i} className="usuario">{x.texto}</p>;
          if (x.tipo === "asistente") return <p key={i} className="asistente">{x.texto}</p>;
          if (x.tipo === "aviso") return <p key={i} className="aviso">[{x.nivel}] {x.texto}</p>;
          if (x.tipo === "tareas")
            return (
              <ul key={i} className="tareas">
                {x.tareas.map((t, j) => (
                  <li key={j} className={t.estado}>
                    {MARCA_TAREA[t.estado]} {t.texto}
                  </li>
                ))}
              </ul>
            );
          return (
            <details key={i} className={`herramienta ${x.estado}`} open={x.estado === "en-curso" && !!x.resultado}>
              <summary>
                <span className="estado">{x.estado === "en-curso" ? "[…]" : x.estado === "ok" ? "[ok]" : "[FALLO]"}</span> {x.nombre}{" "}
                <span className="args">{x.resumen}</span>
              </summary>
              {x.resultado && <pre>{x.resultado}</pre>}
            </details>
          );
        })}
        {pendiente?.tipo === "aprobacion" && (
          <div className="permiso">
            <p>
              ¿Permitir {pendiente.params.herramienta}? <span className="args">{pendiente.params.motivo}</span>
            </p>
            <pre>{pendiente.params.resumen || JSON.stringify(pendiente.params.argumentos, null, 2)}</pre>
            <div className="botones">
              <button type="button" onClick={() => resolver(() => pendiente.responder("permitir"))}>
                Permitir
              </button>
              <button type="button" onClick={() => resolver(() => pendiente.responder("siempre"))}>
                Siempre
              </button>
              <button type="button" className="negar" onClick={() => resolver(() => pendiente.responder("denegar"))}>
                Denegar
              </button>
            </div>
          </div>
        )}
        {pendiente?.tipo === "pregunta" && (
          <div className="permiso">
            <p>{pendiente.params.texto}</p>
            {pendiente.params.opciones && (
              <div className="botones">
                {pendiente.params.opciones.map((op) => (
                  <button key={op} type="button" onClick={() => resolver(() => pendiente.responder(op))}>
                    {op}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div ref={final} />
      </section>
      <form
        className="entrada"
        onSubmit={(e) => {
          e.preventDefault();
          void enviar();
        }}
      >
        <span className="prompt">›</span>
        <textarea
          value={texto}
          rows={1}
          disabled={!sesionId}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void enviar();
            }
          }}
        />
        {trabajando && !texto.trim() ? (
          <button type="button" onClick={parar}>
            Parar
          </button>
        ) : (
          <button type="submit" disabled={!sesionId || !texto.trim()}>
            Enviar
          </button>
        )}
      </form>
    </main>
  );
}
