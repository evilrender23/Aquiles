/**
 * Proveedor para cualquier API compatible con chat.completions de OpenAI (OpenAI, OpenRouter,
 * Ollama, LM Studio…), con herramientas nativas tipo `function` y streaming.
 */
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { base64, imagenesAdjuntas, LIMITES_API, textoUsuario, verImagenes } from "../adjuntos";
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
import type { FetchPropio } from "./anthropic";
import { clasificarError, esAborto } from "./errores";

export type CampoMaxTokens = "max_tokens" | "max_completion_tokens";

export interface OpcionesOpenAICompatible {
  baseURL: string;
  /** Los servidores locales no la piden; se envía una de relleno. */
  clave?: string;
  modelo: string;
  /** Nombre del proveedor para mostrar y en los errores; por defecto "openai-compatible". */
  nombre?: string;
  ventanaContexto?: number;
  /** Límite de salida si la petición no trae `maxTokensSalida`; sin él, decide el servidor. */
  maxTokens?: number;
  /** La API de OpenAI usa `max_completion_tokens`; el resto, `max_tokens` (por defecto). */
  campoMaxTokens?: CampoMaxTokens;
  /** fetch alternativo (pruebas). */
  fetch?: FetchPropio;
}

export interface PresetOpenAI {
  baseURL: string;
  /** Variable de entorno con la clave, si el servicio la pide. */
  variableClave?: string;
  campoMaxTokens?: CampoMaxTokens;
}

export const presetsOpenAI = {
  ollama: { baseURL: "http://127.0.0.1:11434/v1" },
  lmstudio: { baseURL: "http://127.0.0.1:1234/v1" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", variableClave: "OPENROUTER_API_KEY" },
  openai: { baseURL: "https://api.openai.com/v1", variableClave: "OPENAI_API_KEY", campoMaxTokens: "max_completion_tokens" },
} as const satisfies Record<string, PresetOpenAI>;

export type NombrePresetOpenAI = keyof typeof presetsOpenAI;

/** Crea el proveedor de un preset; la clave sale de su variable de entorno si no se da. */
export function proveedorDePreset(
  preset: NombrePresetOpenAI,
  opciones: Omit<OpcionesOpenAICompatible, "baseURL"> & { baseURL?: string },
): ProveedorOpenAICompatible {
  const p: PresetOpenAI = presetsOpenAI[preset];
  const clave = opciones.clave ?? (p.variableClave ? process.env[p.variableClave] : undefined);
  return new ProveedorOpenAICompatible({
    nombre: preset,
    ...(p.campoMaxTokens ? { campoMaxTokens: p.campoMaxTokens } : {}),
    ...opciones,
    baseURL: opciones.baseURL ?? p.baseURL,
    ...(clave ? { clave } : {}),
  });
}

export class ProveedorOpenAICompatible implements Proveedor {
  readonly nombre: string;
  readonly modelo: string;
  readonly ventanaContexto?: number;
  private cliente?: OpenAI;

  constructor(private opciones: OpcionesOpenAICompatible) {
    this.nombre = opciones.nombre ?? "openai-compatible";
    this.modelo = opciones.modelo;
    if (opciones.ventanaContexto) this.ventanaContexto = opciones.ventanaContexto;
  }

  async responder(p: PeticionModelo, alDelta: (texto: string) => void): Promise<RespuestaModelo> {
    if (p.senal.aborted) throw new ErrorAbortado();
    const max = p.maxTokensSalida ?? this.opciones.maxTokens;
    const peticion: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.modelo,
      stream: true,
      stream_options: { include_usage: true },
      messages: traducirMensajesOpenAI(p.sistema, p.mensajes),
      ...(p.herramientas.length ? { tools: traducirHerramientasOpenAI(p.herramientas) } : {}),
      ...(max === undefined
        ? {}
        : this.opciones.campoMaxTokens === "max_completion_tokens"
          ? { max_completion_tokens: max }
          : { max_tokens: max }),
    };
    try {
      const flujo = await this.conectar().chat.completions.create(peticion, { signal: p.senal });
      return await recoger(flujo, alDelta, p.senal, this.nombre);
    } catch (e) {
      if (p.senal.aborted || esAborto(e)) throw new ErrorAbortado();
      throw clasificarError(e, this.nombre);
    }
  }

  private conectar(): OpenAI {
    // Clave, organización y proyecto explícitos: que no se cuelen los de OPENAI_* hacia otro servidor.
    this.cliente ??= new OpenAI({
      baseURL: this.opciones.baseURL,
      apiKey: this.opciones.clave ?? "sin-clave",
      adminAPIKey: null,
      organization: null,
      project: null,
      maxRetries: 0,
      ...(this.opciones.fetch ? { fetch: this.opciones.fetch } : {}),
    });
    return this.cliente;
  }
}

export function traducirHerramientasOpenAI(herramientas: readonly EspecHerramienta[]): OpenAI.ChatCompletionTool[] {
  return herramientas.map((h) => ({
    type: "function",
    function: { name: h.nombre, description: h.descripcion, parameters: h.esquema },
  }));
}

/** Las imágenes recientes van como partes `image_url` con una data URL; el texto de los documentos, en el texto. */
export function traducirMensajesOpenAI(sistema: string, mensajes: readonly Mensaje[]): OpenAI.ChatCompletionMessageParam[] {
  const salida: OpenAI.ChatCompletionMessageParam[] = sistema ? [{ role: "system", content: sistema }] : [];
  const vistas = verImagenes(mensajes, LIMITES_API);
  // Algunas plantillas de chat locales exigen alternar user/assistant.
  const usuario = (texto: string, imagenes: OpenAI.ChatCompletionContentPartImage[] = []): void => {
    const ultimo = salida.at(-1);
    if (ultimo?.role !== "user") {
      salida.push({ role: "user", content: imagenes.length ? [...imagenes, { type: "text", text: texto }] : texto });
    } else if (!imagenes.length && typeof ultimo.content === "string") {
      ultimo.content += `\n\n${texto}`;
    } else {
      const previas = typeof ultimo.content === "string" ? [{ type: "text" as const, text: ultimo.content }] : ultimo.content;
      ultimo.content = [...previas, ...imagenes, { type: "text", text: texto }];
    }
  };
  for (const m of mensajes) {
    switch (m.rol) {
      case "usuario":
        usuario(
          textoUsuario(m, vistas),
          imagenesAdjuntas(m, vistas).map((a) => ({ type: "image_url", image_url: { url: `data:${a.tipo};base64,${base64(a)}` } })),
        );
        break;
      case "resumen":
        usuario(`[Resumen de la conversación anterior]\n${m.texto}`);
        break;
      case "herramienta":
        salida.push({ role: "tool", tool_call_id: m.id, content: m.error ? `Error: ${m.resultado}` : m.resultado });
        break;
      case "asistente":
        if (!m.texto && !m.llamadas.length) break;
        salida.push({
          role: "assistant",
          content: m.texto || null,
          ...(m.llamadas.length
            ? {
                tool_calls: m.llamadas.map((l) => ({
                  id: l.id,
                  type: "function" as const,
                  function: { name: l.nombre, arguments: JSON.stringify(l.argumentos ?? {}) },
                })),
              }
            : {}),
        });
        break;
    }
  }
  return salida;
}

interface LlamadaEnCurso {
  id: string;
  nombre: string;
  argumentos: string;
}

async function recoger(
  flujo: AsyncIterable<OpenAI.ChatCompletionChunk>,
  alDelta: (texto: string) => void,
  senal: AbortSignal,
  origen: string,
): Promise<RespuestaModelo> {
  let texto = "";
  const enCurso = new Map<number, LlamadaEnCurso>();
  let motivo: string | null = null;
  let uso: OpenAI.CompletionUsage | undefined;

  for await (const trozo of flujo) {
    if (senal.aborted) break;
    if (trozo.usage) uso = trozo.usage;
    for (const opcion of trozo.choices ?? []) {
      const d = opcion.delta;
      if (d?.content) {
        texto += d.content;
        alDelta(d.content);
      }
      for (const t of d?.tool_calls ?? []) {
        let indice = t.index ?? enCurso.size;
        let actual = enCurso.get(indice);
        // Hay servidores que mandan cada llamada completa reutilizando el índice.
        if (actual && t.id && actual.id && t.id !== actual.id) {
          indice = Math.max(...enCurso.keys()) + 1;
          actual = undefined;
        }
        if (!actual) {
          actual = { id: "", nombre: "", argumentos: "" };
          enCurso.set(indice, actual);
        }
        if (t.id) actual.id = t.id;
        if (t.function?.name && !actual.nombre) actual.nombre = t.function.name;
        if (t.function?.arguments) actual.argumentos += t.function.arguments;
      }
      if (opcion.finish_reason) motivo = opcion.finish_reason;
    }
  }
  if (senal.aborted) throw new ErrorAbortado();
  if (motivo === null) throw new ErrorProveedor("red", `${origen}: la respuesta se cortó antes de terminar`);

  const llamadas: LlamadaHerramienta[] = [...enCurso.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, l]) => ({ id: l.id || `llamada-${randomUUID().slice(0, 8)}`, nombre: l.nombre, argumentos: parsearArgumentos(l.argumentos) }));
  return {
    texto,
    llamadas,
    ...(uso ? { uso: { entrada: uso.prompt_tokens, salida: uso.completion_tokens } } : {}),
    ...(motivo === "length" ? { cortada: true } : {}),
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
