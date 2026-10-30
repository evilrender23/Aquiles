/**
 * Proveedor sobre el CLI oficial de Google Antigravity (`agy`), en modo no interactivo.
 *
 * Mantiene un proceso `agy` por sesión con `--input-format stream-json`: cada mensaje
 * NDJSON `{"event":"user","message":{...}}` en stdin es un turno, y la salida emite
 * `step_update` (con `text_delta`) hasta un `result`. agy conserva la conversación,
 * así que en cada llamada solo se envían los mensajes nuevos.
 *
 * agy es un agente con herramientas propias; aquí se le piden las de Aquiles con el
 * protocolo en texto (protocolo-texto.ts) y se le deniegan las suyas por ajustes.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Uso } from "@aquiles/protocolo";
import { ErrorAbortado, type LlamadaHerramienta, type PeticionModelo, type Proveedor, type RespuestaModelo } from "../tipos";
import { extraerLlamadas, instrucciones, renderizarMensaje, textoVisible } from "./protocolo-texto";

const HERRAMIENTAS_AGY_DENEGADAS = [
  "view_file", "list_dir", "grep_search", "find_by_name", "run_command", "send_command_input",
  "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit",
  "read_url_content", "search_web", "open_browser_url", "browser_subagent", "invoke_subagent",
  "define_subagent", "generate_image", "schedule", "run_workflow",
];

/** Va antes de todo en el primer mensaje: con muchas herramientas, el modelo tiende a usar las suyas. */
const PREFACIO = [
  "IMPORTANTE: en esta conversación eres el modelo de Aquiles. Tus herramientas propias están desactivadas:",
  "cualquier intento se deniega y no hace nada. Para actuar usa SIEMPRE las herramientas de Aquiles con el formato",
  '<herramienta nombre="…">{…}</herramienta> que se explica abajo. Equivalencias: run_command → terminal;',
  "view_file → leer; write_to_file → escribir; replace_file_content y multi_replace_file_content → editar;",
  "grep_search → buscar_texto; list_dir y find_by_name → buscar_ficheros.",
].join("\n");

interface Nativa {
  nombre: string;
  parametros: Record<string, unknown>;
}

const texto = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const entero = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const sinIndefinidos = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Traduce una herramienta nativa de agy a llamadas de Aquiles; undefined si no hay equivalente seguro. */
export function traducirNativa(n: Nativa, id: string): LlamadaHerramienta[] | undefined {
  const p = n.parametros;
  const una = (nombre: string, argumentos: Record<string, unknown>) => [{ id, nombre, argumentos: sinIndefinidos(argumentos) }];
  switch (n.nombre) {
    case "run_command": {
      const comando = texto(p.CommandLine);
      if (!comando) return undefined;
      const cwd = texto(p.Cwd);
      return una("terminal", { comando: cwd ? `cd "${cwd}" && ${comando}` : comando });
    }
    case "view_file": {
      const ruta = texto(p.AbsolutePath);
      if (!ruta) return undefined;
      const desde = entero(p.StartLine);
      const hasta = entero(p.EndLine);
      return una("leer", { ruta, desde, lineas: desde && hasta && hasta >= desde ? hasta - desde + 1 : undefined });
    }
    case "write_to_file":
      return texto(p.TargetFile) && typeof p.CodeContent === "string" ? una("escribir", { ruta: p.TargetFile, contenido: p.CodeContent }) : undefined;
    case "replace_file_content":
      return texto(p.TargetFile) && texto(p.TargetContent) && typeof p.ReplacementContent === "string"
        ? una("editar", { ruta: p.TargetFile, buscar: p.TargetContent, reemplazar: p.ReplacementContent, todas: p.AllowMultiple === true || undefined })
        : undefined;
    case "multi_replace_file_content": {
      const trozos = Array.isArray(p.ReplacementChunks) ? (p.ReplacementChunks as Record<string, unknown>[]) : [];
      if (!texto(p.TargetFile) || trozos.length === 0 || trozos.some((t) => !texto(t.TargetContent) || typeof t.ReplacementContent !== "string")) return undefined;
      return trozos.map((t, i) => ({
        id: `${id}.${i + 1}`,
        nombre: "editar",
        argumentos: sinIndefinidos({ ruta: p.TargetFile, buscar: t.TargetContent, reemplazar: t.ReplacementContent, todas: t.AllowMultiple === true || undefined }),
      }));
    }
    case "grep_search": {
      const consulta = texto(p.Query);
      if (!consulta) return undefined;
      const includes = Array.isArray(p.Includes) ? texto(p.Includes[0]) : texto(p.Includes);
      return una("buscar_texto", {
        patron: p.IsRegex === true ? consulta : consulta.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ruta: texto(p.SearchPath),
        glob: includes,
        ignorar_mayusculas: p.CaseInsensitive === true || undefined,
      });
    }
    case "list_dir":
      return texto(p.DirectoryPath) ? una("buscar_ficheros", { patron: "*", ruta: p.DirectoryPath }) : undefined;
    case "find_by_name":
      return texto(p.Pattern) ? una("buscar_ficheros", { patron: p.Pattern, ruta: texto(p.SearchDirectory) }) : undefined;
    default:
      return undefined;
  }
}

interface EventoAgy {
  event?: string;
  conversation_id?: string;
  step_update?: {
    step_index?: number;
    step_type?: string;
    state?: string;
    text_delta?: string;
    usage?: UsoAgy;
    tool_info?: { name?: string; parameters?: Record<string, unknown> };
  };
  /** Ojo: el `usage` de `result` es acumulado de toda la conversación; el de cada paso no. */
  result?: { status?: string; response?: string; error?: string; usage?: UsoAgy };
}

interface UsoAgy {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
}

interface SesionAgy {
  proceso: Bun.Subprocess<"pipe", "pipe", "pipe">;
  lineas: AsyncIterator<string>;
  conversacion?: string;
  enviados: number;
  stderr: string[];
  llamadas: number;
}

export interface OpcionesAgy {
  /** Ruta del ejecutable; por defecto `agy` del PATH. */
  ejecutable?: string;
  /** Id de modelo de `agy models` (p. ej. `gemini-3.8-flash-high`). */
  modelo?: string;
  /** `--effort` del CLI (sus niveles salen de `agy --help`); si falta, el que elija agy. */
  esfuerzo?: string;
}

export class ProveedorAgy implements Proveedor {
  readonly nombre = "agy";
  readonly conversacionPropia = true;
  get modelo(): string | undefined {
    return this.opciones.modelo;
  }
  private sesiones = new Map<string, SesionAgy>();
  /** Conversación de agy de cada sesión, para reanudar si el proceso se reinicia. */
  private conversaciones = new Map<string, string>();
  private enviadosPrevios = new Map<string, number>();
  private rutaAjustes?: string;

  constructor(private opciones: OpcionesAgy = {}) {}

  async responder(p: PeticionModelo, alDelta: (texto: string) => void): Promise<RespuestaModelo> {
    if (p.senal.aborted) throw new ErrorAbortado();
    const s = await this.sesion(p);
    const nuevos = p.mensajes.slice(s.enviados).filter((m) => m.rol !== "asistente");
    const partes = s.enviados === 0 ? [`${PREFACIO}\n\n${p.sistema}\n\n${instrucciones(p.herramientas)}\n\n---`] : [];
    partes.push(...nuevos.map((m) => renderizarMensaje(m)));
    s.enviados = p.mensajes.length;
    this.enviadosPrevios.set(p.sesionId, s.enviados);
    s.llamadas += 1;

    const gastado: Uso = { entrada: 0, salida: 0, razonamiento: 0 };
    const abortar = new Promise<never>((_, rechazar) => {
      p.senal.addEventListener("abort", () => rechazar(new ErrorAbortado()), { once: true });
    });
    try {
      let mensaje = partes.join("\n\n");
      for (let correcciones = 0; ; correcciones++) {
        const r = await this.turnoAgy(s, p.sesionId, mensaje, gastado, alDelta, abortar);
        const final = extraerLlamadas(r.respuesta, `agy${s.llamadas}`);
        if (final.llamadas.length || r.nativas.length === 0) return { ...final, uso: gastado };
        // El modelo intentó sus herramientas nativas (agy las deniega): se traducen a las de Aquiles
        // para que pasen por nuestros permisos; si alguna no tiene equivalente, se le pide que repita.
        const traducidas = r.nativas.map((n, i) => traducirNativa(n, `agy${s.llamadas}-n${correcciones}-${i + 1}`));
        if (traducidas.every((t) => t !== undefined)) return { texto: final.texto, llamadas: traducidas.flat(), uso: gastado };
        if (correcciones >= 2) return { ...final, uso: gastado };
        const nombres = [...new Set(r.nativas.map((n) => n.nombre))].join(", ");
        mensaje = `${nombres} no existe en este entorno y no ha hecho nada. Repite la acción con las herramientas de Aquiles y el formato <herramienta nombre="…">{…}</herramienta>.`;
      }
    } catch (e) {
      // Proceso en estado desconocido: se descarta y la próxima llamada reanuda la conversación.
      await this.cerrar(p.sesionId);
      throw e;
    }
  }

  /** Envía un mensaje a agy y lee hasta su `result`. */
  private async turnoAgy(
    s: SesionAgy,
    sesionId: string,
    contenido: string,
    gastado: Uso,
    alDelta: (texto: string) => void,
    abortar: Promise<never>,
  ): Promise<{ respuesta: string; nativas: Nativa[] }> {
    s.proceso.stdin.write(`${JSON.stringify({ event: "user", message: { role: "user", content: contenido } })}\n`);
    await s.proceso.stdin.flush();
    let acumulado = "";
    let emitido = 0;
    const nativas = new Map<number, Nativa>();
    for (;;) {
      const sig = await Promise.race([s.lineas.next(), abortar]);
      if (sig.done) throw new Error(`agy terminó sin respuesta: ${s.stderr.join("").slice(-500) || "sin detalles"}`);
      const ev = parsear(sig.value);
      if (!ev) continue;
      if (ev.conversation_id) {
        s.conversacion = ev.conversation_id;
        this.conversaciones.set(sesionId, ev.conversation_id);
      }
      const paso = ev.step_update;
      if (paso?.usage) {
        gastado.entrada += paso.usage.input_tokens ?? 0;
        gastado.salida += paso.usage.output_tokens ?? 0;
        gastado.razonamiento = (gastado.razonamiento ?? 0) + (paso.usage.thinking_tokens ?? 0);
      }
      if (paso?.step_type === "tool" && paso.tool_info?.name && paso.step_index !== undefined && !nativas.has(paso.step_index)) {
        nativas.set(paso.step_index, { nombre: paso.tool_info.name, parametros: paso.tool_info.parameters ?? {} });
      }
      const delta = paso?.step_type === "agent_response" ? paso.text_delta : undefined;
      if (delta) {
        acumulado += delta;
        const visible = textoVisible(acumulado);
        if (visible.length > emitido) {
          alDelta(visible.slice(emitido));
          emitido = visible.length;
        }
      }
      if (ev.event === "result" && ev.result) {
        if (ev.result.status !== "SUCCESS") throw new Error(`agy: ${ev.result.error || ev.result.status}`);
        return { respuesta: ev.result.response || acumulado, nativas: [...nativas.values()] };
      }
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
    }
  }

  private async sesion(p: PeticionModelo): Promise<SesionAgy> {
    const existente = this.sesiones.get(p.sesionId);
    if (existente && existente.proceso.exitCode === null) return existente;

    const conversacion = this.conversaciones.get(p.sesionId);
    const args = [
      this.opciones.ejecutable ?? Bun.which("agy") ?? "agy",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--disable-slash-commands",
      "--settings", await this.ajustes(),
      ...(this.opciones.modelo ? ["--model", this.opciones.modelo] : []),
      ...(this.opciones.esfuerzo ? ["--effort", this.opciones.esfuerzo] : []),
      ...(conversacion ? ["--conversation", conversacion] : []),
      "-p=",
    ];
    const proceso = Bun.spawn(args, { cwd: p.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const s: SesionAgy = {
      proceso,
      lineas: lineas(proceso.stdout)[Symbol.asyncIterator](),
      conversacion,
      // Al reanudar, agy ya tiene lo enviado antes.
      enviados: conversacion ? (this.enviadosPrevios.get(p.sesionId) ?? 0) : 0,
      stderr: [],
      llamadas: 0,
    };
    void recoger(proceso.stderr, s.stderr);
    this.sesiones.set(p.sesionId, s);
    return s;
  }

  private async ajustes(): Promise<string> {
    if (!this.rutaAjustes) {
      this.rutaAjustes = join(tmpdir(), "aquiles-agy-ajustes.json");
      await Bun.write(this.rutaAjustes, JSON.stringify({ permissions: { deny: HERRAMIENTAS_AGY_DENEGADAS } }));
    }
    return this.rutaAjustes;
  }
}

function parsear(linea: string): EventoAgy | undefined {
  try {
    return JSON.parse(linea) as EventoAgy;
  } catch {
    return undefined;
  }
}

export async function* lineas(flujo: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decodificador = new TextDecoder();
  let resto = "";
  for await (const trozo of flujo) {
    resto += decodificador.decode(trozo, { stream: true });
    let i: number;
    while ((i = resto.indexOf("\n")) >= 0) {
      const linea = resto.slice(0, i).trim();
      resto = resto.slice(i + 1);
      if (linea) yield linea;
    }
  }
  if (resto.trim()) yield resto.trim();
}

async function recoger(flujo: ReadableStream<Uint8Array>, destino: string[]): Promise<void> {
  const decodificador = new TextDecoder();
  for await (const trozo of flujo) {
    destino.push(decodificador.decode(trozo, { stream: true }));
    if (destino.length > 50) destino.splice(0, destino.length - 50);
  }
}
