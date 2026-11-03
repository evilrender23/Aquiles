import { homedir } from "node:os";
import { join } from "node:path";

/** Carpeta de datos: AQUILES_HOME, o %APPDATA%\Aquiles (en Linux $XDG_CONFIG_HOME/Aquiles; si no, ~/.config/Aquiles). */
export function directorioDatos(): string {
  if (process.env.AQUILES_HOME) return process.env.AQUILES_HOME;
  const xdg = process.platform === "linux" && process.env.XDG_CONFIG_HOME?.startsWith("/") ? process.env.XDG_CONFIG_HOME : undefined;
  return join(process.env.APPDATA ?? xdg ?? join(homedir(), ".config"), "Aquiles");
}

export function directorioPerfil(perfil = "principal"): string {
  return join(directorioDatos(), "perfiles", perfil);
}
