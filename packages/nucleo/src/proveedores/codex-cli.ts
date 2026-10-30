/**
 * Proveedor sobre el CLI de OpenAI Codex (`codex exec`), con la cuenta en la que se haya iniciado sesión en Codex.
 *
 * `codex exec` es de un solo turno: cada llamada lanza un proceso con la conversación entera en el prompt (stdin)
 * y lee los eventos JSONL (`--json`) hasta `turn.completed`. Es sin estado (`--ephemeral`: no deja sesiones en
 * el historial de Codex), así que el núcleo guarda y compacta la conversación como con un proveedor de API.
 *
 * Se arranca en solo lectura, sin aprobaciones y con sus herramientas propias apagadas, sin la configuración ni
 * las reglas del usuario; las herramientas de Aquiles se piden con el protocolo en texto (protocolo-texto.ts).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MAX_BYTES_ADJUNTO, type Uso } from "@aquiles/protocolo";
import { imagenesAdjuntas, type LimitesImagenes, textoUsuario, type VistaImagen, verImagenes } from "../adjuntos";
import { ErrorAbortado, ErrorProveedor, type Mensaje, type PeticionModelo, type Proveedor, type RespuestaModelo } from "../tipos";
import { lineas } from "./agy";
import { extraerLlamadas, instrucciones, renderizarMensaje, textoVisible } from "./protocolo-texto";

/** Lo que usa Codex por su cuenta y aquí sobra: Aquiles da las herramientas y pide los permisos. */
const APAGADAS = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "image_generation", "view_image", "in_app_browser"];

const PREFACIO = [
  "IMPORTANTE: en esta conversación eres el modelo de Aquiles, un agente personal. Tus herramientas propias están",
  "desactivadas y no hacen nada. Para actuar usa SIEMPRE las herramientas de Aquiles con el formato",
  '<herramienta nombre="…">{…}</herramienta> que se explica abajo; Aquiles las ejecuta y te devuelve <resultado>.',
].join("\n");

/** Las imágenes van por ruta (`-i`): sin el límite del base64, pero como mucho 5 y de los últimos mensajes. */
const LIMITES_IMAGENES: LimitesImagenes = { mensajes: 4, maxImagenes: 5, maxBytesImagen: MAX_BYTES_ADJUNTO, maxBytesTotal: Number.POSITIVE_INFINITY };

interface EventoCodex {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
  error?: { message?: string };
  message?: string;
}

export interface ModeloCodex {
  slug: string;
  nombre: string;
  ventana: number;
  /** `supported_reasoning_levels[].effort` y `default_reasoning_level` del catálogo. */
  niveles?: string[];
  porDefecto?: string;
}

export interface OpcionesCodex {
  /** Programa y argumentos iniciales; por defecto `codex` del PATH o el de la app de Codex. */
  comando?: string[];
  modelo?: string;
  /** `model_reasoning_effort`; si falta, el nivel por defecto del modelo en el catálogo de Codex. */
  esfuerzo?: string;
}

let ejecutableCache: Promise<string | undefined> | undefined;

/** `codex` del PATH, `AQUILES_CODEX`, o el que trae la app de Codex de la Microsoft Store (su carpeta lleva la versión). */
export function ejecutableCodex(): Promise<string | undefined> {
  ejecutableCache ??= (async () => {
    const env = process.env.AQUILES_CODEX?.trim();
    if (env && existsSync(env)) return env;
    const enPath = Bun.which("codex");
    if (enPath) return enPath;
    if (process.platform !== "win32") return undefined;
    const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name OpenAI.Codex).InstallLocation"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const carpeta = (await new Response(p.stdout).text()).trim().split(/\r?\n/)[0];
    const exe = carpeta ? join(carpeta, "app", "resources", "codex.exe") : "";
    return exe && existsSync(exe) ? exe : undefined;
  })();
  return ejecutableCache;
}

let catalogoCache: { modelos: ModeloCodex[]; hasta: number } | undefined;

/** Modelos visibles de `codex debug models`, por prioridad, con su ventana de contexto. Caché de 10 minutos. */
export async function modelosCodex(): Promise<ModeloCodex[]> {
  if (catalogoCache && catalogoCache.hasta > Date.now()) return catalogoCache.modelos;
  const exe = await ejecutableCodex();
  if (!exe) return [];
  const p = Bun.spawn([exe, "debug", "models"], { stdout: "pipe", stderr: "ignore" });
  const limite = setTimeout(() => p.kill(), 20_000);
  const salida = await new Response(p.stdout).text();
  clearTimeout(limite);
  catalogoCache = { modelos: leerCatalogo(salida), hasta: Date.now() + 10 * 60_000 };
  return catalogoCache.modelos;
}

export function leerCatalogo(json: string): ModeloCodex[] {
  try {
    const datos = JSON.parse(json) as unknown;
    const lista = (Array.isArray(datos) ? datos : ((datos as { models?: unknown[] })?.models ?? [])) as Record<string, unknown>[];
    return lista
      .filter((m) => m.visibility === "list" && typeof m.slug === "string")
      .sort((a, b) => Number(a.priority ?? 99) - Number(b.priority ?? 99))
      .map((m) => {
        const niveles = Array.isArray(m.supported_reasoning_levels)
          ? (m.supported_reasoning_levels as { effort?: unknown }[]).map((n) => n?.effort).filter((n): n is string => typeof n === "string")
          : [];
        return {
          slug: String(m.slug),
          nombre: String(m.display_name ?? m.slug),
          ventana: Number(m.context_window) || 0,
          ...(niveles.length ? { niveles } : {}),
          ...(typeof m.default_reasoning_level === "string" ? { porDefecto: m.default_reasoning_level } : {}),
        };
      });
  } catch {
    return [];
  }
}

/** La conversación entera como texto: el prompt de cada llamada. `vistas`: las imágenes que van con `-i`. */
export function promptCodex(p: Pick<PeticionModelo, "sistema" | "herramientas" | "mensajes">, vistas?: ReadonlyMap<string, VistaImagen>): string {
  const conversacion = p.mensajes.map((m: Mensaje) => {
    if (m.rol === "usuario") return `[Usuario]\n${textoUsuario(m, vistas)}`;
    if (m.rol !== "asistente") return renderizarMensaje(m);
    const llamadas = m.llamadas.map((l) => `<herramienta nombre="${l.nombre}">${JSON.stringify(l.argumentos)}</herramienta>`);
    return ["[Tú]", m.texto, ...llamadas].filter(Boolean).join("\n");
  });
  return [
    PREFACIO,
    "",
    "<instrucciones_de_aquiles>",
    p.sistema,
    "",
    instrucciones(p.herramientas),
    "</instrucciones_de_aquiles>",
    "",
    "<conversacion>",
    conversacion.join("\n\n"),
    "</conversacion>",
    "",
    "Responde ahora como Aquiles, continuando la conversación desde el final.",
  ].join("\n");
}

export function errorCodex(texto: string): ErrorProveedor {
  const mensaje = `codex: ${texto || "error sin detalles"}`;
  if (/usage limit|rate limit|too many requests|\b429\b|quota/i.test(texto)) return new ErrorProveedor("cuota", mensaje);
  if (/overloaded|\b5\d\d\b|server error|temporarily unavailable/i.test(texto)) return new ErrorProveedor("sobrecarga", mensaje);
  if (/context window|context length|too long|maximum context/i.test(texto)) return new ErrorProveedor("contexto", mensaje);
  if (/\b401\b|unauthori[sz]ed|log ?in|not logged|authentication|expired token/i.test(texto)) return new ErrorProveedor("autenticacion", mensaje);
  if (/model .*(not (found|supported|exist))|unknown model|invalid model/i.test(texto)) return new ErrorProveedor("peticion", mensaje);
  if (/ECONN|ETIMEDOUT|network|stream disconnected|connection|fetch failed/i.test(texto)) return new ErrorProveedor("red", mensaje);
  return new ErrorProveedor("otro", mensaje);
}

export class ProveedorCodex implements Proveedor {
  readonly nombre = "codex";
  /** La da el catálogo de Codex para el modelo elegido; hasta la primera llamada no se sabe. */
  ventanaContexto?: number;
  get modelo(): string | undefined {
    return this.opciones.modelo;
  }
  private llamadas = 0;

  constructor(private opciones: OpcionesCodex = {}) {}

  async responder(p: PeticionModelo, alDelta: (texto: string) => void): Promise<RespuestaModelo> {
    if (p.senal.aborted) throw new ErrorAbortado();
    const programa = this.opciones.comando ?? [(await ejecutableCodex()) ?? "codex"];
    if (!this.opciones.comando) void this.conocerVentana();
    const vistas = verImagenes(p.mensajes, LIMITES_IMAGENES);
    const imagenes = p.mensajes.flatMap((m) => imagenesAdjuntas(m, vistas)).map((a) => a.ruta);
    const args = [
      ...programa,
      "exec",
      // `-i` admite varias rutas seguidas: detrás tiene que ir otra opción, no el `-` del final.
      ...imagenes.flatMap((ruta) => ["-i", ruta]),
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "-s", "read-only",
      "-c", 'approval_policy="never"',
      "-c", 'web_search="disabled"',
      ...APAGADAS.flatMap((f) => ["--disable", f]),
      "-C", p.cwd,
      ...(this.opciones.modelo ? ["-m", this.opciones.modelo] : []),
      ...(this.opciones.esfuerzo ? ["-c", `model_reasoning_effort="${this.opciones.esfuerzo}"`] : []),
      "-",
    ];
    const proceso = Bun.spawn(args, { cwd: p.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const parar = () => proceso.kill();
    p.senal.addEventListener("abort", parar, { once: true });
    const stderr = new Response(proceso.stderr).text();
    proceso.stdin.write(promptCodex(p, vistas));
    await proceso.stdin.end();

    this.llamadas += 1;
    const textos: string[] = [];
    let emitido = 0;
    let uso: Uso = { entrada: 0, salida: 0 };
    let fallo: string | undefined;
    try {
      for await (const linea of lineas(proceso.stdout)) {
        let ev: EventoCodex;
        try {
          ev = JSON.parse(linea);
        } catch {
          continue;
        }
        if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
          textos.push(ev.item.text);
          // Los bloques de herramienta no se enseñan mientras llegan.
          const visible = textoVisible(textos.join("\n\n"));
          if (visible.length > emitido) {
            alDelta(visible.slice(emitido));
            emitido = visible.length;
          }
        } else if (ev.type === "turn.completed" && ev.usage) {
          uso = {
            entrada: ev.usage.input_tokens ?? 0,
            salida: ev.usage.output_tokens ?? 0,
            razonamiento: ev.usage.reasoning_output_tokens ?? 0,
          };
        } else if (ev.type === "turn.failed" || ev.type === "error") {
          fallo = ev.error?.message ?? ev.message ?? "falló sin detalles";
        }
      }
      const codigo = await proceso.exited;
      if (p.senal.aborted) throw new ErrorAbortado();
      if (fallo) throw errorCodex(fallo);
      if (codigo !== 0 && !textos.length) throw errorCodex((await stderr).trim().slice(-500) || `terminó con código ${codigo}`);
    } finally {
      p.senal.removeEventListener("abort", parar);
    }

    const texto = textos.join("\n\n");
    // Un resultado que el modelo escriba tras sus llamadas es inventado: se corta desde ahí.
    const llamada = texto.indexOf("</herramienta>");
    const corte = llamada >= 0 ? texto.indexOf("<resultado", llamada) : -1;
    const final = extraerLlamadas(corte >= 0 ? texto.slice(0, corte) : texto, `codex${this.llamadas}`);
    return { ...final, uso };
  }

  /** Ventana del modelo en uso según el catálogo de Codex (sin modelo, el de más prioridad). */
  private async conocerVentana(): Promise<void> {
    if (this.ventanaContexto) return;
    const modelos = await modelosCodex().catch(() => []);
    const m = this.opciones.modelo ? modelos.find((x) => x.slug === this.opciones.modelo) : modelos[0];
    if (m?.ventana) this.ventanaContexto = m.ventana;
  }
}
