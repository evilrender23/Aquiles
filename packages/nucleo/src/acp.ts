/**
 * ACP (Agent Client Protocol, https://agentclientprotocol.com, versión 1): Aquiles como agente de un editor (Zed…)
 * por stdio. JSON-RPC 2.0, un mensaje por línea; stdout queda solo para el protocolo.
 *
 * - `session/new` no crea todavía la sesión de Aquiles: el motor solo sabe crearla lanzando un turno, así que se
 *   crea con el primer `session/prompt` (título «Editor», sin origen) y desde ahí se reutiliza.
 * - Los eventos del turno se traducen a `session/update`: texto, llamadas a herramientas (con diffs) y plan.
 * - Los permisos se piden al editor con `session/request_permission`.
 * - `session/cancel` para el turno. La sesión de Aquiles se conoce con el primer evento del turno: si se cancela
 *   antes, se para en cuanto llega.
 * - Un error del turno vuelve como error JSON-RPC, no como `refusal`: esa razón hace que el editor saque el prompt
 *   de la conversación, y aquí el prompt sigue en la sesión.
 */
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diff, Evento, TareaVisible } from "@aquiles/protocolo";
import { z } from "zod";
import type { PeticionAprobacion, RespuestaAprobacion } from "./bucle";
import type { Motor } from "./motor";

export const VERSION_ACP = 1;

const codigos = { parse: -32700, peticionInvalida: -32600, metodoNoExiste: -32601, paramsInvalidos: -32602, interno: -32603 } as const;

const OPCIONES_PERMISO = [
  { optionId: "permitir", name: "Permitir una vez", kind: "allow_once" },
  { optionId: "siempre", name: "Permitir siempre", kind: "allow_always" },
  { optionId: "denegar", name: "Rechazar", kind: "reject_once" },
] as const;

/** Tipo de llamada de ACP de cada herramienta de Aquiles (el editor elige el icono); las demás son «other». */
const TIPOS_HERRAMIENTA: Record<string, string> = {
  leer: "read", ver_skill: "read",
  buscar_texto: "search", buscar_ficheros: "search", buscar_sesiones: "search",
  escribir: "edit", editar: "edit", gestionar_skill: "edit", memoria: "edit",
  terminal: "execute", procesos: "execute",
  leer_web: "fetch", buscar_web: "fetch",
  tareas: "think",
};

const bloque = z.object({
  type: z.string(),
  text: z.string().optional(),
  uri: z.string().optional(),
  resource: z.object({ uri: z.string(), text: z.string().optional() }).optional(),
});
const esquemas = {
  initialize: z.object({ protocolVersion: z.number().int() }),
  "session/new": z.object({ cwd: z.string().min(1).optional(), mcpServers: z.array(z.unknown()).optional() }),
  "session/prompt": z.object({ sessionId: z.string().min(1), prompt: z.array(bloque) }),
  "session/cancel": z.object({ sessionId: z.string().min(1) }),
};

class ErrorAcp extends Error {
  constructor(readonly codigo: number, mensaje: string, readonly datos?: unknown) {
    super(mensaje);
  }
}

interface Turno {
  cancelado: boolean;
  /** Peticiones de permiso sin contestar: al cancelar se deniegan sin esperar al editor. */
  permisos: Set<(r: RespuestaAprobacion) => void>;
}

interface SesionAcp {
  id: string;
  cwd: string;
  /** Sesión de Aquiles; falta hasta el primer turno. */
  aquiles?: string;
  turno?: Turno;
}

export interface OpcionesAcp {
  motor: Motor;
  entrada: ReadableStream<Uint8Array>;
  /** Escribe una línea de protocolo (sin el salto de línea). */
  salida: (linea: string) => void;
  version: string;
  cwdPorDefecto: string;
}

/** Atiende al editor hasta que cierra la entrada; entonces para los turnos y espera a que acaben. */
export async function servirAcp(o: OpcionesAcp): Promise<void> {
  const sesiones = new Map<string, SesionAcp>();
  const pendientes = new Map<number, { ok: (r: unknown) => void; mal: (e: Error) => void }>();
  const enMarcha = new Set<Promise<void>>();
  let siguiente = 0;

  const enviar = (m: Record<string, unknown>) => o.salida(JSON.stringify({ jsonrpc: "2.0", ...m }));
  const actualizar = (s: SesionAcp, update: Record<string, unknown>) => enviar({ method: "session/update", params: { sessionId: s.id, update } });
  const pedir = (method: string, params: unknown): Promise<unknown> =>
    new Promise((ok, mal) => {
      const id = siguiente++;
      pendientes.set(id, { ok, mal });
      enviar({ id, method, params });
    });

  const conocer = (s: SesionAcp, turno: Turno, sesionId: string) => {
    if (s.aquiles) return;
    s.aquiles = sesionId;
    if (turno.cancelado) o.motor.parar(sesionId);
  };

  const cancelar = (s: SesionAcp) => {
    const t = s.turno;
    if (!t) return;
    t.cancelado = true;
    if (s.aquiles) o.motor.parar(s.aquiles);
    cancelarPermisos(t);
  };

  const pedirPermiso = (s: SesionAcp, t: Turno, p: PeticionAprobacion): Promise<RespuestaAprobacion> => {
    if (t.cancelado) return Promise.resolve("denegar");
    return new Promise((ok) => {
      t.permisos.add(ok);
      pedir("session/request_permission", {
        sessionId: s.id,
        toolCall: {
          toolCallId: p.id, title: tituloHerramienta(p.herramienta, p.resumen), kind: tipoHerramienta(p.herramienta), status: "pending",
          rawInput: p.argumentos, content: [texto(`Pide permiso: ${p.motivo}`)],
        },
        options: OPCIONES_PERMISO,
      })
        .then(decisionPermiso, () => "denegar" as const)
        .then((d) => {
          if (!t.permisos.delete(ok)) return; // ya se denegó al cancelar
          ok(d);
        });
    });
  };

  const alEvento = (s: SesionAcp, t: Turno, e: Evento) => {
    const sesionId = e.tipo === "sesion.actualizada" ? e.sesion.sesionId : "sesionId" in e ? e.sesionId : undefined;
    if (sesionId) conocer(s, t, sesionId);
    switch (e.tipo) {
      case "mensaje.delta":
        actualizar(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.texto } });
        break;
      case "herramienta.inicio":
        actualizar(s, {
          sessionUpdate: "tool_call", toolCallId: e.id, title: tituloHerramienta(e.nombre, e.resumen), kind: tipoHerramienta(e.nombre),
          status: "in_progress", rawInput: e.argumentos, ...ubicaciones(e.argumentos, s.cwd),
        });
        break;
      case "herramienta.fin":
        actualizar(s, {
          sessionUpdate: "tool_call_update", toolCallId: e.id, status: e.error ? "failed" : "completed",
          content: [...(e.diffs ?? []).map((d) => diffAcp(d, s.cwd)), ...(e.resultado ? [texto(e.resultado)] : [])],
        });
        break;
      case "tareas":
        actualizar(s, { sessionUpdate: "plan", entries: e.tareas.map(entradaPlan) });
        break;
    }
  };

  const metodos: Record<string, (params: unknown) => unknown> = {
    initialize: (params) => {
      leer("initialize", params);
      return {
        protocolVersion: VERSION_ACP,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
        },
        agentInfo: { name: "aquiles", title: "Aquiles", version: o.version },
        authMethods: [],
      };
    },
    authenticate: () => ({}),
    "session/new": (params) => {
      const { cwd } = leer("session/new", params);
      const s: SesionAcp = { id: `aquiles-${crypto.randomUUID()}`, cwd: cwd ? (isAbsolute(cwd) ? cwd : resolve(o.cwdPorDefecto, cwd)) : o.cwdPorDefecto };
      sesiones.set(s.id, s);
      o.motor.log(`acp: sesión ${s.id} en ${s.cwd}`);
      return { sessionId: s.id };
    },
    "session/prompt": async (params) => {
      const p = leer("session/prompt", params);
      const s = sesiones.get(p.sessionId);
      if (!s) throw new ErrorAcp(codigos.paramsInvalidos, `No existe la sesión ${p.sessionId}`);
      if (s.turno) throw new ErrorAcp(codigos.peticionInvalida, "Ya hay un turno en marcha en esta sesión");
      const texto = textoDelPrompt(p.prompt);
      if (!texto) throw new ErrorAcp(codigos.paramsInvalidos, "El prompt no tiene texto");
      const t: Turno = { cancelado: false, permisos: new Set() };
      s.turno = t;
      try {
        const r = await o.motor.turno({
          ...(s.aquiles ? { sesionId: s.aquiles } : { nueva: { cwd: s.cwd, titulo: "Editor" } }),
          texto,
          aprobar: (q) => pedirPermiso(s, t, q),
          alEvento: (e) => alEvento(s, t, e),
        });
        conocer(s, t, r.sesionId);
        if (t.cancelado || r.resultado.motivo === "parado") return { stopReason: "cancelled" };
        if (r.resultado.motivo === "limite") return { stopReason: "max_turn_requests" };
        if (r.resultado.motivo === "error") throw new ErrorAcp(codigos.interno, r.resultado.error ?? "El turno falló");
        return { stopReason: "end_turn" };
      } catch (e) {
        if (t.cancelado && !(e instanceof ErrorAcp)) return { stopReason: "cancelled" };
        throw e;
      } finally {
        cancelarPermisos(t);
        s.turno = undefined;
      }
    },
  };

  const notificaciones: Record<string, (params: unknown) => void> = {
    "session/cancel": (params) => {
      const s = sesiones.get(leer("session/cancel", params).sessionId);
      if (s) cancelar(s);
    },
  };

  const atender = async (linea: string): Promise<void> => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(linea);
    } catch {
      return enviar({ id: null, error: { code: codigos.parse, message: "JSON no válido" } });
    }
    if (typeof m !== "object" || m === null || Array.isArray(m) || m.jsonrpc !== "2.0") {
      return enviar({ id: null, error: { code: codigos.peticionInvalida, message: "Petición JSON-RPC no válida" } });
    }
    const id = m.id as number | string | null | undefined;
    // Respuesta del editor a una petición nuestra.
    if (m.method === undefined && typeof id === "number" && pendientes.has(id)) {
      const p = pendientes.get(id)!;
      pendientes.delete(id);
      const error = m.error as { message?: string } | undefined;
      if (error) p.mal(new Error(error.message ?? "error del editor"));
      else p.ok(m.result);
      return;
    }
    if (typeof m.method !== "string") return enviar({ id: id ?? null, error: { code: codigos.peticionInvalida, message: "Falta el método" } });
    if (!("id" in m)) {
      try {
        notificaciones[m.method]?.(m.params);
      } catch (e) {
        o.motor.log(`acp: ${m.method}: ${e instanceof Error ? e.message : e}`);
      }
      return;
    }
    const metodo = metodos[m.method];
    if (!metodo) return enviar({ id, error: { code: codigos.metodoNoExiste, message: `Método no soportado: ${m.method}` } });
    try {
      enviar({ id, result: await metodo(m.params) });
    } catch (e) {
      if (e instanceof ErrorAcp) return enviar({ id, error: { code: e.codigo, message: e.message, ...(e.datos === undefined ? {} : { data: e.datos }) } });
      o.motor.log(`acp: error en ${m.method}: ${e instanceof Error ? e.stack : e}`);
      enviar({ id, error: { code: codigos.interno, message: e instanceof Error ? e.message : String(e) } });
    }
  };

  // Cada mensaje se atiende sin esperar al anterior: mientras dura un prompt llegan cancelaciones y respuestas de permisos.
  const despachar = (linea: string) => {
    if (!linea.trim()) return;
    const p = atender(linea).catch((e) => o.motor.log(`acp: ${e instanceof Error ? e.message : e}`));
    enMarcha.add(p);
    void p.finally(() => enMarcha.delete(p));
  };
  const lector = o.entrada.getReader();
  const decodificador = new TextDecoder();
  let resto = "";
  for (;;) {
    let trozo: Awaited<ReturnType<typeof lector.read>>;
    try {
      trozo = await lector.read();
    } catch (e) {
      o.motor.log(`acp: la entrada falló: ${e instanceof Error ? e.message : e}`);
      break;
    }
    if (trozo.done) break;
    resto += decodificador.decode(trozo.value, { stream: true });
    let fin = resto.indexOf("\n");
    while (fin !== -1) {
      despachar(resto.slice(0, fin));
      resto = resto.slice(fin + 1);
      fin = resto.indexOf("\n");
    }
  }
  despachar(resto + decodificador.decode());

  // El editor se fue: nadie va a contestar ni a leer.
  for (const s of sesiones.values()) cancelar(s);
  for (const p of pendientes.values()) p.mal(new Error("El editor se desconectó"));
  pendientes.clear();
  await Promise.allSettled([...enMarcha]);
}

function leer<M extends keyof typeof esquemas>(metodo: M, params: unknown): z.infer<(typeof esquemas)[M]> {
  const r = esquemas[metodo].safeParse(params ?? {});
  if (!r.success) throw new ErrorAcp(codigos.paramsInvalidos, "Parámetros no válidos", r.error.issues);
  return r.data as z.infer<(typeof esquemas)[M]>;
}

function cancelarPermisos(t: Turno): void {
  for (const responder of t.permisos) responder("denegar");
  t.permisos.clear();
}

function decisionPermiso(r: unknown): RespuestaAprobacion {
  const salida = (r as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
  if (salida?.outcome !== "selected") return "denegar";
  return salida.optionId === "permitir" || salida.optionId === "siempre" ? salida.optionId : "denegar";
}

/** Texto del prompt: los bloques de texto y las menciones de ficheros en su sitio; el contenido incrustado, al final. */
export function textoDelPrompt(bloques: readonly z.infer<typeof bloque>[]): string {
  let texto = "";
  const adjuntos: string[] = [];
  for (const b of bloques) {
    if (b.type === "text" && b.text) texto += b.text;
    else if (b.type === "resource_link" && b.uri) texto += rutaDeUri(b.uri);
    else if (b.type === "resource" && b.resource) {
      const ruta = rutaDeUri(b.resource.uri);
      texto += ruta;
      if (b.resource.text !== undefined) adjuntos.push(`Contenido de ${ruta}:\n\`\`\`\n${b.resource.text}\n\`\`\``);
    }
  }
  return [texto.trim(), ...adjuntos].filter(Boolean).join("\n\n");
}

function rutaDeUri(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

function tituloHerramienta(nombre: string, resumen?: string): string {
  return resumen ? `${nombre}: ${resumen}` : nombre;
}

function tipoHerramienta(nombre: string): string {
  return TIPOS_HERRAMIENTA[nombre] ?? "other";
}

function texto(t: string) {
  return { type: "content", content: { type: "text", text: t } };
}

/** Si la herramienta trabaja sobre una ruta, el editor puede seguirla. */
function ubicaciones(argumentos: unknown, cwd: string): { locations?: { path: string; line?: number }[] } {
  const a = argumentos as { ruta?: unknown; desde?: unknown } | null;
  if (typeof a?.ruta !== "string" || !a.ruta) return {};
  return { locations: [{ path: resolve(cwd, a.ruta), ...(typeof a.desde === "number" ? { line: a.desde } : {}) }] };
}

/** ACP quiere texto antes y después; Aquiles guarda bloques con contexto, así que se reconstruyen los trozos. */
function diffAcp(d: Diff, cwd: string) {
  const lado = (sin: "+" | "-") =>
    d.bloques.map((b) => b.lineas.filter((l) => l.tipo !== sin).map((l) => l.texto).join("\n")).join("\n…\n");
  return { type: "diff", path: resolve(cwd, d.ruta), oldText: d.nuevo ? null : lado("+"), newText: lado("-") };
}

function entradaPlan(t: TareaVisible) {
  return { content: t.texto, priority: "medium", status: t.estado === "en-curso" ? "in_progress" : t.estado === "hecha" ? "completed" : "pending" };
}
