/**
 * Proveedor sobre el CLI oficial de Claude Code (`claude`), en modo no interactivo.
 *
 * Mantiene un proceso `claude -p` por sesión con entrada y salida stream-json: cada línea
 * `{"type":"user",…}` en stdin es un turno, y la salida emite `stream_event` (deltas de texto)
 * hasta un `result`. Claude Code conserva la conversación, así que solo se envían los mensajes nuevos.
 *
 * Se arranca sin herramientas propias (`--tools ""`), sin las personalizaciones del usuario
 * (`--safe-mode`: ni CLAUDE.md, ni hooks, ni MCP) y sin guardar la sesión en disco. El system prompt
 * es el de Aquiles más el protocolo de herramientas en texto (protocolo-texto.ts). Usa la cuenta con
 * la que se haya iniciado sesión en `claude`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Uso } from "@aquiles/protocolo";
import { base64, imagenesAdjuntas, LIMITES_API, textoUsuario, type VistaImagen, verImagenes } from "../adjuntos";
import { ErrorAbortado, ErrorProveedor, type Mensaje, type PeticionModelo, type Proveedor, type RespuestaModelo } from "../tipos";
import { lineas } from "./agy";
import { extraerLlamadas, instrucciones, renderizarMensaje, textoVisible } from "./protocolo-texto";

export const MODELOS_CLAUDE = ["sonnet", "opus", "haiku", "fable"];

/** Tras pedir la interrupción, cuánto se espera al `result` antes de matar el proceso. */
const ESPERA_INTERRUPCION_MS = 5000;

/**
 * Variables que pone una sesión de Claude Code a sus procesos hijos. Si el núcleo se lanza desde una
 * (en desarrollo), el `claude` hijo se creería parte de ella; se quitan salvo las que configura el usuario.
 */
const DE_SESION_ANFITRIONA = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|ANTHROPIC_BASE_URL$)/;
const DEL_USUARIO = /^CLAUDE_CODE_(USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|OAUTH_TOKEN|GIT_BASH_PATH|MAX_OUTPUT_TOKENS)$/;

/** `content` de un mensaje de usuario: texto, o bloques de la API de mensajes si lleva imágenes. */
type ContenidoClaude =
  | string
  | ({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } })[];

interface EventoClaude {
  type?: string;
  subtype?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; stop_reason?: string | null };
  };
  is_error?: boolean;
  result?: string;
  usage?: UsoClaude;
  rate_limit_info?: { status?: string; resetsAt?: number };
  /** Por modelo; trae la ventana de contexto real (p. ej. 1.000.000 en los Claude 5). */
  modelUsage?: Record<string, { contextWindow?: number }>;
}

interface UsoClaude {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number } | null;
}

interface SesionClaude {
  proceso: Bun.Subprocess<"pipe", "pipe", "pipe">;
  /** Líneas de stdout aún sin leer; las llena un lector en segundo plano para no perder ninguna al abortar. */
  cola: string[];
  terminada: boolean;
  avisar?: () => void;
  rutaSistema: string;
  enviados: number;
  stderr: string[];
  llamadas: number;
  /** Fin de la ventana de uso si el CLI avisó de que se ha agotado (ms desde epoch). */
  limiteHasta?: number;
}

export interface OpcionesClaude {
  /** Programa y argumentos iniciales; por defecto `claude` del PATH. */
  comando?: string[];
  /** Alias (`sonnet`, `opus`, `haiku`, `fable`) o id completo; si falta, el que tenga `claude` por defecto. */
  modelo?: string;
  /** `--effort` del CLI (sus niveles salen de `claude --help`, ver esfuerzo.ts); si falta, el que elija el CLI. */
  esfuerzo?: string;
}

export class ProveedorClaude implements Proveedor {
  readonly nombre = "claude";
  readonly conversacionPropia = true;
  /** La dice el CLI en cada `result` (`modelUsage[…].contextWindow`); hasta la primera respuesta no se sabe. */
  ventanaContexto?: number;
  get modelo(): string | undefined {
    return this.opciones.modelo;
  }
  private sesiones = new Map<string, SesionClaude>();

  constructor(private opciones: OpcionesClaude = {}) {}

  async responder(p: PeticionModelo, alDelta: (texto: string) => void): Promise<RespuestaModelo> {
    if (p.senal.aborted) throw new ErrorAbortado();
    const s = this.sesion(p);
    const nuevos = p.mensajes.slice(s.enviados);
    const vistas = verImagenes(p.mensajes, LIMITES_API);
    // Un proceso nuevo con historial previo (reinicio del núcleo o del proceso): se le pasa la conversación entera.
    const texto =
      s.enviados === 0 && nuevos.some((m) => m.rol === "asistente")
        ? transcripcion(nuevos, vistas)
        : nuevos.filter((m) => m.rol !== "asistente").map((m) => renderizarMensaje(m, vistas)).join("\n\n");
    // Claude Code guarda la conversación: cada imagen se manda una vez, en el mensaje que la trae.
    const imagenes = nuevos.flatMap((m) => imagenesAdjuntas(m, vistas));
    const contenido: ContenidoClaude = imagenes.length
      ? [
          ...imagenes.map((a) => ({ type: "image" as const, source: { type: "base64" as const, media_type: a.tipo, data: base64(a) } })),
          { type: "text", text: texto },
        ]
      : texto;
    s.enviados = p.mensajes.length;
    s.llamadas += 1;

    const abortar = new Promise<never>((_, rechazar) => {
      p.senal.addEventListener("abort", () => rechazar(new ErrorAbortado()), { once: true });
    });
    try {
      const r = await this.turno(s, contenido, alDelta, abortar);
      // Un resultado que el modelo escriba tras sus llamadas es inventado: se corta desde ahí.
      const llamada = r.texto.indexOf("</herramienta>");
      const corte = llamada >= 0 ? r.texto.indexOf("<resultado", llamada) : -1;
      const final = extraerLlamadas(corte >= 0 ? r.texto.slice(0, corte) : r.texto, `claude${s.llamadas}`);
      return { ...final, uso: r.uso, ...(r.cortada ? { cortada: true } : {}) };
    } catch (e) {
      if (e instanceof ErrorAbortado && (await this.interrumpir(s))) throw e;
      // Proceso en estado desconocido: se descarta y la próxima llamada le pasa la conversación a uno nuevo.
      await this.cerrar(p.sesionId);
      throw e;
    }
  }

  /** Envía un mensaje y lee hasta su `result`. */
  private async turno(
    s: SesionClaude,
    contenido: ContenidoClaude,
    alDelta: (texto: string) => void,
    abortar: Promise<never>,
  ): Promise<{ texto: string; uso: Uso; cortada: boolean }> {
    escribir(s, { type: "user", message: { role: "user", content: contenido } });
    let acumulado = "";
    let emitido = 0;
    let cortada = false;
    for (;;) {
      await Promise.race([hayLinea(s), abortar]);
      const linea = s.cola.shift();
      if (linea === undefined) throw errorClaude(s.stderr.join("").trim().slice(-500) || "el proceso terminó sin responder");
      const ev = parsear(linea);
      if (!ev) continue;
      if (ev.type === "stream_event") {
        const delta = ev.event?.delta;
        if (ev.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text) {
          acumulado += delta.text;
          const visible = textoVisible(acumulado);
          if (visible.length > emitido) {
            alDelta(visible.slice(emitido));
            emitido = visible.length;
          }
        } else if (ev.event?.type === "message_delta" && delta?.stop_reason === "max_tokens") {
          cortada = true;
        }
      } else if (ev.type === "rate_limit_event" && ev.rate_limit_info) {
        const { status, resetsAt } = ev.rate_limit_info;
        s.limiteHasta = status !== "allowed" && resetsAt ? resetsAt * 1000 : undefined;
      } else if (ev.type === "result") {
        if (ev.is_error) throw errorClaude(ev.result ?? ev.subtype ?? "", s.limiteHasta);
        if (ev.subtype !== "success") throw errorClaude(ev.subtype ?? "");
        const ventana = Math.max(0, ...Object.values(ev.modelUsage ?? {}).map((m) => m.contextWindow ?? 0));
        if (ventana) this.ventanaContexto = ventana;
        return { texto: ev.result ?? acumulado, uso: uso(ev.usage), cortada };
      }
    }
  }

  /** Pide al CLI que pare el turno en curso; true si lo hizo y el proceso sigue sirviendo. */
  private async interrumpir(s: SesionClaude): Promise<boolean> {
    if (s.terminada) return false;
    escribir(s, { type: "control_request", request_id: `parar-${s.llamadas}`, request: { subtype: "interrupt" } });
    const plazo = new Promise<"plazo">((ok) => setTimeout(() => ok("plazo"), ESPERA_INTERRUPCION_MS));
    for (;;) {
      if ((await Promise.race([hayLinea(s), plazo])) === "plazo") return false;
      const linea = s.cola.shift();
      if (linea === undefined) return false;
      if (parsear(linea)?.type === "result") return true;
    }
  }

  async cerrar(sesionId?: string): Promise<void> {
    const ids = sesionId ? [sesionId] : [...this.sesiones.keys()];
    for (const id of ids) {
      const s = this.sesiones.get(id);
      this.sesiones.delete(id);
      if (!s) continue;
      s.proceso.kill();
      await s.proceso.exited.catch(() => undefined);
      rmSync(s.rutaSistema, { force: true });
    }
  }

  private sesion(p: PeticionModelo): SesionClaude {
    const existente = this.sesiones.get(p.sesionId);
    if (existente && !existente.terminada && existente.proceso.exitCode === null) return existente;

    // El system prompt va en un fichero: con todas las herramientas pasa del límite de la línea de órdenes de Windows.
    const dir = join(tmpdir(), "aquiles-claude");
    mkdirSync(dir, { recursive: true });
    const rutaSistema = join(dir, `${p.sesionId.replace(/[^\w-]/g, "_")}.md`);
    writeFileSync(rutaSistema, `${p.sistema}\n\n${instrucciones(p.herramientas)}`);

    const args = [
      ...(this.opciones.comando ?? [Bun.which("claude") ?? "claude"]),
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools", "",
      "--safe-mode",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--system-prompt-file", rutaSistema,
      ...(this.opciones.modelo ? ["--model", this.opciones.modelo] : []),
      ...(this.opciones.esfuerzo ? ["--effort", this.opciones.esfuerzo] : []),
    ];
    const proceso = Bun.spawn(args, { cwd: p.cwd, env: entorno(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const s: SesionClaude = { proceso, cola: [], terminada: false, rutaSistema, enviados: 0, stderr: [], llamadas: 0 };
    void leer(s);
    void recoger(proceso.stderr, s.stderr);
    this.sesiones.set(p.sesionId, s);
    return s;
  }
}

/** Conversación previa en un solo mensaje, para un proceso que empieza sin ella. */
export function transcripcion(mensajes: readonly Mensaje[], vistas?: ReadonlyMap<string, VistaImagen>): string {
  const partes = mensajes.map((m) => {
    if (m.rol === "usuario") return `[Usuario]\n${textoUsuario(m, vistas)}`;
    if (m.rol !== "asistente") return renderizarMensaje(m);
    const llamadas = m.llamadas.map((l) => `<herramienta nombre="${l.nombre}">${JSON.stringify(l.argumentos)}</herramienta>`);
    return ["[Tú]", m.texto, ...llamadas].filter(Boolean).join("\n");
  });
  return [
    "La conversación sigue en un proceso nuevo. Esto es lo que había hasta ahora; continúa desde el final.",
    "",
    ...partes.flatMap((p) => [p, ""]),
  ].join("\n").trim();
}

function entorno(): Record<string, string> {
  const env: Record<string, string> = {};
  const anidado = Boolean(process.env.CLAUDECODE);
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (anidado && DE_SESION_ANFITRIONA.test(k) && !DEL_USUARIO.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function uso(u: UsoClaude | undefined): Uso {
  return {
    entrada: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0),
    salida: u?.output_tokens ?? 0,
    razonamiento: u?.output_tokens_details?.thinking_tokens ?? 0,
  };
}

export function errorClaude(texto: string, limiteHasta?: number): ErrorProveedor {
  const mensaje = `claude: ${texto || "error sin detalles"}`;
  if (/usage limit|rate limit|hit your limit|limit reached|\b429\b/i.test(texto)) {
    const espera = limiteHasta ? limiteHasta - Date.now() : undefined;
    return new ErrorProveedor("cuota", mensaje, espera && espera > 0 ? { reintentarEnMs: espera } : {});
  }
  if (/overloaded|\b529\b/i.test(texto)) return new ErrorProveedor("sobrecarga", mensaje);
  if (/prompt is too long|context (window|length)/i.test(texto)) return new ErrorProveedor("contexto", mensaje);
  if (/\/login|log in|api key|authenticat|unauthori[sz]ed|credential|\b401\b/i.test(texto)) return new ErrorProveedor("autenticacion", mensaje);
  if (/selected model|model .*(not exist|access)/i.test(texto)) return new ErrorProveedor("peticion", mensaje);
  if (/ECONN|ETIMEDOUT|network|fetch failed|socket/i.test(texto)) return new ErrorProveedor("red", mensaje);
  return new ErrorProveedor("otro", mensaje);
}

function escribir(s: SesionClaude, mensaje: unknown): void {
  s.proceso.stdin.write(`${JSON.stringify(mensaje)}\n`);
  void s.proceso.stdin.flush();
}

async function leer(s: SesionClaude): Promise<void> {
  try {
    for await (const l of lineas(s.proceso.stdout)) {
      s.cola.push(l);
      s.avisar?.();
    }
  } finally {
    s.terminada = true;
    s.avisar?.();
  }
}

/**
 * Espera a que haya una línea en la cola o a que el proceso termine. No saca la línea: la saca quien
 * gane la carrera con el aborto, para que una espera abandonada no se quede con ninguna.
 */
async function hayLinea(s: SesionClaude): Promise<void> {
  while (s.cola.length === 0 && !s.terminada) {
    await new Promise<void>((ok) => {
      s.avisar = ok;
    });
  }
}

function parsear(linea: string): EventoClaude | undefined {
  try {
    return JSON.parse(linea) as EventoClaude;
  } catch {
    return undefined;
  }
}

async function recoger(flujo: ReadableStream<Uint8Array>, destino: string[]): Promise<void> {
  const decodificador = new TextDecoder();
  for await (const trozo of flujo) {
    destino.push(decodificador.decode(trozo, { stream: true }));
    if (destino.length > 50) destino.splice(0, destino.length - 50);
  }
}
