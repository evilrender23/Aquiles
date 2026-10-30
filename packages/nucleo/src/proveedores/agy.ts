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
import { ErrorAbortado, type PeticionModelo, type Proveedor, type RespuestaModelo } from "../tipos";
import { extraerLlamadas, instrucciones, renderizarMensaje, textoVisible } from "./protocolo-texto";

const HERRAMIENTAS_AGY_DENEGADAS = [
  "view_file", "list_dir", "grep_search", "find_by_name", "run_command", "send_command_input",
  "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit",
  "read_url_content", "search_web", "open_browser_url", "browser_subagent", "invoke_subagent",
  "define_subagent", "generate_image", "schedule", "run_workflow",
];

interface EventoAgy {
  event?: string;
  conversation_id?: string;
  step_update?: { step_type?: string; state?: string; text_delta?: string; usage?: UsoAgy };
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
}

export class ProveedorAgy implements Proveedor {
  readonly nombre = "agy";
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
    const partes = s.enviados === 0 ? [`${p.sistema}\n\n${instrucciones(p.herramientas)}\n\n---`] : [];
    partes.push(...nuevos.map(renderizarMensaje));
    s.enviados = p.mensajes.length;
    this.enviadosPrevios.set(p.sesionId, s.enviados);
    s.llamadas += 1;

    const linea = JSON.stringify({ event: "user", message: { role: "user", content: partes.join("\n\n") } });
    s.proceso.stdin.write(`${linea}\n`);
    await s.proceso.stdin.flush();

    let acumulado = "";
    let emitido = 0;
    const gastado: Uso = { entrada: 0, salida: 0, razonamiento: 0 };
    const abortar = new Promise<never>((_, rechazar) => {
      p.senal.addEventListener("abort", () => rechazar(new ErrorAbortado()), { once: true });
    });
    try {
      for (;;) {
        const sig = await Promise.race([s.lineas.next(), abortar]);
        if (sig.done) {
          throw new Error(`agy terminó sin respuesta: ${s.stderr.join("").slice(-500) || "sin detalles"}`);
        }
        const ev = parsear(sig.value);
        if (!ev) continue;
        if (ev.conversation_id) {
          s.conversacion = ev.conversation_id;
          this.conversaciones.set(p.sesionId, ev.conversation_id);
        }
        const pasoUso = ev.step_update?.usage;
        if (pasoUso) {
          gastado.entrada += pasoUso.input_tokens ?? 0;
          gastado.salida += pasoUso.output_tokens ?? 0;
          gastado.razonamiento = (gastado.razonamiento ?? 0) + (pasoUso.thinking_tokens ?? 0);
        }
        const delta = ev.step_update?.step_type === "agent_response" ? ev.step_update.text_delta : undefined;
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
          const final = extraerLlamadas(ev.result.response ?? acumulado, `agy${s.llamadas}`);
          return { ...final, uso: gastado };
        }
      }
    } catch (e) {
      // Proceso en estado desconocido: se descarta y la próxima llamada reanuda la conversación.
      await this.cerrar(p.sesionId);
      throw e;
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
