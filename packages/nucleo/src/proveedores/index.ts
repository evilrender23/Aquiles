import type { InfoProveedor } from "@aquiles/protocolo";
import type { Proveedor } from "../tipos";
import { ProveedorAgy } from "./agy";
import { ProveedorAnthropic } from "./anthropic";
import { MODELOS_CLAUDE, ProveedorClaude } from "./claude-cli";
import { presetsOpenAI, proveedorDePreset, type NombrePresetOpenAI } from "./openai-compatible";
import { guionDemo, ProveedorSimulado } from "./simulado";

export interface OpcionesProveedor {
  modelo?: string;
}

export const PROVEEDORES = ["agy", "claude", "anthropic", ...(Object.keys(presetsOpenAI) as NombrePresetOpenAI[]), "simulado"] as const;

const NOMBRES: Record<string, string> = {
  agy: "Antigravity (agy)",
  claude: "Claude Code (claude)",
  anthropic: "Anthropic",
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

const MODELOS_ANTHROPIC = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"];

/** Crea un proveedor por nombre (CLI, servidor y banco de tareas). */
export function crearProveedor(nombre: string, opciones: OpcionesProveedor = {}): Proveedor {
  if (nombre === "agy") return new ProveedorAgy({ modelo: opciones.modelo });
  if (nombre === "claude") return new ProveedorClaude({ modelo: opciones.modelo });
  if (nombre === "anthropic") return new ProveedorAnthropic({ modelo: opciones.modelo });
  if (nombre === "simulado") return new ProveedorSimulado(guionDemo(), 15);
  if (nombre in presetsOpenAI) {
    if (!opciones.modelo) throw new Error(`Con ${nombre} hay que indicar el modelo`);
    return proveedorDePreset(nombre as NombrePresetOpenAI, { modelo: opciones.modelo });
  }
  throw new Error(`Proveedor desconocido: ${nombre} (disponibles: ${PROVEEDORES.join(", ")})`);
}

/** Pone la clave en el entorno de este proceso (no se guarda en disco). */
export function establecerClave(proveedor: string, clave: string): void {
  const variable = VARIABLES_CLAVE[proveedor];
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

/** Proveedores conocidos con su disponibilidad actual y modelos. */
export async function listarProveedores(incluirSimulado = false): Promise<InfoProveedor[]> {
  const info = (id: string, extra: Omit<InfoProveedor, "id" | "nombre" | "necesitaClave">): InfoProveedor => ({
    id, nombre: NOMBRES[id] ?? id, necesitaClave: id in VARIABLES_CLAVE, ...extra,
  });
  const tareas: Promise<InfoProveedor>[] = [
    (async () => {
      if (!Bun.which("agy")) return info("agy", { disponible: false, motivo: "agy no está instalado", modelos: [] });
      const modelos = await modelosAgy().catch(() => []);
      return info("agy", { disponible: true, modelos });
    })(),
    Promise.resolve(
      Bun.which("claude")
        ? info("claude", { disponible: true, modelos: MODELOS_CLAUDE })
        : info("claude", { disponible: false, motivo: "claude no está instalado", modelos: [] }),
    ),
    Promise.resolve(
      info("anthropic", {
        disponible: hayClave("anthropic"), ...(hayClave("anthropic") ? {} : { motivo: "falta la clave" }),
        modelos: MODELOS_ANTHROPIC, modeloPorDefecto: MODELOS_ANTHROPIC[0],
      }),
    ),
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
