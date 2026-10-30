/** Reducción pura de una conversación: historial guardado + eventos del núcleo → elementos que se pintan. */
import type { Evento, MensajeHistorial } from "@aquiles/protocolo";
import type { Conversacion, Elemento } from "./tipos";
import { duracion, tokens } from "./formato";

let contador = 0;
const nuevoId = () => `e${++contador}`;

/** Esperas al modelo más cortas que esto no se apuntan como «Pensó durante». */
const PENSAMIENTO_MINIMO_MS = 1000;
const SALIDA_MAXIMA = 8000;

/** La herramienta `tareas` no lleva tarjeta en vivo: su evento `tareas` ya pinta la lista. */
const SIN_TARJETA = new Set(["tareas"]);

export function conversacionVacia(): Conversacion {
  return { elementos: [], cargando: false, trabajando: false };
}

export function desdeHistorial(historial: MensajeHistorial[]): Elemento[] {
  return historial.map((m): Elemento => {
    if (m.rol === "herramienta") {
      return {
        tipo: "herramienta",
        id: m.id || nuevoId(),
        nombre: m.nombre,
        resumen: m.resumen ?? "",
        estado: m.error ? "fallo" : "ok",
        salida: m.resultado,
        ...(m.diffs?.length ? { diffs: m.diffs } : {}),
      };
    }
    if (m.rol === "resumen") return { tipo: "resumen", id: nuevoId(), texto: m.texto };
    if (m.rol === "usuario") return { tipo: "usuario", id: nuevoId(), texto: m.texto };
    return { tipo: "asistente", id: nuevoId(), texto: m.texto, abierto: false };
  });
}

function cerrarTexto(l: Elemento[]): Elemento[] {
  return l.some((x) => x.tipo === "asistente" && x.abierto) ? l.map((x) => (x.tipo === "asistente" && x.abierto ? { ...x, abierto: false } : x)) : l;
}

/** Deja de esperar al modelo y, si la espera fue larga, la apunta. */
function dejarDePensar(c: Conversacion, ahora: number): Conversacion {
  if (c.pensandoDesde === undefined) return c;
  const ms = ahora - c.pensandoDesde;
  const elementos = ms >= PENSAMIENTO_MINIMO_MS ? [...c.elementos, { tipo: "pensamiento" as const, id: nuevoId(), ms }] : c.elementos;
  return { ...c, elementos, pensandoDesde: undefined };
}

export function anadirUsuario(c: Conversacion, texto: string, ahora: number, steer: boolean): Conversacion {
  const elementos = [...cerrarTexto(c.elementos), { tipo: "usuario" as const, id: nuevoId(), texto, hora: ahora }];
  if (steer) return { ...c, elementos };
  return { ...c, elementos, trabajando: true, pensandoDesde: ahora };
}

export function anadirAviso(c: Conversacion, nivel: "aviso" | "error", texto: string): Conversacion {
  return { ...c, elementos: [...c.elementos, { tipo: "aviso", id: nuevoId(), nivel, texto }] };
}

/** Eventos de una sesión concreta (los demás no tocan la conversación). */
export type EventoSesion = Extract<Evento, { sesionId: string }>;

export function aplicarEvento(c: Conversacion, e: EventoSesion, ahora: number): Conversacion {
  switch (e.tipo) {
    case "mensaje.delta": {
      const p = dejarDePensar(c, ahora);
      const ultimo = p.elementos.at(-1);
      if (ultimo?.tipo === "asistente" && ultimo.abierto) {
        return { ...p, elementos: [...p.elementos.slice(0, -1), { ...ultimo, texto: ultimo.texto + e.texto }] };
      }
      return { ...p, elementos: [...p.elementos, { tipo: "asistente", id: nuevoId(), texto: e.texto, abierto: true, hora: ahora }] };
    }
    case "herramienta.inicio": {
      const p = dejarDePensar(c, ahora);
      const elementos = cerrarTexto(p.elementos);
      if (SIN_TARJETA.has(e.nombre)) return { ...p, elementos };
      return {
        ...p,
        elementos: [...elementos, { tipo: "herramienta", id: e.id, nombre: e.nombre, resumen: e.resumen ?? resumenArgumentos(e.argumentos), estado: "en-curso", inicio: ahora }],
      };
    }
    case "herramienta.progreso":
      return {
        ...c,
        elementos: c.elementos.map((x) => (x.tipo === "herramienta" && x.id === e.id ? { ...x, salida: ((x.salida ?? "") + e.texto).slice(-SALIDA_MAXIMA) } : x)),
      };
    case "herramienta.fin": {
      const elementos = c.elementos.map((x) =>
        x.tipo === "herramienta" && x.id === e.id
          ? {
              ...x,
              estado: e.error ? ("fallo" as const) : ("ok" as const),
              salida: e.resultado,
              ...(e.diffs?.length ? { diffs: e.diffs } : {}),
              ...(x.inicio !== undefined ? { ms: ahora - x.inicio } : {}),
            }
          : x,
      );
      const quedan = elementos.some((x) => x.tipo === "herramienta" && x.estado === "en-curso");
      return { ...c, elementos, pensandoDesde: c.trabajando && !quedan ? ahora : c.pensandoDesde };
    }
    case "tareas": {
      const p = dejarDePensar(c, ahora);
      const sinViejas = cerrarTexto(p.elementos.filter((x) => x.tipo !== "tareas"));
      return { ...p, elementos: [...sinViejas, { tipo: "tareas", id: nuevoId(), tareas: e.tareas }] };
    }
    case "contexto.uso":
      return { ...c, contexto: { tokens: e.tokens, ...(e.ventana ? { ventana: e.ventana } : {}) } };
    case "contexto.compactado":
      return anadirAviso(c, "aviso", `Contexto compactado (${e.metodo}): ${tokens(e.antes)} → ${tokens(e.despues)} tokens`);
    case "turno.reintento":
      return anadirAviso(cerrar(c), "aviso", `Reintento ${e.intento} en ${duracion(e.esperaMs)}: ${e.motivo}`);
    case "turno.fin": {
      const elementos = cerrarTexto(c.elementos).map((x) => (x.tipo === "herramienta" && x.estado === "en-curso" ? { ...x, estado: "fallo" as const } : x));
      const fin: Conversacion = { ...c, elementos, trabajando: false, pensandoDesde: undefined };
      if (e.motivo === "error") return anadirAviso(fin, "error", e.error ?? "Error desconocido");
      if (e.motivo === "limite") return anadirAviso(fin, "aviso", "Se alcanzó el límite de pasos del turno");
      if (e.motivo === "parado") return anadirAviso(fin, "aviso", "Detenido");
      return fin;
    }
  }
}

function cerrar(c: Conversacion): Conversacion {
  return { ...c, elementos: cerrarTexto(c.elementos) };
}

function resumenArgumentos(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const clave of ["comando", "ruta", "patron", "pregunta"]) if (typeof a[clave] === "string") return a[clave] as string;
  return JSON.stringify(args);
}
