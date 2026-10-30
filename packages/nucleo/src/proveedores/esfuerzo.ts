/**
 * Esfuerzo de razonamiento: qué niveles admite cada proveedor, leídos de donde los declara él mismo. Nada se supone:
 * - claude y agy: la ayuda de su CLI (`--effort … (low, medium, …)`), así sigue a la versión instalada;
 * - codex: su catálogo (`supported_reasoning_levels`, `default_reasoning_level`), quitando los niveles que su API no admite;
 * - anthropic: la API de modelos (`capabilities.effort`) de cada modelo.
 * Sin fuente (OpenAI-compatible, Ollama, LM Studio, llama.cpp), no hay niveles.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { EsfuerzoModelo, InfoProveedor } from "@aquiles/protocolo";

/**
 * Valores de `model_reasoning_effort` que acepta la API detrás de Codex, según su propio error ante un valor inválido
 * (comprobado el 2026-10-30). El catálogo ofrece además `ultra` («Maximum reasoning with automatic task delegation»):
 * es la delegación de Codex en sus propios agentes, que Aquiles apaga, y la API no lo acepta.
 */
export const NIVELES_API_CODEX = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

const ORDEN = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const ordenar = (niveles: string[]): string[] =>
  [...new Set(niveles)].sort((a, b) => (ORDEN.indexOf(a) + 1 || 99) - (ORDEN.indexOf(b) + 1 || 99));

/** Los niveles de `--effort` en la ayuda de un CLI: la primera lista entre paréntesis tras la opción. */
export function nivelesDeAyuda(ayuda: string): string[] {
  const i = ayuda.indexOf("--effort");
  if (i < 0) return [];
  const lista = /\(([a-z]+(?:\s*[|,]\s*[a-z]+)+)\)/.exec(ayuda.slice(i, i + 400))?.[1];
  return lista ? lista.split(/[|,]/).map((n) => n.trim()) : [];
}

const ayudas = new Map<string, Promise<EsfuerzoModelo | undefined>>();

/** Niveles de un CLI (`claude`, `agy`) leyendo su `--help`; en caché por ejecutable. */
export function esfuerzoDeCli(exe: string): Promise<EsfuerzoModelo | undefined> {
  let r = ayudas.get(exe);
  if (!r) {
    r = (async () => {
      const p = Bun.spawn([exe, "--help"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const limite = setTimeout(() => p.kill(), 15_000);
      const [salida, errores] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      clearTimeout(limite);
      const niveles = nivelesDeAyuda(`${salida}\n${errores}`);
      return niveles.length ? { niveles } : undefined;
    })().catch(() => undefined);
    ayudas.set(exe, r);
  }
  return r;
}

/** Del catálogo de Codex: niveles por modelo y su nivel por defecto. */
export function esfuerzoCodex(modelos: { slug: string; niveles?: string[]; porDefecto?: string }[]): InfoProveedor["esfuerzo"] {
  const porModelo: Record<string, EsfuerzoModelo> = {};
  for (const m of modelos) {
    const niveles = ordenar((m.niveles ?? []).filter((n) => NIVELES_API_CODEX.has(n)));
    if (!niveles.length) continue;
    porModelo[m.slug] = { niveles, ...(m.porDefecto && niveles.includes(m.porDefecto) ? { porDefecto: m.porDefecto } : {}) };
  }
  return Object.keys(porModelo).length ? { niveles: [], porModelo } : undefined;
}

let anthropicCache: { clave: string; hasta: number; valor: Promise<InfoProveedor["esfuerzo"]> } | undefined;

/** De la API de modelos de Anthropic: los niveles que cada modelo declara admitidos. Caché de una hora por clave. */
export function esfuerzoAnthropic(clave: string, o: { fetch?: typeof fetch } = {}): Promise<InfoProveedor["esfuerzo"]> {
  if (anthropicCache?.clave === clave && anthropicCache.hasta > Date.now()) return anthropicCache.valor;
  const valor = (async () => {
    const cliente = new Anthropic({ apiKey: clave, maxRetries: 1, timeout: 15_000, ...(o.fetch ? { fetch: o.fetch } : {}) });
    const porModelo: Record<string, EsfuerzoModelo> = {};
    for await (const m of cliente.models.list({ limit: 100 })) {
      const esfuerzo = m.capabilities?.effort;
      if (!esfuerzo?.supported) continue;
      const niveles = Object.entries(esfuerzo)
        .filter(([nivel, v]) => nivel !== "supported" && typeof v === "object" && v?.supported)
        .map(([nivel]) => nivel);
      if (niveles.length) porModelo[m.id] = { niveles: ordenar(niveles) };
    }
    return Object.keys(porModelo).length ? { niveles: [], porModelo } : undefined;
  })().catch(() => undefined);
  anthropicCache = { clave, hasta: Date.now() + 60 * 60_000, valor };
  return valor;
}

/** Los niveles que valen para un modelo concreto. */
export function nivelesPara(esfuerzo: InfoProveedor["esfuerzo"], modelo: string | undefined): EsfuerzoModelo | undefined {
  if (!esfuerzo) return undefined;
  const propio = modelo ? esfuerzo.porModelo?.[modelo] : undefined;
  if (propio) return propio;
  return esfuerzo.niveles.length ? { niveles: esfuerzo.niveles, ...(esfuerzo.porDefecto ? { porDefecto: esfuerzo.porDefecto } : {}) } : undefined;
}
