import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type NivelRegistro = "debug" | "info" | "warn" | "error";

export interface Config {
  nombre: string;
  version: number;
  servidor: { host: string; puerto: number; tiempoEsperaMs: number };
  idiomas: { porDefecto: string; admitidos: string[] };
  entornos: Record<"desarrollo" | "produccion", { depuracion: boolean; registro: NivelRegistro }>;
  funciones: Record<string, boolean>;
}

const RUTA = fileURLToPath(new URL("../config/app.json", import.meta.url));
const NIVELES: NivelRegistro[] = ["debug", "info", "warn", "error"];
const CLAVES = ["nombre", "version", "servidor", "idiomas", "entornos", "funciones"];

/** Lee y valida config/app.json; lanza un error explicando qué está mal. */
export function cargarConfig(ruta = RUTA): Config {
  const c = JSON.parse(readFileSync(ruta, "utf8")) as Config;
  const desconocidas = Object.keys(c).filter((k) => !CLAVES.includes(k));
  if (desconocidas.length) throw new Error(`Claves desconocidas en la configuración: ${desconocidas.join(", ")}`);
  for (const k of CLAVES) if (!(k in c)) throw new Error(`Falta la clave ${k}`);
  if (!Number.isInteger(c.version) || c.version < 1) throw new Error("version debe ser un entero positivo");
  const { puerto } = c.servidor;
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) throw new Error(`Puerto no válido: ${puerto}`);
  if (!c.idiomas.admitidos.includes(c.idiomas.porDefecto)) throw new Error("El idioma por defecto no está admitido");
  for (const [nombre, e] of Object.entries(c.entornos)) {
    if (!NIVELES.includes(e.registro)) throw new Error(`Nivel de registro no válido en ${nombre}: ${e.registro}`);
  }
  return c;
}
