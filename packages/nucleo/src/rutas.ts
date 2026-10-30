import { homedir } from "node:os";
import { join } from "node:path";

/** Carpeta de datos: AQUILES_HOME, o %APPDATA%\Aquiles (en otros sistemas ~/.config/Aquiles). */
export function directorioDatos(): string {
  if (process.env.AQUILES_HOME) return process.env.AQUILES_HOME;
  return join(process.env.APPDATA ?? join(homedir(), ".config"), "Aquiles");
}

export function directorioPerfil(perfil = "principal"): string {
  return join(directorioDatos(), "perfiles", perfil);
}
