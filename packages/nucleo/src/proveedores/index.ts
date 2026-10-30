import type { InfoProveedor } from "@aquiles/protocolo";
import type { Proveedor } from "../tipos";
import { ProveedorAgy } from "./agy";
import { ProveedorAnthropic } from "./anthropic";
import { MODELOS_CLAUDE, ProveedorClaude } from "./claude-cli";
import { ejecutableCodex, modelosCodex, ProveedorCodex } from "./codex-cli";
import { join } from "node:path";
import { directorioModelos, modelosLocales as modelosDescargados } from "../locales/huggingface";
import { ProveedorLlamaCpp, rutaLlamaServer, ServidorLlama } from "../locales/llamacpp";
import { esfuerzoAnthropic, esfuerzoCodex, esfuerzoDeCli, nivelesPara } from "./esfuerzo";
import { presetsOpenAI, proveedorDePreset, type NombrePresetOpenAI } from "./openai-compatible";
import { guionDemo, ProveedorSimulado } from "./simulado";

export interface OpcionesProveedor {
  modelo?: string;
  /** Nivel de esfuerzo de razonamiento; solo lo usan los proveedores que lo declaran (ver esfuerzo.ts). */
  esfuerzo?: string;
}

export const PROVEEDORES = [
  "agy", "claude", "codex", "anthropic", "llamacpp", ...(Object.keys(presetsOpenAI) as NombrePresetOpenAI[]), "simulado",
] as const;

let servidorLlama: ServidorLlama | undefined;

/** El llama-server de este proceso (uno a la vez, compartido por todas las sesiones que usan `llamacpp`). */
export function servidorLlamaCpp(): ServidorLlama {
  servidorLlama ??= new ServidorLlama({ ficheroPid: join(directorioModelos(), "llama-server.pid") });
  return servidorLlama;
}

const NOMBRES: Record<string, string> = {
  agy: "Antigravity (agy)",
  claude: "Claude Code (claude)",
  codex: "Codex (codex)",
  anthropic: "Anthropic",
  llamacpp: "Hugging Face (llama.cpp)",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  simulado: "Simulado",
};

/** Variable de entorno de la clave de cada proveedor que la necesita. */
export const VARIABLES_CLAVE: Record<string, string> = {
  anthropic: "AQUILES_CLAVE_ANTHROPIC",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** Secretos de otros servicios (canales, búsqueda), que también llegan del llavero con ajustes.clave. */
export const VARIABLES_SECRETOS: Record<string, string> = {
  ...VARIABLES_CLAVE,
  telegram: "AQUILES_TELEGRAM_TOKEN",
  discord: "AQUILES_DISCORD_TOKEN",
  slack: "AQUILES_SLACK_TOKEN",
  "slack-app": "AQUILES_SLACK_APP_TOKEN",
  correo: "AQUILES_CORREO_CLAVE",
  brave: "AQUILES_BRAVE_KEY",
  huggingface: "HF_TOKEN",
};

const MODELOS_ANTHROPIC = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];

/** Crea un proveedor por nombre (CLI, servidor y banco de tareas). */
export function crearProveedor(nombre: string, opciones: OpcionesProveedor = {}): Proveedor {
  const { modelo, esfuerzo } = opciones;
  if (nombre === "agy") return new ProveedorAgy({ modelo, esfuerzo });
  if (nombre === "claude") return new ProveedorClaude({ modelo, esfuerzo });
  if (nombre === "codex") return new ProveedorCodex({ modelo, esfuerzo });
  if (nombre === "anthropic") return new ProveedorAnthropic({ modelo, esfuerzo });
  if (nombre === "llamacpp") return new ProveedorLlamaCpp(modelo, { servidor: servidorLlamaCpp() });
  if (nombre === "simulado") return new ProveedorSimulado(guionDemo(), 15);
  if (nombre in presetsOpenAI) {
    if (!opciones.modelo) throw new Error(`Con ${nombre} hay que indicar el modelo`);
    return proveedorDePreset(nombre as NombrePresetOpenAI, { modelo: opciones.modelo });
  }
  throw new Error(`Proveedor desconocido: ${nombre} (disponibles: ${PROVEEDORES.join(", ")})`);
}

/** Pone la clave en el entorno de este proceso (no se guarda en disco). */
export function establecerClave(proveedor: string, clave: string): void {
  const variable = VARIABLES_SECRETOS[proveedor];
  if (!variable) throw new Error(`${proveedor} no usa clave`);
  if (clave) process.env[variable] = clave;
  else delete process.env[variable];
  if (proveedor === "anthropic") delete process.env.ANTHROPIC_API_KEY;
}

function hayClave(proveedor: string): boolean {
  if (proveedor === "anthropic") return Boolean(process.env.AQUILES_CLAVE_ANTHROPIC || process.env.ANTHROPIC_API_KEY);
  const variable = VARIABLES_CLAVE[proveedor];
  return variable ? Boolean(process.env[variable]) : true;
}

let cacheAgy: { modelos: string[]; hasta: number } | undefined;

async function modelosAgy(): Promise<string[]> {
  if (cacheAgy && cacheAgy.hasta > Date.now()) return cacheAgy.modelos;
  const p = Bun.spawn([Bun.which("agy") ?? "agy", "models"], { stdout: "pipe", stderr: "ignore" });
  const limite = setTimeout(() => p.kill(), 20_000);
  const salida = await new Response(p.stdout).text();
  clearTimeout(limite);
  const modelos = salida
    .split("\n")
    .map((l) => l.split("\t")[0]?.trim() ?? "")
    .filter((id) => /^[\w.-]+$/.test(id));
  cacheAgy = { modelos, hasta: Date.now() + 10 * 60_000 };
  return modelos;
}

async function modelosLocales(baseURL: string): Promise<string[] | undefined> {
  try {
    const r = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return undefined;
    const datos = (await r.json()) as { data?: { id?: string }[] };
    return (datos.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  } catch {
    return undefined;
  }
}

/** Niveles de esfuerzo que declara un proveedor (de su CLI, su catálogo o su API); undefined si no declara ninguno. */
export async function esfuerzoDeProveedor(id: string): Promise<InfoProveedor["esfuerzo"]> {
  if (id === "agy" || id === "claude") {
    const exe = Bun.which(id);
    return exe ? await esfuerzoDeCli(exe) : undefined;
  }
  if (id === "codex") return (await ejecutableCodex()) ? esfuerzoCodex(await modelosCodex().catch(() => [])) : undefined;
  if (id === "anthropic") {
    const clave = process.env.AQUILES_CLAVE_ANTHROPIC || process.env.ANTHROPIC_API_KEY;
    return clave ? await esfuerzoAnthropic(clave) : undefined;
  }
  return undefined;
}

/** El nivel si el modelo lo admite; si no (o si el proveedor no declara niveles), undefined. Sin modelo, vale el por defecto. */
export async function esfuerzoValido(proveedor: string, modelo: string | undefined, nivel: string | undefined): Promise<string | undefined> {
  if (!nivel) return undefined;
  // Codex sin -m usa el primero de su catálogo (el que se anuncia como modeloPorDefecto).
  const efectivo = modelo ?? (proveedor === "codex" ? (await modelosCodex().catch(() => []))[0]?.slug : undefined);
  const niveles = nivelesPara(await esfuerzoDeProveedor(proveedor).catch(() => undefined), efectivo);
  return niveles?.niveles.includes(nivel) ? nivel : undefined;
}

/** Proveedores conocidos con su disponibilidad actual y modelos. */
export async function listarProveedores(incluirSimulado = false): Promise<InfoProveedor[]> {
  const info = (id: string, extra: Omit<InfoProveedor, "id" | "nombre" | "necesitaClave">): InfoProveedor => ({
    id, nombre: NOMBRES[id] ?? id, necesitaClave: id in VARIABLES_CLAVE, ...extra,
  });
  const tareas: Promise<InfoProveedor>[] = [
    (async () => {
      if (!Bun.which("agy")) return info("agy", { disponible: false, motivo: "agy no está instalado", modelos: [] });
      const [modelos, esfuerzo] = await Promise.all([modelosAgy().catch(() => []), esfuerzoDeProveedor("agy")]);
      return info("agy", { disponible: true, modelos, ...(esfuerzo ? { esfuerzo } : {}) });
    })(),
    (async () => {
      if (!Bun.which("claude")) return info("claude", { disponible: false, motivo: "claude no está instalado", modelos: [] });
      const esfuerzo = await esfuerzoDeProveedor("claude");
      return info("claude", { disponible: true, modelos: MODELOS_CLAUDE, ...(esfuerzo ? { esfuerzo } : {}) });
    })(),
    (async () => {
      if (!(await ejecutableCodex())) return info("codex", { disponible: false, motivo: "Codex no está instalado", modelos: [] });
      const catalogo = await modelosCodex().catch(() => []);
      const modelos = catalogo.map((m) => m.slug);
      const esfuerzo = esfuerzoCodex(catalogo);
      return info("codex", { disponible: true, modelos, ...(modelos[0] ? { modeloPorDefecto: modelos[0] } : {}), ...(esfuerzo ? { esfuerzo } : {}) });
    })(),
    (async () => {
      const esfuerzo = await esfuerzoDeProveedor("anthropic");
      return info("anthropic", {
        disponible: hayClave("anthropic"), ...(hayClave("anthropic") ? {} : { motivo: "falta la clave" }),
        modelos: MODELOS_ANTHROPIC, modeloPorDefecto: MODELOS_ANTHROPIC[0], ...(esfuerzo ? { esfuerzo } : {}),
      });
    })(),
    (async () => {
      const modelos = (await modelosDescargados().catch(() => [])).map((m) => m.id);
      if (!rutaLlamaServer()) return info("llamacpp", { disponible: false, motivo: "llama.cpp no está instalado", modelos });
      if (!modelos.length) return info("llamacpp", { disponible: false, motivo: "no hay modelos descargados", modelos });
      return info("llamacpp", { disponible: true, modelos, modeloPorDefecto: modelos[0] });
    })(),
    ...(["ollama", "lmstudio"] as const).map(async (id) => {
      const modelos = await modelosLocales(presetsOpenAI[id].baseURL);
      if (!modelos) return info(id, { disponible: false, motivo: "no responde en local", modelos: [] });
      if (modelos.length === 0) return info(id, { disponible: false, motivo: "no tiene modelos descargados", modelos: [] });
      return info(id, { disponible: true, modelos, modeloPorDefecto: modelos[0] });
    }),
    ...(["openrouter", "openai"] as const).map(async (id) =>
      info(id, { disponible: hayClave(id), ...(hayClave(id) ? {} : { motivo: "falta la clave" }), modelos: [] }),
    ),
  ];
  if (incluirSimulado) tareas.push(Promise.resolve(info("simulado", { disponible: true, modelos: [] })));
  return Promise.all(tareas);
}
