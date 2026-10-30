/**
 * Perfiles y copias de seguridad.
 *   <datos>/perfiles/<nombre>/   un perfil (sesiones, memoria, skills, ajustes…)
 *   <datos>/copias/<perfil>-<fecha>.zip
 * Restaurar no puede pisar un perfil abierto (el índice SQLite está abierto): se descomprime en
 * <datos>/restaurar/<perfil>/ y el núcleo se reinicia; al arrancar, `aplicarRestauracion` cambia las carpetas
 * y deja la versión anterior como <perfil>.antes-<fecha>.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { InfoCopia, InfoPerfil } from "@aquiles/protocolo";
import { directorioDatos } from "./rutas";

export const NOMBRE_PERFIL = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Lo que no se copia: se reconstruye solo (índice de búsqueda) o es temporal. */
const EXCLUIR = ["busqueda.db*", "aprendizaje/revisiones", "navegador"];

const sello = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export function listarPerfiles(datos = directorioDatos()): InfoPerfil[] {
  const raiz = join(datos, "perfiles");
  if (!existsSync(raiz)) return [];
  return readdirSync(raiz, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NOMBRE_PERFIL.test(d.name))
    .map((d) => {
      const sesiones = join(raiz, d.name, "sesiones");
      let n = 0;
      let ultima = 0;
      if (existsSync(sesiones)) {
        for (const f of readdirSync(sesiones)) {
          if (!f.endsWith(".jsonl")) continue;
          n += 1;
          ultima = Math.max(ultima, statSync(join(sesiones, f)).mtimeMs);
        }
      }
      return { nombre: d.name, sesiones: n, ...(ultima ? { actualizado: new Date(ultima).toISOString() } : {}) };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

export function crearPerfil(nombre: string, datos = directorioDatos()): InfoPerfil {
  if (!NOMBRE_PERFIL.test(nombre)) throw new Error("Nombre de perfil no válido: minúsculas, cifras, - y _, hasta 40.");
  const dir = join(datos, "perfiles", nombre);
  if (existsSync(dir)) throw new Error(`Ya existe el perfil ${nombre}`);
  mkdirSync(dir, { recursive: true });
  return { nombre, sesiones: 0 };
}

export function listarCopias(datos = directorioDatos()): InfoCopia[] {
  const dir = join(datos, "copias");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[a-z0-9][a-z0-9_-]*-\d{8}T\d{6}Z\.zip$/.test(f))
    .map((f) => {
      const m = /^(.+)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.zip$/.exec(f)!;
      return {
        nombre: f,
        perfil: m[1]!,
        fecha: `${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}Z`,
        bytes: statSync(join(dir, f)).size,
      };
    })
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
}

async function tar(args: string[]): Promise<void> {
  // bsdtar de Windows (System32\tar.exe) escribe y lee zip con -a / por la extensión.
  const p = Bun.spawn([process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar", ...args], { stdout: "pipe", stderr: "pipe" });
  const [codigo, error] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  if (codigo !== 0) throw new Error(`tar falló (${codigo}): ${error.trim().slice(0, 500)}`);
}

export async function crearCopia(perfil: string, datos = directorioDatos(), ahora = new Date()): Promise<InfoCopia> {
  const origen = join(datos, "perfiles", perfil);
  if (!existsSync(origen)) throw new Error(`No existe el perfil ${perfil}`);
  const dir = join(datos, "copias");
  mkdirSync(dir, { recursive: true });
  const nombre = `${perfil}-${sello(ahora)}.zip`;
  const destino = join(dir, nombre);
  await tar(["-a", "-c", "-f", destino, ...EXCLUIR.flatMap((e) => ["--exclude", e]), "-C", origen, "."]);
  return listarCopias(datos).find((c) => c.nombre === nombre)!;
}

/** Descomprime la copia donde la recogerá `aplicarRestauracion` en el próximo arranque. */
export async function prepararRestauracion(nombre: string, datos = directorioDatos()): Promise<string> {
  const copia = listarCopias(datos).find((c) => c.nombre === basename(nombre));
  if (!copia) throw new Error(`No existe la copia ${nombre}`);
  const destino = join(datos, "restaurar", copia.perfil);
  rmSync(destino, { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });
  await tar(["-x", "-f", join(datos, "copias", copia.nombre), "-C", destino]);
  return copia.perfil;
}

/** Al arrancar, antes de abrir el perfil: si hay una restauración preparada, cambia las carpetas. */
export function aplicarRestauracion(perfil: string, datos = directorioDatos(), ahora = new Date()): string | undefined {
  const preparada = join(datos, "restaurar", perfil);
  if (!existsSync(preparada)) return undefined;
  const actual = join(datos, "perfiles", perfil);
  let anterior: string | undefined;
  if (existsSync(actual)) {
    anterior = join(datos, "perfiles", `${perfil}.antes-${sello(ahora)}`);
    renameSync(actual, anterior);
  }
  mkdirSync(join(datos, "perfiles"), { recursive: true });
  renameSync(preparada, actual);
  return anterior;
}
