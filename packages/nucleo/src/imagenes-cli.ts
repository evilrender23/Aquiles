/**
 * Imágenes con los CLI en los que el usuario ya ha iniciado sesión, sin claves de API:
 * - Codex (`codex exec` con su función image_generation).
 * - Antigravity (`agy` con su herramienta generate_image, que usa el modelo de imagen de Gemini, «Nano Banana»).
 * Cada uno corre aparte, en una carpeta temporal, con solo esa herramienta. Cómo devuelven la imagen no está
 * documentado, así que se busca de tres formas: en los eventos JSON (una ruta, base64 o un data URL), en la
 * carpeta de trabajo y entre los ficheros de imagen nuevos de sus carpetas de datos (~/.codex, ~/.gemini).
 * Si no aparece, el error dice dónde quedó el registro de eventos.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { lineas } from "./proveedores/agy";
import { ejecutableCodex } from "./proveedores/codex-cli";

export type CliImagen = "codex" | "agy";

export interface ImagenDeCli {
  bytes: Uint8Array;
  mime: string;
  /** Lo que dijo el modelo, si dijo algo. */
  texto?: string;
}

export class ErrorImagenCli extends Error {}

const MIMES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const LIMITE_MS = 300_000;

/** Lo que deja Codex fuera de la generación de imágenes: Aquiles solo le pide eso. */
const CODEX_APAGADAS = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "view_image", "in_app_browser"];
/** Todas las de agy menos generate_image. */
const AGY_DENEGADAS = [
  "view_file", "list_dir", "grep_search", "find_by_name", "run_command", "send_command_input",
  "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit",
  "read_url_content", "search_web", "open_browser_url", "browser_subagent", "invoke_subagent",
  "define_subagent", "schedule", "run_workflow",
];

let codexCacheado: string | undefined;
let codexBuscado = false;
/** Se busca una vez al arrancar (en Windows, también la app de la tienda). */
void ejecutableCodex()
  .then((r) => (codexCacheado = r))
  .finally(() => (codexBuscado = true));

/** Los CLI de imagen instalados: agy primero (Nano Banana), luego Codex. */
export function clisDeImagen(): CliImagen[] {
  const r: CliImagen[] = [];
  if (Bun.which("agy")) r.push("agy");
  if (codexCacheado || (!codexBuscado && Bun.which("codex"))) r.push("codex");
  return r;
}

const prompt = (cli: CliImagen, descripcion: string) =>
  `Genera una imagen con tu herramienta de generación de imágenes${cli === "agy" ? " (generate_image)" : ""}. ` +
  "Solo eso: no escribas código ni uses otras herramientas, y no preguntes nada; si algo no está claro, decide tú.\n\n" +
  `La imagen:\n${descripcion}`;

export interface OpcionesCli {
  senal?: AbortSignal;
  /** Para los tests: el programa (y sus primeros argumentos) y dónde buscar ficheros nuevos. */
  comando?: string[];
  carpetasDeDatos?: string[];
}

export async function generarConCli(cli: CliImagen, descripcion: string, o: OpcionesCli = {}): Promise<ImagenDeCli> {
  const trabajo = await mkdtemp(join(tmpdir(), `aquiles-imagen-${cli}-`));
  const inicio = Date.now();
  const eventos: string[] = [];
  try {
    const { textos } = cli === "codex" ? await correrCodex(descripcion, trabajo, eventos, o) : await correrAgy(descripcion, trabajo, eventos, o);
    const carpetas = o.carpetasDeDatos ?? [join(homedir(), cli === "codex" ? ".codex" : ".gemini")];
    const imagen = imagenDeEventos(eventos) ?? imagenNuevaEn([trabajo, ...carpetas], inicio);
    const texto = textos.join("\n\n").trim();
    if (!imagen) {
      const registro = join(tmpdir(), `aquiles-imagen-${cli}-${inicio}.jsonl`);
      await writeFile(registro, eventos.join("\n")).catch(() => {});
      throw new ErrorImagenCli(
        `${cli} terminó sin que aparezca ninguna imagen${texto ? ` (dijo: ${texto.slice(0, 300)})` : ""}. ` +
          `Sus eventos están en ${registro}.`,
      );
    }
    return { ...imagen, ...(texto ? { texto } : {}) };
  } finally {
    await rm(trabajo, { recursive: true, force: true }).catch(() => {});
  }
}

/** Lanza el proceso, le da `entrada` por stdin (si hay) y guarda cada línea de stdout. */
async function correr(args: string[], cwd: string, entrada: string | undefined, eventos: string[], o: OpcionesCli, hasta?: (linea: string) => boolean) {
  // El entorno de ahora (con las claves y el PATH que el núcleo haya puesto después de arrancar).
  const proceso = Bun.spawn(args, { cwd, env: { ...process.env }, stdin: entrada === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  const limite = AbortSignal.any([o.senal ?? new AbortController().signal, AbortSignal.timeout(LIMITE_MS)]);
  const parar = () => proceso.kill();
  limite.addEventListener("abort", parar, { once: true });
  const stderr = new Response(proceso.stderr).text();
  try {
    if (entrada !== undefined && proceso.stdin) {
      proceso.stdin.write(entrada);
      await proceso.stdin.end();
    }
    for await (const linea of lineas(proceso.stdout)) {
      eventos.push(linea);
      if (hasta?.(linea)) break;
    }
    if (hasta) proceso.kill();
    const codigo = await proceso.exited;
    if (o.senal?.aborted) throw new ErrorImagenCli("Cancelado");
    if (limite.aborted) throw new ErrorImagenCli(`${args[0]} no terminó en ${LIMITE_MS / 1000} s`);
    return { codigo, stderr: (await stderr).trim() };
  } finally {
    limite.removeEventListener("abort", parar);
  }
}

async function correrCodex(descripcion: string, trabajo: string, eventos: string[], o: OpcionesCli) {
  const programa = o.comando ?? [(await ejecutableCodex()) ?? "codex"];
  const args = [
    ...programa,
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    // Puede escribir en su carpeta temporal (si guarda ahí la imagen) y en ningún otro sitio.
    "-s", "workspace-write",
    "-c", 'approval_policy="never"',
    "-c", 'web_search="disabled"',
    "--enable", "image_generation",
    ...CODEX_APAGADAS.flatMap((f) => ["--disable", f]),
    "-C", trabajo,
    "-",
  ];
  const r = await correr(args, trabajo, prompt("codex", descripcion), eventos, o);
  const textos: string[] = [];
  for (const linea of eventos) {
    const ev = json(linea);
    if (ev?.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") textos.push(ev.item.text);
    if (ev?.type === "turn.failed" || ev?.type === "error") throw new ErrorImagenCli(`codex: ${ev.error?.message ?? ev.message ?? "falló sin detalles"}`);
  }
  if (r.codigo !== 0 && !textos.length) throw new ErrorImagenCli(`codex terminó con código ${r.codigo}: ${r.stderr.slice(-500)}`);
  return { textos };
}

async function correrAgy(descripcion: string, trabajo: string, eventos: string[], o: OpcionesCli) {
  const ajustes = join(trabajo, ".aquiles-agy-ajustes.json");
  await mkdir(trabajo, { recursive: true });
  await writeFile(ajustes, JSON.stringify({ permissions: { deny: AGY_DENEGADAS } }));
  const args = [
    ...(o.comando ?? [Bun.which("agy") ?? "agy"]),
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    "--settings", ajustes,
    "-p=",
  ];
  const mensaje = `${JSON.stringify({ event: "user", message: { role: "user", content: prompt("agy", descripcion) } })}\n`;
  // agy sigue vivo esperando otro mensaje: se para al llegar su `result`.
  const r = await correr(args, trabajo, mensaje, eventos, o, (linea) => json(linea)?.event === "result");
  const resultado = eventos.map(json).find((ev) => ev?.event === "result")?.result;
  if (!resultado) throw new ErrorImagenCli(`agy terminó sin respuesta: ${r.stderr.slice(-500) || "sin detalles"}`);
  if (resultado.status !== "SUCCESS") throw new ErrorImagenCli(`agy: ${resultado.error || resultado.status}`);
  return { textos: typeof resultado.response === "string" ? [resultado.response] : [] };
}

function json(linea: string): any {
  try {
    return JSON.parse(linea);
  } catch {
    return undefined;
  }
}

/** Los bytes son de una imagen (PNG, JPEG o WebP), por su cabecera. */
function tipoPorCabecera(b: Uint8Array): string | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return undefined;
}

/** La última imagen que aparezca en los eventos: un data URL, un base64 de una imagen o la ruta de un fichero de imagen. */
export function imagenDeEventos(eventos: readonly string[]): Omit<ImagenDeCli, "texto"> | undefined {
  let encontrada: Omit<ImagenDeCli, "texto"> | undefined;
  const mirar = (v: unknown) => {
    if (typeof v === "string") {
      const dataUrl = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(v);
      if (dataUrl) {
        encontrada = { bytes: Buffer.from(dataUrl[2]!, "base64"), mime: dataUrl[1]! };
        return;
      }
      if (v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 200))) {
        const bytes = Buffer.from(v, "base64");
        const mime = tipoPorCabecera(bytes);
        if (mime) encontrada = { bytes, mime };
        return;
      }
      const ruta = v.replace(/^file:\/\//, "");
      const mime = MIMES[extname(ruta).toLowerCase()];
      if (mime && isAbsolute(ruta) && existsSync(ruta)) {
        const bytes = readFileSync(ruta);
        if (tipoPorCabecera(bytes)) encontrada = { bytes, mime: tipoPorCabecera(bytes)! };
      }
      return;
    }
    if (Array.isArray(v)) v.forEach(mirar);
    else if (v && typeof v === "object") Object.values(v).forEach(mirar);
  };
  for (const linea of eventos) mirar(json(linea));
  return encontrada;
}

/** El fichero de imagen más reciente modificado desde `desde` en esas carpetas (sin bajar más de 6 niveles). */
export function imagenNuevaEn(carpetas: readonly string[], desde: number): Omit<ImagenDeCli, "texto"> | undefined {
  let mejor: { ruta: string; mtime: number } | undefined;
  let vistos = 0;
  const recorrer = (dir: string, nivel: number) => {
    if (nivel > 6 || vistos > 50_000) return;
    let entradas: import("node:fs").Dirent[];
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      vistos++;
      const ruta = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".git") recorrer(ruta, nivel + 1);
      } else if (e.isFile() && MIMES[extname(e.name).toLowerCase()]) {
        const mtime = statSync(ruta, { throwIfNoEntry: false })?.mtimeMs ?? 0;
        if (mtime >= desde - 1000 && (!mejor || mtime > mejor.mtime)) mejor = { ruta, mtime };
      }
    }
  };
  for (const c of carpetas) recorrer(c, 0);
  if (!mejor) return undefined;
  const bytes = readFileSync(mejor.ruta);
  const mime = tipoPorCabecera(bytes);
  return mime ? { bytes, mime } : undefined;
}
