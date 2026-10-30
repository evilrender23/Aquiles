/**
 * Utilidades del banco de tareas: la copia de proyectos que usa ejecutar.ts y las ayudas
 * que comparten los comprobar.ts.
 *
 * Convenciones de una carpeta de tarea:
 * - Los ficheros acabados en `.plantilla` se copian sin ese sufijo (`x.test.ts.plantilla` → `x.test.ts`).
 *   Así el `bun test` de la raíz del repo no descubre los tests de las tareas.
 * - `solucion/.borrar` (opcional) lista, una ruta por línea, lo que la solución elimina de `inicial/`.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const SUFIJO_PLANTILLA = ".plantilla";
export const FICHERO_BORRAR = ".borrar";
const IGNORAR = new Set(["node_modules", ".git"]);

/** Ejecutable de Bun que está corriendo (no depende del PATH). */
export const BUN = process.execPath;

/** TypeScript del repo (devDependency de la raíz), para no depender de la red. */
export const TSC = resolve(import.meta.dir, "..", "node_modules", "typescript", "bin", "tsc");

// ---------------------------------------------------------------- copia de proyectos

/** Copia `origen` encima de `destino` aplicando las convenciones `.plantilla` y `.borrar`. */
export function copiarProyecto(origen: string, destino: string): void {
  copiarDir(origen, destino);
  const borrar = join(origen, FICHERO_BORRAR);
  if (!existsSync(borrar)) return;
  const raiz = resolve(destino);
  for (const linea of readFileSync(borrar, "utf8").split(/\r?\n/)) {
    const ruta = linea.trim();
    if (!ruta || ruta.startsWith("#")) continue;
    const abs = resolve(raiz, ruta);
    if (!abs.startsWith(raiz + sep)) throw new Error(`${FICHERO_BORRAR}: ruta fuera del proyecto: ${ruta}`);
    rmSync(abs, { recursive: true, force: true });
  }
}

function copiarDir(origen: string, destino: string): void {
  mkdirSync(destino, { recursive: true });
  for (const e of readdirSync(origen, { withFileTypes: true })) {
    if (IGNORAR.has(e.name) || e.name === FICHERO_BORRAR) continue;
    const de = join(origen, e.name);
    if (e.isDirectory()) {
      copiarDir(de, join(destino, e.name));
      continue;
    }
    const nombre = e.name.endsWith(SUFIJO_PLANTILLA) ? e.name.slice(0, -SUFIJO_PLANTILLA.length) : e.name;
    copyFileSync(de, join(destino, nombre));
  }
}

/** Rutas relativas (con `/`) de todos los ficheros de `dir`, sin node_modules ni .git. */
export function ficheros(dir: string): string[] {
  const salida: string[] = [];
  const recorrer = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (IGNORAR.has(e.name)) continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) recorrer(abs);
      else salida.push(relative(dir, abs).split(sep).join("/"));
    }
  };
  if (existsSync(dir)) recorrer(dir);
  return salida.sort();
}

/** Carpeta temporal nueva (para copias de la carpeta de trabajo o datos de prueba). */
export function carpetaTemporal(prefijo = "aquiles-banco-"): string {
  return mkdtempSync(join(tmpdir(), prefijo));
}

/** Copia la carpeta de trabajo a una temporal (para probar mutaciones sin tocar la original). */
export function copiaTemporal(dir: string): string {
  const copia = carpetaTemporal("aquiles-banco-copia-");
  copiarDir(dir, copia);
  return copia;
}

export function borrar(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- comprobadores

export class Fallo extends Error {}

export function fallar(motivo: string): never {
  throw new Fallo(motivo);
}

export function asegurar(condicion: unknown, motivo: string): asserts condicion {
  if (!condicion) fallar(motivo);
}

export function mostrar(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  return Bun.inspect(v, { depth: 6, colors: false }).replace(/\s+/g, " ");
}

/** Igualdad profunda estricta. */
export function igual(obtenido: unknown, esperado: unknown, contexto: string): void {
  if (!Bun.deepEquals(obtenido, esperado, true)) {
    fallar(`${contexto}: se esperaba ${mostrar(esperado)} y se obtuvo ${mostrar(obtenido)}`);
  }
}

/** Ejecuta `fn` y lanza Fallo si no lanza; devuelve el error lanzado. */
export function lanza(fn: () => unknown, contexto: string): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  fallar(`${contexto}: debería lanzar un error`);
}

/** Directorio de la tarea (donde está el comprobar.ts que se ejecuta). */
export const DIR_TAREA = dirname(Bun.main);

/**
 * Punto de entrada de un comprobar.ts: lee la carpeta de trabajo de argv, ejecuta `fn`
 * y sale con 0 (bien) o 1 (mal) imprimiendo el motivo.
 */
export async function comprobar(fn: (dir: string) => Promise<void> | void): Promise<never> {
  const arg = process.argv[2];
  if (!arg) {
    console.log("Uso: bun comprobar.ts <carpeta de trabajo>");
    process.exit(2);
  }
  const dir = resolve(arg);
  try {
    if (!existsSync(dir)) fallar(`no existe la carpeta de trabajo ${dir}`);
    await fn(dir);
    console.log("OK");
    process.exit(0);
  } catch (e) {
    if (e instanceof Fallo) console.log(`FALLO: ${e.message}`);
    else console.log(`FALLO: error al comprobar: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

/** Contenido de un fichero de la carpeta de trabajo (con finales de línea LF). */
export function leer(dir: string, rel: string): string {
  const ruta = join(dir, rel);
  if (!existsSync(ruta)) fallar(`no existe ${rel}`);
  return readFileSync(ruta, "utf8").replace(/\r\n/g, "\n");
}

export function existe(dir: string, rel: string): boolean {
  return existsSync(join(dir, rel));
}

/** Contenido original de un fichero de `inicial/` de la tarea (acepta el sufijo `.plantilla`). */
export function leerInicial(rel: string): string {
  const base = join(DIR_TAREA, "inicial", rel);
  const ruta = existsSync(base) ? base : base + SUFIJO_PLANTILLA;
  return readFileSync(ruta, "utf8").replace(/\r\n/g, "\n");
}

/** Comprueba que un fichero sigue igual que en `inicial/` (sin contar finales de línea ni espacios al final). */
export function sinCambios(dir: string, rel: string): void {
  const limpiar = (s: string) => s.replace(/[ \t]+$/gm, "").trimEnd();
  if (limpiar(leer(dir, rel)) !== limpiar(leerInicial(rel))) fallar(`${rel} no debía cambiar`);
}

/** Importa un módulo de la carpeta de trabajo. */
export async function importar<T = any>(dir: string, rel: string): Promise<T> {
  const ruta = join(dir, rel);
  if (!existsSync(ruta)) fallar(`no existe ${rel}`);
  return (await import(pathToFileURL(ruta).href)) as T;
}

/** Importa un módulo de `inicial/` de la tarea (la versión original, como referencia). */
export async function importarInicial<T = any>(rel: string): Promise<T> {
  return (await import(pathToFileURL(join(DIR_TAREA, "inicial", rel)).href)) as T;
}

/** Comprueba que una función existe en un módulo y la devuelve. */
export function funcion<F extends (...args: any[]) => any>(modulo: Record<string, unknown>, nombre: string): F {
  const f = modulo[nombre];
  if (typeof f !== "function") fallar(`falta la función exportada ${nombre}`);
  return f as F;
}

export interface Salida {
  codigo: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr. */
  todo: string;
  agotado: boolean;
}

/** Ejecuta un comando y espera a que termine (con límite de tiempo). */
export function ejecutar(
  cmd: string[],
  o: { cwd: string; env?: Record<string, string | undefined>; tiempoMs?: number },
): Salida {
  const r = Bun.spawnSync(cmd, {
    cwd: o.cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...o.env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: o.tiempoMs ?? 30_000,
  });
  const stdout = r.stdout.toString().replace(/\r\n/g, "\n");
  const stderr = r.stderr.toString().replace(/\r\n/g, "\n");
  return {
    codigo: r.exitCode,
    stdout,
    stderr,
    todo: `${stdout}${stderr}`,
    agotado: r.exitCode === null || Boolean((r as { exitedDueToTimeout?: boolean }).exitedDueToTimeout),
  };
}

export interface SalidaTests extends Salida {
  aprobados: number;
  fallidos: number;
}

/** `bun test` en `cwd`. */
export function bunTest(cwd: string, args: string[] = [], tiempoMs = 30_000): SalidaTests {
  const s = ejecutar([BUN, "test", ...args], { cwd, tiempoMs });
  const numero = (re: RegExp) => Number(re.exec(s.todo)?.[1] ?? 0);
  return { ...s, aprobados: numero(/^\s*(\d+) pass/m), fallidos: numero(/^\s*(\d+) fail/m) };
}

/** Últimas líneas no vacías de un texto, para los motivos. */
export function resumir(texto: string, lineas = 12): string {
  return texto
    .split("\n")
    .filter((l) => l.trim())
    .slice(-lineas)
    .join("\n");
}

/** Busca un patrón en los ficheros de texto de la carpeta de trabajo. */
export function buscar(dir: string, patron: RegExp, extensiones = /\.(ts|tsx|js|mjs|json|md)$/): string[] {
  const encontrados: string[] = [];
  for (const rel of ficheros(dir)) {
    if (!extensiones.test(rel)) continue;
    const lineas = readFileSync(join(dir, rel), "utf8").split(/\r?\n/);
    lineas.forEach((l, i) => {
      patron.lastIndex = 0;
      if (patron.test(l)) encontrados.push(`${rel}:${i + 1}: ${l.trim()}`);
    });
  }
  return encontrados;
}
