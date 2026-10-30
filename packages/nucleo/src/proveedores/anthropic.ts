/**
 * Proveedor sobre la API de mensajes de Anthropic: herramientas nativas, streaming y caché de prompt.
 *
 * Los bloques de razonamiento firmados (thinking) viajan en `opaco` junto con el resto de bloques
 * en su orden original y se reenvían tal cual. La API solo los acepta si todo lo anterior a ellos
 * (sistema, herramientas y mensajes) no ha cambiado, así que `opaco` guarda una huella de ese
 * prefijo: si ya no coincide (p. ej. tras compactar), se reenvían sin razonamiento.
 */
import { createHash, type Hash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { base64, imagenesAdjuntas, LIMITES_API, textoUsuario, type VistaImagen, verImagenes } from "../adjuntos";
import {
  ErrorAbortado,
  ErrorProveedor,
  type EspecHerramienta,
  type LlamadaHerramienta,
  type Mensaje,
  type PeticionModelo,
  type Proveedor,
  type RespuestaModelo,
} from "../tipos";
import { clasificarError, esAborto } from "./errores";

export type FetchPropio = (entrada: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpcionesAnthropic {
  /** Por defecto, AQUILES_CLAVE_ANTHROPIC o ANTHROPIC_API_KEY. */
  clave?: string;
  modelo?: string;
  /** `output_config.effort` (los niveles de cada modelo salen de la API de modelos); si falta, el del modelo. */
  esfuerzo?: string;
  baseURL?: string;
  ventanaContexto?: number;
  /** Límite de salida si la petición no trae `maxTokensSalida`. */
  maxTokens?: number;
  /** fetch alternativo (pruebas). */
  fetch?: FetchPropio;
}

export const MODELO_ANTHROPIC = "claude-sonnet-5-5";
const MAX_TOKENS = 64_000;
const CACHE: Anthropic.CacheControlEphemeral = { type: "ephemeral" };
const SEPARADOR = "\n\n";

interface DatosOpacos {
  /** Huella de sistema + herramientas + mensajes anteriores a esta respuesta. */
  prefijo: string;
  bloques: Anthropic.ContentBlockParam[];
}

export class ProveedorAnthropic implements Proveedor {
  readonly nombre = "anthropic";
  readonly modelo: string;
  readonly ventanaContexto: number;
  private cliente?: Anthropic;

  constructor(private opciones: OpcionesAnthropic = {}) {
    this.modelo = opciones.modelo ?? MODELO_ANTHROPIC;
    this.ventanaContexto = opciones.ventanaContexto ?? ventanaDe(this.modelo);
  }

  async responder(p: PeticionModelo, alDelta: (texto: string) => void): Promise<RespuestaModelo> {
    if (p.senal.aborted) throw new ErrorAbortado();
    const vistas = verImagenes(p.mensajes, LIMITES_API);
    const huellas = huellasPrefijo(p, vistas);
    const peticion: Anthropic.MessageCreateParamsStreaming = {
      model: this.modelo,
      max_tokens: p.maxTokensSalida ?? this.opciones.maxTokens ?? MAX_TOKENS,
      stream: true,
      messages: traducirMensajesAnthropic(p.mensajes, huellas, vistas),
      ...(p.sistema ? { system: [{ type: "text", text: p.sistema, cache_control: CACHE }] } : {}),
      ...(p.herramientas.length ? { tools: traducirHerramientasAnthropic(p.herramientas) } : {}),
      ...(this.opciones.esfuerzo ? { output_config: { effort: this.opciones.esfuerzo as NonNullable<Anthropic.OutputConfig["effort"]> } } : {}),
    };
    try {
      const flujo = await this.conectar().messages.create(peticion, { signal: p.senal });
      const r = await recoger(flujo, alDelta, p.senal);
      if (r.bloques.some((b) => b.type === "thinking" || b.type === "redacted_thinking")) {
        const datos: DatosOpacos = { prefijo: huellas[p.mensajes.length] ?? "", bloques: r.bloques };
        return { ...r.respuesta, opaco: { proveedor: this.nombre, datos } };
      }
      return r.respuesta;
    } catch (e) {
      if (p.senal.aborted || esAborto(e)) throw new ErrorAbortado();
      throw clasificarError(e, this.nombre);
    }
  }

  private conectar(): Anthropic {
    if (this.cliente) return this.cliente;
    const clave = this.opciones.clave || process.env.AQUILES_CLAVE_ANTHROPIC || process.env.ANTHROPIC_API_KEY;
    if (!clave) {
      throw new ErrorProveedor("autenticacion", "anthropic: falta la clave (AQUILES_CLAVE_ANTHROPIC o ANTHROPIC_API_KEY)");
    }
    // Los reintentos los hace el bucle, con `reintentarEnMs`.
    this.cliente = new Anthropic({
      apiKey: clave,
      authToken: null,
      maxRetries: 0,
      ...(this.opciones.baseURL ? { baseURL: this.opciones.baseURL } : {}),
      ...(this.opciones.fetch ? { fetch: this.opciones.fetch } : {}),
    });
    return this.cliente;
  }
}

export function traducirHerramientasAnthropic(herramientas: readonly EspecHerramienta[]): Anthropic.Tool[] {
  return herramientas.map((h, i) => ({
    name: h.nombre,
    description: h.descripcion,
    input_schema: { type: "object", ...h.esquema },
    ...(i === herramientas.length - 1 ? { cache_control: CACHE } : {}),
  }));
}

/**
 * `huellas[i]` resume sistema + herramientas + `mensajes[0..i)`: la respuesta que se añada en la
 * posición i guarda esa huella, y al reenviarla se compara con la del historial de entonces.
 * Una imagen que deja de reenviarse cambia lo enviado, así que su vista también cuenta.
 */
function huellasPrefijo(p: PeticionModelo, vistas: ReadonlyMap<string, VistaImagen>): string[] {
  const h: Hash = createHash("sha256").update(JSON.stringify([p.sistema, p.herramientas]));
  const huellas: string[] = [];
  for (const m of p.mensajes) {
    huellas.push(h.copy().digest("base64url"));
    const imagenes = m.rol === "usuario" ? (m.adjuntos ?? []).filter((a) => a.clase === "imagen").map((a) => vistas.get(a.id)) : [];
    h.update(JSON.stringify(m.rol === "asistente" ? [m.rol, m.texto, m.llamadas] : imagenes.length ? [m, imagenes] : m));
  }
  huellas.push(h.digest("base64url"));
  return huellas;
}

/** Las imágenes recientes van como bloques `image` en base64, delante del texto; el texto de los documentos, en el texto. */
export function traducirMensajesAnthropic(
  mensajes: readonly Mensaje[],
  huellas: readonly string[] = [],
  vistas: ReadonlyMap<string, VistaImagen> = verImagenes(mensajes, LIMITES_API),
): Anthropic.MessageParam[] {
  const salida: Anthropic.MessageParam[] = [];
  // Quitar razonamiento de un turno obliga a quitarlo de todos los siguientes.
  let razonamientoValido = true;
  const usuario = (bloque: Anthropic.TextBlockParam | Anthropic.ToolResultBlockParam | Anthropic.ImageBlockParam): void => {
    const ultimo = salida.at(-1);
    if (ultimo?.role === "user" && Array.isArray(ultimo.content)) ultimo.content.push(bloque);
    else salida.push({ role: "user", content: [bloque] });
  };

  mensajes.forEach((m, i) => {
    switch (m.rol) {
      case "usuario": {
        for (const a of imagenesAdjuntas(m, vistas)) {
          usuario({ type: "image", source: { type: "base64", media_type: a.tipo as Anthropic.Base64ImageSource["media_type"], data: base64(a) } });
        }
        const texto = textoUsuario(m, vistas);
        if (texto.trim()) usuario({ type: "text", text: texto });
        break;
      }
      case "resumen":
        usuario({ type: "text", text: `[Resumen de la conversación anterior]\n${m.texto}` });
        break;
      case "herramienta":
        usuario({
          type: "tool_result",
          tool_use_id: idValido(m.id),
          ...(m.resultado ? { content: m.resultado } : {}),
          ...(m.error ? { is_error: true } : {}),
        });
        break;
      case "asistente": {
        const guardados = bloquesGuardados(m);
        let bloques: Anthropic.ContentBlockParam[];
        if (!guardados) {
          bloques = [
            ...(m.texto.trim() ? [{ type: "text" as const, text: m.texto }] : []),
            ...m.llamadas.map((l) => bloqueLlamada(l)),
          ];
        } else {
          const conRazonamiento = guardados.bloques.some((b) => b.type === "thinking" || b.type === "redacted_thinking");
          if (conRazonamiento && guardados.prefijo !== huellas[i]) razonamientoValido = false;
          bloques = razonamientoValido
            ? guardados.bloques
            : guardados.bloques.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
        }
        if (bloques.length) salida.push({ role: "assistant", content: bloques });
        break;
      }
    }
  });

  // Tercer punto de caché (tras sistema y herramientas): el final de la conversación.
  const ultimo = salida.at(-1);
  if (ultimo?.role === "user" && Array.isArray(ultimo.content)) {
    const bloque = ultimo.content.at(-1);
    if (bloque?.type === "text" || bloque?.type === "tool_result") bloque.cache_control = CACHE;
  }
  return salida;
}

/** Bloques guardados en `opaco`, si siguen describiendo exactamente el mismo mensaje. */
function bloquesGuardados(m: Mensaje & { rol: "asistente" }): DatosOpacos | undefined {
  if (m.opaco?.proveedor !== "anthropic") return undefined;
  const datos = m.opaco.datos as Partial<DatosOpacos> | undefined;
  if (typeof datos?.prefijo !== "string" || !Array.isArray(datos.bloques)) return undefined;
  const textos: string[] = [];
  const ids: string[] = [];
  for (const b of datos.bloques) {
    if (b.type === "text") textos.push(b.text);
    else if (b.type === "tool_use") ids.push(b.id);
    else if (b.type !== "thinking" && b.type !== "redacted_thinking") return undefined;
  }
  const coincide =
    textos.join(SEPARADOR) === m.texto &&
    ids.length === m.llamadas.length &&
    ids.every((id, i) => id === m.llamadas[i]?.id);
  return coincide ? { prefijo: datos.prefijo, bloques: datos.bloques } : undefined;
}

function bloqueLlamada(l: LlamadaHerramienta): Anthropic.ToolUseBlockParam {
  const objeto = typeof l.argumentos === "object" && l.argumentos !== null && !Array.isArray(l.argumentos);
  return { type: "tool_use", id: idValido(l.id), name: l.nombre, input: objeto ? l.argumentos : { argumentos: l.argumentos } };
}

/** La API exige ids `[a-zA-Z0-9_-]+`; los de otros proveedores pueden no cumplirlo. */
function idValido(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
}

async function recoger(
  flujo: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  alDelta: (texto: string) => void,
  senal: AbortSignal,
): Promise<{ respuesta: RespuestaModelo; bloques: Anthropic.ContentBlockParam[] }> {
  const bloques: Anthropic.ContentBlockParam[] = [];
  const json = new Map<number, string>();
  let entrada = 0;
  let cacheEscrita = 0;
  let cacheLeida = 0;
  let salida = 0;
  let motivo: Anthropic.StopReason | null = null;
  let terminado = false;
  let hayTexto = false;

  const anadirTexto = (b: Anthropic.TextBlockParam, texto: string): void => {
    if (!texto) return;
    if (!b.text && hayTexto) alDelta(SEPARADOR);
    b.text += texto;
    hayTexto = true;
    alDelta(texto);
  };

  for await (const ev of flujo) {
    if (senal.aborted) break;
    switch (ev.type) {
      case "message_start": {
        const u = ev.message.usage;
        entrada = u.input_tokens;
        cacheEscrita = u.cache_creation_input_tokens ?? 0;
        cacheLeida = u.cache_read_input_tokens ?? 0;
        salida = u.output_tokens;
        break;
      }
      case "content_block_start": {
        const b = ev.content_block;
        if (b.type === "text") {
          const bloque: Anthropic.TextBlockParam = { type: "text", text: "" };
          bloques[ev.index] = bloque;
          anadirTexto(bloque, b.text);
        } else if (b.type === "tool_use") {
          bloques[ev.index] = { type: "tool_use", id: b.id, name: b.name, input: {} };
          json.set(ev.index, "");
        } else if (b.type === "thinking") {
          bloques[ev.index] = { type: "thinking", thinking: b.thinking, signature: b.signature };
        } else if (b.type === "redacted_thinking") {
          bloques[ev.index] = { type: "redacted_thinking", data: b.data };
        }
        break;
      }
      case "content_block_delta": {
        const b = bloques[ev.index];
        const d = ev.delta;
        if (d.type === "text_delta" && b?.type === "text") anadirTexto(b, d.text);
        else if (d.type === "input_json_delta" && json.has(ev.index)) json.set(ev.index, (json.get(ev.index) ?? "") + d.partial_json);
        else if (d.type === "thinking_delta" && b?.type === "thinking") b.thinking += d.thinking;
        else if (d.type === "signature_delta" && b?.type === "thinking") b.signature = d.signature;
        break;
      }
      case "message_delta": {
        motivo = ev.delta.stop_reason ?? motivo;
        const u = ev.usage;
        entrada = u.input_tokens ?? entrada;
        cacheEscrita = u.cache_creation_input_tokens ?? cacheEscrita;
        cacheLeida = u.cache_read_input_tokens ?? cacheLeida;
        salida = u.output_tokens;
        break;
      }
      case "message_stop":
        terminado = true;
        break;
    }
  }
  if (senal.aborted) throw new ErrorAbortado();
  if (!terminado) throw new ErrorProveedor("red", "anthropic: la respuesta se cortó antes de terminar");

  const validos = bloques.filter((b): b is Anthropic.ContentBlockParam => b !== undefined && !(b.type === "text" && !b.text));
  const llamadas: LlamadaHerramienta[] = [];
  for (const [indice, bruto] of json) {
    const b = bloques[indice];
    if (b?.type !== "tool_use") continue;
    b.input = parsearArgumentos(bruto);
    llamadas.push({ id: b.id, nombre: b.name, argumentos: b.input });
  }
  const texto = validos.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(SEPARADOR);
  return {
    respuesta: {
      texto,
      llamadas,
      uso: { entrada: entrada + cacheEscrita + cacheLeida, salida },
      ...(motivo === "max_tokens" || motivo === "model_context_window_exceeded" ? { cortada: true } : {}),
    },
    bloques: validos,
  };
}

function parsearArgumentos(bruto: string): unknown {
  if (!bruto.trim()) return {};
  try {
    return JSON.parse(bruto);
  } catch {
    return { __json_invalido: bruto };
  }
}

/** Ventana de contexto por modelo: los Claude 5 tienen 1M; los anteriores, 200k. */
export function ventanaDe(modelo: string): number {
  return /^claude-(?:sonnet|opus|haiku|fable)-5-\d/.test(modelo) ? 1_000_000 : 200_000;
}
