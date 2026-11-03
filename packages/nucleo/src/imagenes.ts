/**
 * Generación de imágenes con los servicios que la tienen, por sus APIs oficiales y con la clave del usuario:
 * - Gemini (Google AI Studio, GEMINI_API_KEY): generateContent con un modelo de imagen («Nano Banana»).
 * - OpenAI (OPENAI_API_KEY): images/generations con gpt-image-1.
 * - OpenRouter (OPENROUTER_API_KEY): chat/completions con modalities imagen, con un modelo de imagen de Gemini.
 * - Y sin clave, con los CLI en los que se haya iniciado sesión: agy (Nano Banana) y Codex (imagenes-cli.ts).
 * Sin servicio elegido se usa el primero disponible, en ese orden.
 */
import { type CliImagen, clisDeImagen, ErrorImagenCli, generarConCli } from "./imagenes-cli";

export const SERVICIOS_IMAGEN = ["gemini", "openai", "openrouter", "agy", "codex"] as const;
export type ServicioImagen = (typeof SERVICIOS_IMAGEN)[number];
type ServicioApi = Exclude<ServicioImagen, CliImagen>;

const VARIABLE: Record<ServicioApi, string> = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const MODELO_POR_DEFECTO: Record<ServicioImagen, string> = {
  gemini: "gemini-2.5-flash-image",
  openai: "gpt-image-1",
  openrouter: "google/gemini-2.5-flash-image",
  agy: "Nano Banana (agy)",
  codex: "image_generation (Codex)",
};
const NOMBRE: Record<ServicioImagen, string> = { gemini: "Gemini", openai: "OpenAI", openrouter: "OpenRouter", agy: "Antigravity", codex: "Codex" };
const esCli = (s: ServicioImagen): s is CliImagen => s === "agy" || s === "codex";
const LIMITE_MS = 180_000;

export interface ImagenGenerada {
  bytes: Uint8Array;
  /** image/png, image/jpeg… */
  mime: string;
  servicio: ServicioImagen;
  modelo: string;
  /** Lo que el modelo dijo además de la imagen, si dijo algo. */
  texto?: string;
}

export interface OpcionesImagen {
  servicio?: ServicioImagen;
  modelo?: string;
  senal?: AbortSignal;
  /** Para los tests: otras URLs base y otro fetch, el entorno y los CLI instalados. */
  bases?: Partial<Record<ServicioApi, string>>;
  fetch?: typeof fetch;
  entorno?: Record<string, string | undefined>;
  clis?: CliImagen[];
  comandoCli?: string[];
  carpetasDeDatos?: string[];
}

/** Los servicios disponibles en orden de preferencia: los de API con clave puesta y los CLI instalados. */
export function serviciosDisponibles(entorno: Record<string, string | undefined> = process.env, clis: CliImagen[] = clisDeImagen()): ServicioImagen[] {
  return SERVICIOS_IMAGEN.filter((s) => (esCli(s) ? clis.includes(s) : Boolean(entorno[VARIABLE[s]])));
}

export class ErrorImagen extends Error {}

export async function generarImagen(prompt: string, o: OpcionesImagen = {}): Promise<ImagenGenerada> {
  const entorno = o.entorno ?? process.env;
  const servicio = o.servicio ?? serviciosDisponibles(entorno, o.clis)[0];
  if (!servicio) {
    throw new ErrorImagen(
      "No hay ningún servicio de imágenes: inicia sesión en agy (Antigravity) o en Codex, o pon una clave de Gemini (Google AI Studio), " +
        "OpenAI u OpenRouter en Ajustes → Modelos → Claves de API.",
    );
  }
  if (esCli(servicio)) {
    try {
      const r = await generarConCli(servicio, prompt, { senal: o.senal, comando: o.comandoCli, carpetasDeDatos: o.carpetasDeDatos });
      return { ...r, servicio, modelo: MODELO_POR_DEFECTO[servicio] };
    } catch (e) {
      if (e instanceof ErrorImagenCli) throw new ErrorImagen(e.message);
      throw e;
    }
  }
  const clave = entorno[VARIABLE[servicio]];
  if (!clave) throw new ErrorImagen(`Falta la clave de ${NOMBRE[servicio]} (Ajustes → Modelos → Claves de API).`);
  const modelo = o.modelo ?? MODELO_POR_DEFECTO[servicio];
  const pedir = async (url: string, cabeceras: Record<string, string>, cuerpo: unknown) => {
    const r = await (o.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...cabeceras },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.any([o.senal ?? new AbortController().signal, AbortSignal.timeout(LIMITE_MS)]),
    });
    const texto = await r.text();
    if (!r.ok) throw new ErrorImagen(`${NOMBRE[servicio]} respondió ${r.status}: ${mensajeDeError(texto)}`);
    try {
      return JSON.parse(texto) as any;
    } catch {
      throw new ErrorImagen(`${NOMBRE[servicio]} no devolvió JSON: ${texto.slice(0, 200)}`);
    }
  };

  if (servicio === "gemini") {
    const base = o.bases?.gemini ?? "https://generativelanguage.googleapis.com";
    const d = await pedir(`${base}/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, { "x-goog-api-key": clave }, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    });
    const partes: any[] = d?.candidates?.[0]?.content?.parts ?? [];
    const imagen = partes.find((p) => p?.inlineData?.data);
    const texto = partes.map((p) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
    if (!imagen) throw new ErrorImagen(`Gemini no devolvió ninguna imagen${texto ? `: ${texto.slice(0, 300)}` : motivoBloqueo(d)}`);
    return { bytes: Buffer.from(imagen.inlineData.data, "base64"), mime: imagen.inlineData.mimeType ?? "image/png", servicio, modelo, ...(texto ? { texto } : {}) };
  }

  if (servicio === "openai") {
    const base = o.bases?.openai ?? "https://api.openai.com";
    const d = await pedir(`${base}/v1/images/generations`, { authorization: `Bearer ${clave}` }, { model: modelo, prompt, n: 1, size: "1024x1024" });
    const b64 = d?.data?.[0]?.b64_json;
    if (typeof b64 !== "string") throw new ErrorImagen("OpenAI no devolvió ninguna imagen");
    return { bytes: Buffer.from(b64, "base64"), mime: "image/png", servicio, modelo };
  }

  const base = o.bases?.openrouter ?? "https://openrouter.ai/api";
  const d = await pedir(`${base}/v1/chat/completions`, { authorization: `Bearer ${clave}` }, {
    model: modelo,
    messages: [{ role: "user", content: prompt }],
    modalities: ["image", "text"],
  });
  const mensaje = d?.choices?.[0]?.message;
  const url: unknown = mensaje?.images?.[0]?.image_url?.url;
  const datos = typeof url === "string" ? /^data:([^;,]+);base64,(.+)$/s.exec(url) : null;
  const texto = typeof mensaje?.content === "string" ? mensaje.content.trim() : "";
  if (!datos) throw new ErrorImagen(`OpenRouter no devolvió ninguna imagen${texto ? `: ${texto.slice(0, 300)}` : ""} (¿el modelo genera imágenes?)`);
  return { bytes: Buffer.from(datos[2]!, "base64"), mime: datos[1]!, servicio, modelo, ...(texto ? { texto } : {}) };
}

/** Extensión para guardar la imagen según su tipo. */
export function extensionDe(mime: string): string {
  return { "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime] ?? "png";
}

function mensajeDeError(cuerpo: string): string {
  try {
    const d = JSON.parse(cuerpo);
    return String(d?.error?.message ?? d?.message ?? cuerpo).slice(0, 300);
  } catch {
    return cuerpo.slice(0, 300) || "sin detalles";
  }
}

function motivoBloqueo(d: any): string {
  const motivo = d?.promptFeedback?.blockReason ?? d?.candidates?.[0]?.finishReason;
  return motivo ? ` (motivo: ${motivo})` : "";
}
