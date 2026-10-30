import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Servicio {
  puerto: number;
  replicas: number;
  proveedor?: string;
}

export interface Config {
  servicios: Record<string, Servicio>;
  registro: string;
}

const raiz = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

function leerJson(rel: string): Partial<Config> {
  const ruta = raiz(rel);
  return existsSync(ruta) ? JSON.parse(readFileSync(ruta, "utf8")) : {};
}

/** Variables `CLAVE=valor` de un fichero .env (ignora comentarios y líneas vacías). */
function leerEnv(rel: string): Record<string, string> {
  const ruta = raiz(rel);
  if (!existsSync(ruta)) return {};
  const vars: Record<string, string> = {};
  for (const linea of readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(linea);
    if (m) vars[m[1]!] = m[2]!;
  }
  return vars;
}

/**
 * Configuración efectiva de un entorno. Prioridad (de menos a más):
 * config/base.json < config/<entorno>.json < .env.<entorno> < variables de entorno del proceso.
 * En los .env y en el proceso, `<SERVICIO>_PUERTO` cambia el puerto de un servicio.
 */
export function cargarConfig(entorno: string, env: Record<string, string | undefined> = process.env): Config {
  const base = leerJson("config/base.json");
  const propio = leerJson(`config/${entorno}.json`);
  const servicios: Record<string, Servicio> = {};
  for (const [nombre, s] of Object.entries(base.servicios ?? {})) {
    servicios[nombre] = { ...s, ...propio.servicios?.[nombre] };
  }
  const variables = { ...leerEnv(`.env.${entorno}`), ...soloDefinidas(env) };
  for (const [nombre, s] of Object.entries(servicios)) {
    const puerto = variables[`${nombre.toUpperCase()}_PUERTO`];
    if (puerto) s.puerto = Number(puerto);
  }
  return { servicios, registro: variables.REGISTRO ?? propio.registro ?? base.registro ?? "info" };
}

function soloDefinidas(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}
