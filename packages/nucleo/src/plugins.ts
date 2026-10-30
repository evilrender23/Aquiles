/**
 * Plugins: código del usuario en <perfil>/plugins/<nombre>/plugin.ts (o plugin.js) que añade herramientas.
 * Están desactivados hasta que se activan; los activos se guardan en <perfil>/plugins.json ({"activos": [...]}).
 * Solo se importan los activos: listar uno desactivado no ejecuta su código (la descripción se saca del texto).
 *
 * Forma de un plugin. Recibe la API de Aquiles en vez de importarla, porque en el .exe compilado `@aquiles/...` y
 * `zod` no existen para código de fuera:
 *
 *   export default ({ definir, z, ErrorHerramienta }) => ({
 *     descripcion: "Notas rápidas",
 *     herramientas: [definir({ nombre: "anotar", descripcion: "…", nivel: "escritura", parametros: z.object({ … }), async ejecutar(a, ctx) { … } })],
 *   });
 *
 * También vale exportar el objeto directamente. Las herramientas se ofrecen como plugin__<nombre>__<herramienta>;
 * sin `nivel` son de ejecución (piden permiso), porque es código de terceros. Al reactivar un plugin se vuelve a
 * importar su fichero principal; lo que este importe a su vez queda en la caché de módulos hasta reiniciar.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InfoPlugin } from "@aquiles/protocolo";
import { z } from "zod";
import { definir, ErrorHerramienta, type Herramienta, type Nivel } from "./herramientas/herramienta";

/** Error de datos del cliente (plugin que no existe o mal nombrado); el servidor lo devuelve como parámetros no válidos. */
export class ErrorPlugin extends Error {}

export interface ApiPlugin {
  definir: typeof definir;
  z: typeof z;
  ErrorHerramienta: typeof ErrorHerramienta;
}

export interface DefinicionPlugin {
  descripcion?: string;
  herramientas: Herramienta<any>[];
}

const API: ApiPlugin = { definir, z, ErrorHerramienta };
const NOMBRE_PLUGIN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Lo que aceptan las API de los modelos como nombre de herramienta. */
const NOMBRE_HERRAMIENTA = /^[A-Za-z0-9_-]{1,64}$/;
const NIVELES: readonly Nivel[] = ["lectura", "escritura", "ejecucion"];
const FICHEROS = ["plugin.ts", "plugin.js"];
const ESPERA_CARGA_MS = 10_000;

interface Encontrado {
  nombre: string;
  dir: string;
  fichero?: string;
  /** No se puede cargar (nombre no válido, falta el fichero). */
  error?: string;
}

interface Cargado {
  descripcion: string;
  cargado: boolean;
  error?: string;
  herramientas: Herramienta<any>[];
  /** Nombres tal como los escribió el plugin, sin prefijo. */
  nombres: string[];
}

export class Plugins {
  private cargados = new Map<string, Cargado>();
  private importaciones = 0;

  constructor(private o: { dir: string | null; alCambiar?: () => void; log?: (m: string) => void }) {}

  /** Importa los activos (al arrancar). Uno que falle no impide cargar los demás. */
  async cargar(): Promise<void> {
    if (!this.o.dir) return;
    mkdirSync(join(this.o.dir, "plugins"), { recursive: true });
    const activos = this.activos();
    for (const p of this.descubrir()) if (activos.has(p.nombre) && !p.error) await this.importar(p);
    this.o.alCambiar?.();
  }

  listar(): InfoPlugin[] {
    const activos = this.activos();
    return this.descubrir().map((p) => this.info(p, activos));
  }

  /** Al activar lo importa de nuevo (también si ya estaba); al desactivar deja de ofrecer sus herramientas. */
  async activar(nombre: string, activo: boolean): Promise<InfoPlugin> {
    const p = this.descubrir().find((x) => x.nombre === nombre);
    if (!p) throw new ErrorPlugin(`No existe el plugin «${nombre}»${this.o.dir ? ` en ${join(this.o.dir, "plugins")}` : ""}`);
    if (p.error && activo) throw new ErrorPlugin(p.error);
    const activos = this.activos();
    if (activo) activos.add(nombre);
    else activos.delete(nombre);
    this.guardarActivos(activos);
    if (activo) await this.importar(p);
    else this.cargados.delete(nombre);
    this.o.alCambiar?.();
    return this.info(p, activos);
  }

  herramientas(): Herramienta<any>[] {
    return [...this.cargados.values()].flatMap((c) => c.herramientas);
  }

  private info(p: Encontrado, activos: Set<string>): InfoPlugin {
    const c = this.cargados.get(p.nombre);
    const error = p.error ?? c?.error;
    return {
      nombre: p.nombre,
      descripcion: c?.descripcion ?? (p.fichero ? descripcionDelTexto(p.fichero) : ""),
      ruta: p.dir,
      activo: activos.has(p.nombre),
      cargado: c?.cargado ?? false,
      ...(error ? { error } : {}),
      herramientas: c?.nombres ?? [],
    };
  }

  private async importar(p: Encontrado): Promise<void> {
    try {
      // El parámetro fuerza a importarlo de nuevo. Va sobre la ruta y no sobre una URL file://: con la URL, Bun
      // devuelve el módulo de la caché aunque cambie el parámetro (probado también en el .exe compilado).
      const especificador = `${p.fichero!}?v=${Date.now()}-${++this.importaciones}`;
      const modulo = await conLimite(import(especificador), `${p.nombre} tardó más de ${ESPERA_CARGA_MS / 1000} s en cargar`);
      const exportado = (modulo as { default?: unknown }).default;
      if (exportado === undefined) throw new Error("no tiene `export default`");
      const def = (typeof exportado === "function"
        ? await conLimite(Promise.resolve(exportado(API)), `${p.nombre} tardó más de ${ESPERA_CARGA_MS / 1000} s en prepararse`)
        : exportado) as Partial<DefinicionPlugin> | null;
      if (typeof def !== "object" || def === null || !Array.isArray(def.herramientas)) {
        throw new Error("debe exportar { descripcion, herramientas: [...] } o una función que lo devuelva");
      }
      const herramientas: Herramienta<any>[] = [];
      const nombres: string[] = [];
      const descartadas: string[] = [];
      for (const h of def.herramientas as unknown[]) {
        const r = adaptar(p.nombre, h);
        if (typeof r === "string") descartadas.push(r);
        else if (nombres.includes((h as { nombre: string }).nombre)) descartadas.push(`${(h as { nombre: string }).nombre} (repetida)`);
        else {
          herramientas.push(r);
          nombres.push((h as { nombre: string }).nombre);
        }
      }
      const error = descartadas.length ? `No se cargaron: ${descartadas.join("; ")}` : undefined;
      if (error) this.o.log?.(`plugin ${p.nombre}: ${error}`);
      this.cargados.set(p.nombre, {
        descripcion: typeof def.descripcion === "string" ? def.descripcion : "", cargado: true, herramientas, nombres, ...(error ? { error } : {}),
      });
      this.o.log?.(`plugin ${p.nombre} cargado (${nombres.length} herramientas)`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.o.log?.(`plugin ${p.nombre} no se pudo cargar: ${error}`);
      this.cargados.set(p.nombre, { descripcion: descripcionDelTexto(p.fichero!), cargado: false, error, herramientas: [], nombres: [] });
    }
  }

  private descubrir(): Encontrado[] {
    if (!this.o.dir) return [];
    const raiz = join(this.o.dir, "plugins");
    if (!existsSync(raiz)) return [];
    return readdirSync(raiz, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d): Encontrado => {
        const dir = join(raiz, d.name);
        if (!NOMBRE_PLUGIN.test(d.name)) {
          return { nombre: d.name, dir, error: "Nombre de carpeta no válido: minúsculas, números, - y _ (hasta 40)" };
        }
        const fichero = FICHEROS.map((f) => join(dir, f)).find((f) => existsSync(f));
        return fichero ? { nombre: d.name, dir, fichero } : { nombre: d.name, dir, error: `No tiene ${FICHEROS.join(" ni ")}` };
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  private activos(): Set<string> {
    if (!this.o.dir) return new Set();
    try {
      const datos = JSON.parse(readFileSync(join(this.o.dir, "plugins.json"), "utf8"));
      return new Set(Array.isArray(datos?.activos) ? datos.activos.filter((x: unknown) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }

  private guardarActivos(activos: Set<string>): void {
    if (!this.o.dir) return;
    mkdirSync(this.o.dir, { recursive: true });
    writeFileSync(join(this.o.dir, "plugins.json"), `${JSON.stringify({ activos: [...activos].sort() }, null, 2)}\n`);
  }
}

/**
 * Herramienta del plugin con su nombre completo, o el motivo por el que no se carga. Los ganchos opcionales van
 * envueltos: un fallo en `resumen` o `rutas` no puede tumbar el turno.
 */
function adaptar(plugin: string, x: unknown): Herramienta<any> | string {
  const h = x as Partial<Herramienta<any>> | null;
  if (typeof h !== "object" || h === null || typeof h.nombre !== "string") return "una sin nombre";
  const nombre = `plugin__${plugin}__${h.nombre}`;
  if (!NOMBRE_HERRAMIENTA.test(nombre)) return `${h.nombre} (nombre no válido o de más de ${64 - nombre.length + h.nombre.length} caracteres)`;
  const nivel = h.nivel ?? "ejecucion";
  if (!NIVELES.includes(nivel)) return `${h.nombre} (nivel «${String(nivel)}» no válido: ${NIVELES.join(", ")})`;
  const ejecutar = h.ejecutar;
  if (typeof ejecutar !== "function") return `${h.nombre} (sin ejecutar)`;
  const parametros = h.parametros ?? z.object({});
  if (typeof (parametros as { safeParse?: unknown }).safeParse !== "function") return `${h.nombre} (parametros no es un esquema de zod)`;
  const { resumen, rutas, clavePermiso } = h;
  return {
    nombre,
    descripcion: typeof h.descripcion === "string" ? h.descripcion : "",
    nivel,
    parametros,
    ...(h.esquema && typeof h.esquema === "object" ? { esquema: h.esquema } : {}),
    async ejecutar(args, ctx) {
      const r: unknown = await ejecutar.call(h, args, ctx);
      return typeof r === "string" ? r : r === undefined ? "" : JSON.stringify(r);
    },
    ...(typeof resumen === "function" ? { resumen: (a: unknown) => seguro(() => String(resumen.call(h, a) ?? ""), "") } : {}),
    ...(typeof rutas === "function"
      ? { rutas: (a: unknown, cwd: string) => seguro(() => (rutas.call(h, a, cwd) ?? []).filter((r) => typeof r === "string"), []) }
      : {}),
    ...(typeof clavePermiso === "function" ? { clavePermiso: (a: unknown) => seguro(() => String(clavePermiso.call(h, a)), "*") } : {}),
  };
}

function seguro<T>(f: () => T, siFalla: T): T {
  try {
    return f();
  } catch {
    return siFalla;
  }
}

function conLimite<T>(promesa: Promise<T>, mensaje: string): Promise<T> {
  let reloj: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, mal) => {
    reloj = setTimeout(() => mal(new Error(mensaje)), ESPERA_CARGA_MS);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(reloj));
}

/** Descripción de un plugin sin ejecutarlo: el primer `descripcion: "…"` del fichero. */
function descripcionDelTexto(fichero: string): string {
  try {
    const m = /descripcion\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(readFileSync(fichero, "utf8"));
    return m ? m[2]!.replace(/\\(.)/g, "$1").slice(0, 300) : "";
  } catch {
    return "";
  }
}
