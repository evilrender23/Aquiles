import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { WINDOWS } from "./ficheros";

/** Carpetas que nunca se recorren (salvo si se pide buscar dentro de ellas). */
export const CARPETAS_EXCLUIDAS = new Set([".git", "node_modules", "dist", "target", ".venv", "__pycache__"]);

interface Regla {
  glob: Bun.Glob;
  negada: boolean;
  soloCarpetas: boolean;
  /** Con "/" en medio se compara la ruta relativa a `base`; sin ella, solo el nombre. */
  anclada: boolean;
  base: string;
}

const caso = (s: string) => (WINDOWS ? s.toLowerCase() : s);
const conBarras = (s: string) => s.split(sep).join("/");

/** Reglas de un .gitignore (subconjunto razonable: comentarios, !, / inicial o final, *, **, ?, []). */
export async function cargarGitignore(dir: string): Promise<Regla[]> {
  const texto = await Bun.file(join(dir, ".gitignore"))
    .text()
    .catch(() => "");
  const reglas: Regla[] = [];
  for (const cruda of texto.split(/\r?\n/)) {
    let p = cruda.trim();
    if (!p || p.startsWith("#")) continue;
    const negada = p.startsWith("!");
    if (negada) p = p.slice(1);
    const soloCarpetas = p.endsWith("/");
    if (soloCarpetas) p = p.replace(/\/+$/, "");
    const anclada = p.includes("/");
    p = p.replace(/^\//, "");
    if (!p) continue;
    reglas.push({ glob: new Bun.Glob(caso(p)), negada, soloCarpetas, anclada, base: dir });
  }
  return reglas;
}

function ignorada(abs: string, nombre: string, esCarpeta: boolean, reglas: readonly Regla[]): boolean {
  let fuera = false;
  for (const r of reglas) {
    if (r.soloCarpetas && !esCarpeta) continue;
    const rel = relative(r.base, abs);
    if (!rel || rel.startsWith("..")) continue;
    if (r.glob.match(caso(r.anclada ? conBarras(rel) : nombre))) fuera = !r.negada;
  }
  return fuera;
}

export interface Entrada {
  abs: string;
  /** Relativa a la raíz del recorrido, con "/". */
  rel: string;
  nombre: string;
}

/** Ficheros bajo `raiz` en orden alfabético, sin las carpetas excluidas ni lo ignorado por las reglas. */
export async function* recorrer(raiz: string, reglas: readonly Regla[], senal?: AbortSignal): AsyncGenerator<Entrada> {
  const pila: string[] = [raiz];
  while (pila.length > 0) {
    if (senal?.aborted) return;
    const dir = pila.pop()!;
    const entradas = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entradas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const carpetas: string[] = [];
    for (const e of entradas) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!CARPETAS_EXCLUIDAS.has(e.name) && !ignorada(abs, e.name, true, reglas)) carpetas.push(abs);
      } else if (e.isFile() && !ignorada(abs, e.name, false, reglas)) {
        yield { abs, rel: conBarras(relative(raiz, abs)), nombre: e.name };
      }
    }
    for (let i = carpetas.length - 1; i >= 0; i--) pila.push(carpetas[i]!);
  }
}

/** Reglas de los .gitignore de la carpeta de trabajo y de la raíz de la búsqueda. */
export async function reglasPara(raiz: string, cwd: string): Promise<Regla[]> {
  const reglas = await cargarGitignore(cwd);
  if (caso(raiz) !== caso(cwd)) reglas.push(...(await cargarGitignore(raiz)));
  return reglas;
}

/** Filtro de ficheros por glob: sin "/" compara el nombre; con "/", la ruta relativa a la raíz. */
export function filtroGlob(patron: string): (e: Entrada) => boolean {
  let p = WINDOWS ? patron.replace(/\\/g, "/") : patron;
  p = p.replace(/^\.\//, "");
  const glob = new Bun.Glob(caso(p));
  const porRuta = p.includes("/");
  return (e) => glob.match(caso(porRuta ? e.rel : e.nombre));
}
