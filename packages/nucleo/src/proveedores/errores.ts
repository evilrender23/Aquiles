/**
 * Clasifica los errores de los SDK de Anthropic y OpenAI (y los de red sueltos) en `ErrorProveedor`,
 * que es lo que el bucle sabe reintentar, compactar o mostrar.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ErrorAbortado, ErrorProveedor, type TipoErrorProveedor } from "../tipos";

const CONTEXTO =
  /prompt is too long|input is too long|context.length|context window|maximum context|too many (?:input )?tokens|request.too.large|exceeds the (?:maximum|limit)|tokens? > \d+/i;
const SOBRECARGA = /overloaded/i;
const RED =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ConnectionRefused|ConnectionClosed|socket|network|fetch failed|unable to connect|connection (?:refused|reset|closed|error)|timed? ?out/i;

/** Tipos de error del cuerpo de la API (Anthropic `error.type`, OpenAI `type`/`code`). */
const POR_TIPO_API: Record<string, TipoErrorProveedor> = {
  overloaded_error: "sobrecarga",
  api_error: "sobrecarga",
  timeout_error: "sobrecarga",
  server_error: "sobrecarga",
  rate_limit_error: "cuota",
  rate_limit_exceeded: "cuota",
  insufficient_quota: "cuota",
  authentication_error: "autenticacion",
  permission_error: "autenticacion",
  invalid_api_key: "autenticacion",
  request_too_large: "contexto",
  context_length_exceeded: "contexto",
  invalid_request_error: "peticion",
  not_found_error: "peticion",
};

export function esAborto(e: unknown): boolean {
  return (
    e instanceof ErrorAbortado ||
    e instanceof Anthropic.APIUserAbortError ||
    e instanceof OpenAI.APIUserAbortError ||
    (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError")
  );
}

export function clasificarError(e: unknown, origen: string): ErrorProveedor {
  if (e instanceof ErrorProveedor) return e;
  if (e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError) {
    const causa = (e as { cause?: unknown }).cause;
    return new ErrorProveedor("red", `${origen}: ${e.message}${causa instanceof Error ? ` (${causa.message})` : ""}`, { causa: e });
  }
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) {
    const cuerpo = e.error as { message?: unknown; code?: unknown; type?: unknown; error?: { message?: unknown; type?: unknown } } | undefined;
    const texto = String(cuerpo?.error?.message ?? cuerpo?.message ?? e.message);
    // Los errores que llegan dentro del flujo no traen estado; OpenRouter lo pone en `code`.
    const estado = e.status ?? (typeof cuerpo?.code === "number" ? cuerpo.code : undefined);
    const tiposApi = [cuerpo?.error?.type, cuerpo?.type, cuerpo?.code, (e as { type?: unknown }).type].filter(
      (t): t is string => typeof t === "string",
    );
    const tipo =
      porEstado(estado, texto) ??
      tipoPorApi(tiposApi, texto) ??
      (SOBRECARGA.test(texto) ? "sobrecarga" : estado !== undefined && estado >= 400 ? "peticion" : "otro");
    const reintentarEnMs = esperaIndicada(e.headers);
    return new ErrorProveedor(tipo, `${origen}${estado ? ` ${estado}` : ""}: ${texto}`, {
      ...(estado ? { estado } : {}),
      ...(reintentarEnMs !== undefined && (tipo === "cuota" || tipo === "sobrecarga") ? { reintentarEnMs } : {}),
      causa: e,
    });
  }
  const descripcion = e instanceof Error ? `${e.name} ${(e as { code?: unknown }).code ?? ""} ${e.message}` : String(e);
  const mensaje = e instanceof Error ? e.message : String(e);
  if (RED.test(descripcion)) return new ErrorProveedor("red", `${origen}: ${mensaje}`, { causa: e });
  return new ErrorProveedor("otro", `${origen}: ${mensaje}`, { causa: e });
}

function porEstado(estado: number | undefined, texto: string): TipoErrorProveedor | undefined {
  if (estado === undefined) return undefined;
  if (estado === 401 || estado === 403) return "autenticacion";
  if (estado === 429) return "cuota";
  if (estado === 408) return "red";
  if (estado >= 500 || SOBRECARGA.test(texto)) return "sobrecarga";
  if ((estado === 400 || estado === 413) && CONTEXTO.test(texto)) return "contexto";
  // El resto de 4xx: primero el tipo del cuerpo (p. ej. `request_too_large`), luego `peticion`.
  return undefined;
}

function tipoPorApi(tipos: string[], texto: string): TipoErrorProveedor | undefined {
  for (const t of tipos) {
    const tipo = POR_TIPO_API[t];
    if (tipo === "peticion" && CONTEXTO.test(texto)) return "contexto";
    if (tipo) return tipo;
  }
  return undefined;
}

/** `retry-after-ms` o `retry-after` (segundos o fecha HTTP). */
function esperaIndicada(cabeceras: Headers | undefined): number | undefined {
  const ms = Number.parseFloat(cabeceras?.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const valor = cabeceras?.get("retry-after");
  if (!valor) return undefined;
  const segundos = Number.parseFloat(valor);
  if (Number.isFinite(segundos) && segundos >= 0) return segundos * 1000;
  const fecha = Date.parse(valor);
  return Number.isFinite(fecha) ? Math.max(0, fecha - Date.now()) : undefined;
}
