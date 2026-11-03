/**
 * Carga y formato de SKILL.md: raíces donde se buscan, lectura del frontmatter, validación de nombre, descripción
 * y rutas de apoyo, y lectura de la carpeta de una skill.
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InfoSkill } from "@aquiles/protocolo";
import { dentroDe } from "../aprobaciones";
import { decodificar } from "../herramientas/ficheros";
import { ErrorHerramienta } from "../herramientas/herramienta";

export class ErrorSkill extends ErrorHerramienta {}

const DIRECTORIOS_APOYO = ["references", "templates", "scripts"] as const;
const MAX_SKILL = 60_000;
export const MAX_FICHERO = 200_000;
export const NOMBRE_VALIDO = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,63}$/u;

/** Una skill encontrada en disco, antes de juntarla con su registro. */
export interface Encontrada {
  nombre: string;
  descripcion: string;
  dir: string;
  ubicacion: InfoSkill["ubicacion"];
  archivada?: boolean;
}

/** Raíces de skills, de más a menos precedencia: proyecto, perfil e incluidas. */
export function raices(cwd: string | undefined, perfil: string | null, incluidas: string | null): { dir: string; ubicacion: InfoSkill["ubicacion"] }[] {
  const r: { dir: string; ubicacion: InfoSkill["ubicacion"] }[] = [];
  if (cwd) r.push({ dir: join(cwd, ".aquiles", "skills"), ubicacion: "proyecto" }, { dir: join(cwd, ".claude", "skills"), ubicacion: "proyecto" });
  if (perfil) r.push({ dir: join(perfil, "skills"), ubicacion: "perfil" });
  if (incluidas) r.push({ dir: incluidas, ubicacion: "incluida" });
  return r;
}

/** Skills válidas de una raíz, por orden de carpeta (si dos se llaman igual, gana la primera). */
export function skillsEn(raiz: string, ubicacion: InfoSkill["ubicacion"], archivada = false): Encontrada[] {
  let carpetas: string[];
  try {
    carpetas = readdirSync(raiz, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const salida: Encontrada[] = [];
  for (const carpeta of carpetas) {
    const dir = join(raiz, carpeta);
    const texto = leerTexto(join(dir, "SKILL.md"));
    const datos = texto === undefined ? undefined : frontmatter(texto);
    const nombre = datos?.name?.trim();
    const descripcion = datos?.description?.trim();
    if (!nombre || !descripcion || !NOMBRE_VALIDO.test(nombre) || salida.some((x) => x.nombre === nombre)) continue;
    salida.push({ nombre, descripcion, dir, ubicacion, ...(archivada ? { archivada } : {}) });
  }
  return salida;
}

export function validarApoyo(contenido: string): string {
  const texto = contenido.replace(/\r\n/g, "\n");
  if (texto.length > MAX_FICHERO) throw new ErrorSkill(`El fichero es demasiado largo (${texto.length} caracteres; máximo ${MAX_FICHERO}).`);
  return texto;
}

/**
 * Frontmatter YAML sencillo: `clave: valor` (con o sin comillas), bloques `>` y `|`, y continuaciones sangradas.
 * Las claves anidadas se leen como texto de la clave padre y se ignoran.
 */
export function frontmatter(texto: string): Record<string, string> | undefined {
  const lineas = texto.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lineas[0]?.trimEnd() !== "---") return undefined;
  const fin = lineas.findIndex((l, i) => i > 0 && (l.trimEnd() === "---" || l.trimEnd() === "..."));
  if (fin === -1) return undefined;
  const datos: Record<string, string> = {};
  let clave: string | undefined;
  let estilo = "";
  let valores: string[] = [];
  const cerrar = () => {
    if (clave) datos[clave] = (estilo === "|" ? valores.join("\n") : valores.filter(Boolean).join(" ")).trim();
  };
  for (const l of lineas.slice(1, fin)) {
    const m = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(l);
    if (m) {
      cerrar();
      clave = m[1]!;
      const v = (m[2] ?? "").trim();
      estilo = /^[>|][+-]?$/.test(v) ? v[0]! : "";
      valores = estilo || !v ? [] : [sinComillas(v)];
    } else if (clave && (/^\s/.test(l) || !l.trim())) valores.push(l.trim());
  }
  cerrar();
  return datos;
}

function sinComillas(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Comprueba un SKILL.md antes de guardarlo; devuelve el texto con finales LF. */
export function validarSkill(contenido: string, nombre: string): string {
  const texto = contenido.replace(/\r\n/g, "\n");
  if (texto.length > MAX_SKILL) throw new ErrorSkill(`SKILL.md es demasiado largo (${texto.length} caracteres; máximo ${MAX_SKILL}). Pasa el detalle a references/.`);
  const datos = frontmatter(texto);
  const ejemplo = `---\nname: ${nombre}\ndescription: Qué hace y cuándo usarla.\n---\n\n# …`;
  if (!datos) throw new ErrorSkill(`SKILL.md debe empezar con el frontmatter entre líneas «---», así:\n${ejemplo}`);
  if (datos.name?.trim() !== nombre) throw new ErrorSkill(`El frontmatter debe tener name: ${nombre} (tiene «${datos.name ?? ""}»).`);
  const descripcion = datos.description?.trim();
  if (!descripcion) throw new ErrorSkill(`Falta description en el frontmatter: qué hace la skill y cuándo usarla. Ejemplo:\n${ejemplo}`);
  if (descripcion.length > 1024) throw new ErrorSkill("La description no puede pasar de 1024 caracteres.");
  return texto;
}

export function normalizarRel(rel: string): string {
  return rel.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

/** Ruta absoluta de un fichero de la skill; solo SKILL.md (si se permite) o bajo references/, templates/ o scripts/. */
export function rutaDentro(dir: string, rel: string, permitirSkill: boolean): string {
  const r = normalizarRel(rel);
  const partes = r.split("/");
  if (permitirSkill && r === "SKILL.md") return join(dir, "SKILL.md");
  if (
    /^[a-zA-Z]:/.test(r) || r.startsWith("/") || r.includes(":") ||
    partes.some((p) => !p || p === "." || p === "..") ||
    partes.length < 2 || !(DIRECTORIOS_APOYO as readonly string[]).includes(partes[0]!)
  ) {
    throw new ErrorSkill(`Ruta no válida: «${rel}». Los ficheros de apoyo van bajo references/, templates/ o scripts/ dentro de la skill.`);
  }
  const abs = resolve(dir, ...partes);
  if (!dentroDe(abs, dir)) throw new ErrorSkill(`Ruta fuera de la skill: «${rel}».`);
  return abs;
}

/** Ficheros de apoyo (rutas relativas con «/») y la fecha del cambio más reciente en la carpeta. */
export function listarApoyo(dir: string): { ficheros: string[]; actualizada: string } {
  const ficheros: string[] = [];
  let ultima = 0;
  try {
    ultima = statSync(join(dir, "SKILL.md")).mtimeMs;
  } catch {}
  const recorrer = (abs: string, rel: string, nivel: number) => {
    let entradas: Dirent[];
    try {
      entradas = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entradas) {
      if (ficheros.length >= 300 || d.name.startsWith(".") || d.name === "node_modules") continue;
      const hijo = join(abs, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory() && nivel < 4) recorrer(hijo, r, nivel + 1);
      else if (d.isFile()) {
        ficheros.push(r);
        try {
          ultima = Math.max(ultima, statSync(hijo).mtimeMs);
        } catch {}
      }
    }
  };
  for (const sub of DIRECTORIOS_APOYO) recorrer(join(dir, sub), sub, 1);
  return { ficheros: ficheros.sort(), actualizada: new Date(ultima || Date.now()).toISOString() };
}

export function leerTexto(ruta: string): string | undefined {
  try {
    return decodificar(readFileSync(ruta)).texto.replace(/\r\n/g, "\n");
  } catch {
    return undefined;
  }
}
