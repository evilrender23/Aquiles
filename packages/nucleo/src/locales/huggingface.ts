/**
 * Modelos de Hugging Face en formato GGUF: búsqueda, ficheros de cada repositorio, descargas reanudables y el índice de lo
 * descargado. Los ejecuta llama.cpp (`llamacpp.ts`). Todo lo que se enseña (tamaños, ventana, protegido) sale de la API de
 * Hugging Face o del nombre del fichero; nada se supone.
 */
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

export const URL_HF = "https://huggingface.co";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Fuera del perfil: los modelos pesan decenas de GB y no deben entrar en las copias de seguridad. */
export function directorioModelos(): string {
  if (process.env.AQUILES_MODELOS) return process.env.AQUILES_MODELOS;
  return join(process.env.LOCALAPPDATA ?? join(homedir(), ".cache"), "Aquiles", "modelos");
}

export interface ResultadoHF {
  repo: string;
  descargas: number;
  likes: number;
  /** Hace falta aceptar las condiciones en la web y una clave de Hugging Face. */
  protegido: boolean;
  /** Hugging Face lo declara de imagen y texto (necesita su proyector mmproj para ver imágenes). */
  imagenes?: boolean;
  actualizado?: string;
}

/** Un modelo descargable: un .gguf o un juego de partes `-0000N-of-0000M.gguf`. */
export interface FicheroGGUF {
  /** Ruta en el repositorio de la primera parte (la que se le pasa a llama.cpp). */
  nombre: string;
  partes: string[];
  bytes: number;
  /** Cuantización, si el nombre del fichero la dice (Q4_K_M, IQ3_XXS, BF16…). */
  cuantizacion?: string;
}

export interface RepoHF {
  repo: string;
  protegido: boolean;
  /** Contexto de entrenamiento según los metadatos GGUF que publica Hugging Face. */
  ventana?: number;
  arquitectura?: string;
  ficheros: FicheroGGUF[];
  /** Proyectores de visión (mmproj): con uno, el modelo acepta imágenes. */
  proyectores: FicheroGGUF[];
}

const PARTE = /-(\d{5})-of-(\d{5})\.gguf$/i;
const CUANT = /[-._]((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4(?:_[A-Z0-9]+)*))(?:-\d{5}-of-\d{5})?\.gguf$/i;

const cabeceras = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

function validarRepo(repo: string): string {
  if (!/^\w[\w.-]*\/\w[\w.-]*$/.test(repo)) throw new Error(`Repositorio no válido: ${repo}`);
  return repo;
}

async function pedirJson<T>(url: string, o: { fetch?: Fetch; token?: string; senal?: AbortSignal }): Promise<T> {
  const r = await (o.fetch ?? fetch)(url, { headers: cabeceras(o.token), ...(o.senal ? { signal: o.senal } : {}) });
  if (r.status === 401 || r.status === 403) throw new Error("Hugging Face pide una clave con acceso a este modelo (Ajustes → Claves)");
  if (r.status === 404) throw new Error("No existe ese modelo en Hugging Face");
  if (!r.ok) throw new Error(`Hugging Face respondió ${r.status}`);
  return (await r.json()) as T;
}

/** Tareas de Hugging Face que son modelos de chat; el resto (voz, embeddings…) no se ofrece. Sin tarea declarada, se ofrece. */
const TAREAS_CHAT = new Set(["text-generation", "image-text-to-text", "any-to-any"]);

/** Busca repositorios con ficheros GGUF de modelos de chat, los más descargados primero. */
export async function buscarModelos(consulta: string, o: { fetch?: Fetch; token?: string; limite?: number } = {}): Promise<ResultadoHF[]> {
  const q = new URLSearchParams({ search: consulta.trim(), filter: "gguf", sort: "downloads", limit: String(o.limite ?? 50) });
  const lista = await pedirJson<
    { id: string; downloads?: number; likes?: number; gated?: unknown; lastModified?: string; createdAt?: string; pipeline_tag?: string; tags?: string[] }[]
  >(`${URL_HF}/api/models?${q}`, o);
  return lista
    .filter((m) => (m.pipeline_tag ? TAREAS_CHAT.has(m.pipeline_tag) : !m.tags?.some((t) => /embedding|feature-extraction|sentence-similarity/i.test(t))))
    .map((m) => ({
      repo: m.id,
      descargas: m.downloads ?? 0,
      likes: m.likes ?? 0,
      protegido: Boolean(m.gated),
      ...(m.pipeline_tag === "image-text-to-text" ? { imagenes: true } : {}),
      ...(m.lastModified || m.createdAt ? { actualizado: m.lastModified ?? m.createdAt } : {}),
    }));
}

/** Los GGUF de un repositorio, agrupando las partes y separando los proyectores de visión. */
export async function ficherosRepo(repo: string, o: { fetch?: Fetch; token?: string } = {}): Promise<RepoHF> {
  const datos = await pedirJson<{
    gated?: unknown;
    gguf?: { context_length?: number; architecture?: string };
    siblings?: { rfilename: string; size?: number }[];
  }>(`${URL_HF}/api/models/${validarRepo(repo)}?blobs=true`, o);
  const grupos = agruparGGUF((datos.siblings ?? []).map((s) => ({ ruta: s.rfilename, bytes: s.size ?? 0 })));
  const esProyector = (f: FicheroGGUF) => /(^|\/)mmproj/i.test(f.nombre);
  return {
    repo,
    protegido: Boolean(datos.gated),
    ...(datos.gguf?.context_length ? { ventana: datos.gguf.context_length } : {}),
    ...(datos.gguf?.architecture ? { arquitectura: datos.gguf.architecture } : {}),
    ficheros: grupos.filter((f) => !esProyector(f)),
    proyectores: grupos.filter(esProyector),
  };
}

export function agruparGGUF(ficheros: { ruta: string; bytes: number }[]): FicheroGGUF[] {
  const grupos = new Map<string, FicheroGGUF>();
  for (const f of ficheros) {
    if (!f.ruta.toLowerCase().endsWith(".gguf")) continue;
    const clave = f.ruta.replace(PARTE, ".gguf");
    const g = grupos.get(clave) ?? { nombre: f.ruta, partes: [], bytes: 0 };
    g.partes.push(f.ruta);
    g.bytes += f.bytes;
    grupos.set(clave, g);
  }
  return [...grupos.values()]
    .map((g) => {
      const partes = g.partes.sort();
      const cuant = CUANT.exec(partes[0] ?? "")?.[1];
      return { nombre: partes[0] ?? g.nombre, partes, bytes: g.bytes, ...(cuant ? { cuantizacion: cuant.toUpperCase() } : {}) };
    })
    .sort((a, b) => a.bytes - b.bytes);
}

/** Carpeta local de un repositorio: `dueño__nombre`. */
export const carpetaRepo = (base: string, repo: string): string => join(base, validarRepo(repo).replace("/", "__"));

export interface ModeloLocal {
  /** `dueño/repo/ruta.gguf`: lo que se elige como modelo del proveedor llamacpp. */
  id: string;
  repo: string;
  nombre: string;
  ruta: string;
  bytes: number;
  /** Rutas de sus ficheros dentro del repositorio. */
  partes: string[];
  /** Proyector de visión descargado del mismo repositorio. */
  proyector?: string;
}

/** Lo descargado y completo (las partes `.part` a medias no cuentan). */
export async function modelosLocales(base = directorioModelos()): Promise<ModeloLocal[]> {
  if (!existsSync(base)) return [];
  const modelos: ModeloLocal[] = [];
  for (const carpeta of await readdir(base, { withFileTypes: true })) {
    if (!carpeta.isDirectory() || !carpeta.name.includes("__")) continue;
    const repo = carpeta.name.replace("__", "/");
    const raiz = join(base, carpeta.name);
    const ficheros: { ruta: string; bytes: number }[] = [];
    for (const f of await readdir(raiz, { recursive: true, withFileTypes: true })) {
      if (!f.isFile() || !f.name.toLowerCase().endsWith(".gguf")) continue;
      const ruta = join(f.parentPath, f.name);
      ficheros.push({ ruta: relative(raiz, ruta).split(sep).join("/"), bytes: (await stat(ruta)).size });
    }
    const grupos = agruparGGUF(ficheros);
    const proyector = grupos.find((g) => /(^|\/)mmproj/i.test(g.nombre));
    for (const g of grupos) {
      if (g === proyector) continue;
      const total = Number(PARTE.exec(g.nombre)?.[2] ?? 1);
      if (g.partes.length < total) continue;
      modelos.push({
        id: `${repo}/${g.nombre}`,
        repo,
        nombre: g.nombre,
        ruta: join(raiz, ...g.nombre.split("/")),
        bytes: g.bytes,
        partes: g.partes,
        ...(proyector ? { proyector: join(raiz, ...proyector.nombre.split("/")) } : {}),
      });
    }
  }
  return modelos;
}

/** `dueño/repo/ruta.gguf` → repositorio y ruta dentro de él. */
export function partirId(id: string): { repo: string; nombre: string } {
  const [dueno, nombre, ...resto] = id.split("/");
  if (!dueno || !nombre || resto.length === 0) throw new Error(`Modelo local no válido: ${id}`);
  return { repo: validarRepo(`${dueno}/${nombre}`), nombre: resto.join("/") };
}

export interface ProgresoDescarga {
  id: string;
  repo: string;
  nombre: string;
  bytes: number;
  total: number;
  estado: "descargando" | "terminada" | "error" | "cancelada";
  error?: string;
}

/** Descargas en curso, de una en una por modelo. Se reanudan donde se quedaron (cabecera Range sobre el `.part`). */
export class Descargas {
  private activas = new Map<string, { progreso: ProgresoDescarga; control: AbortController }>();

  constructor(
    private o: { base?: string; fetch?: Fetch; token?: () => string | undefined; alProgreso?: (p: ProgresoDescarga) => void; intervaloMs?: number } = {},
  ) {}

  get base(): string {
    return this.o.base ?? directorioModelos();
  }

  listar(): ProgresoDescarga[] {
    return [...this.activas.values()].map((a) => ({ ...a.progreso }));
  }

  /** Empieza a descargar un modelo (y el proyector, si se pasa). Devuelve su id sin esperar a que acabe. */
  iniciar(repo: string, fichero: FicheroGGUF, proyector?: FicheroGGUF): string {
    const id = `${validarRepo(repo)}/${fichero.nombre}`;
    if (this.activas.has(id)) return id;
    const partes = [...fichero.partes, ...(proyector?.partes ?? [])];
    const progreso: ProgresoDescarga = { id, repo, nombre: fichero.nombre, bytes: 0, total: fichero.bytes + (proyector?.bytes ?? 0), estado: "descargando" };
    const control = new AbortController();
    this.activas.set(id, { progreso, control });
    void this.bajar(repo, partes, progreso, control.signal)
      .then(() => {
        progreso.estado = "terminada";
      })
      .catch((e) => {
        progreso.estado = control.signal.aborted ? "cancelada" : "error";
        if (!control.signal.aborted) progreso.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.activas.delete(id);
        this.o.alProgreso?.({ ...progreso });
      });
    return id;
  }

  /** Al cerrar el núcleo: lo descargado queda en `.part` y se reanuda la próxima vez. */
  cancelarTodas(): void {
    for (const a of this.activas.values()) a.control.abort();
  }

  cancelar(id: string): boolean {
    const a = this.activas.get(id);
    a?.control.abort();
    return Boolean(a);
  }

  /** Borra un modelo descargado; la carpeta del repositorio se va con el último (y con ella el proyector). */
  async borrar(id: string): Promise<void> {
    this.cancelar(id);
    const { repo } = partirId(id);
    const raiz = carpetaRepo(this.base, repo);
    const modelo = (await modelosLocales(this.base)).find((m) => m.id === id);
    for (const parte of modelo?.partes ?? []) await rm(join(raiz, ...parte.split("/")), { force: true });
    if (!(await modelosLocales(this.base)).some((m) => m.repo === repo)) await rm(raiz, { recursive: true, force: true });
  }

  private async bajar(repo: string, partes: string[], progreso: ProgresoDescarga, senal: AbortSignal): Promise<void> {
    const raiz = carpetaRepo(this.base, repo);
    let hechas = 0;
    let ultimoAviso = 0;
    const avisar = (forzar = false) => {
      const ahora = Date.now();
      if (!forzar && ahora - ultimoAviso < (this.o.intervaloMs ?? 500)) return;
      ultimoAviso = ahora;
      this.o.alProgreso?.({ ...progreso });
    };
    avisar(true);
    for (const parte of partes) {
      const destino = join(raiz, ...parte.split("/"));
      if (existsSync(destino)) {
        hechas += (await stat(destino)).size;
        progreso.bytes = hechas;
        continue;
      }
      await mkdir(dirname(destino), { recursive: true });
      const temporal = `${destino}.part`;
      const desde = existsSync(temporal) ? (await stat(temporal)).size : 0;
      const token = this.o.token?.();
      const r = await (this.o.fetch ?? fetch)(`${URL_HF}/${repo}/resolve/main/${parte.split("/").map(encodeURIComponent).join("/")}`, {
        headers: { ...cabeceras(token), ...(desde ? { range: `bytes=${desde}-` } : {}) },
        signal: senal,
      });
      if (r.status === 401 || r.status === 403) throw new Error("Hugging Face pide una clave con acceso a este modelo (Ajustes → Claves)");
      if (!r.ok || !r.body) throw new Error(`Hugging Face respondió ${r.status} al descargar ${parte}`);
      // Sin 206, el servidor manda el fichero entero: se empieza de cero.
      const reanuda = desde > 0 && r.status === 206;
      const escritor = createWriteStream(temporal, { flags: reanuda ? "a" : "w" });
      let escritos = reanuda ? desde : 0;
      progreso.bytes = hechas + escritos;
      try {
        for await (const trozo of r.body) {
          if (!escritor.write(trozo)) await new Promise<void>((ok) => escritor.once("drain", ok));
          escritos += trozo.byteLength;
          progreso.bytes = hechas + escritos;
          avisar();
        }
      } finally {
        await new Promise<void>((ok) => escritor.end(ok));
      }
      await rename(temporal, destino);
      hechas += escritos;
    }
    progreso.bytes = hechas;
  }
}
