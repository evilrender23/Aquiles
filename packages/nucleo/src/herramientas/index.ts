import { buscarFicheros } from "./buscar-ficheros";
import { buscarTexto } from "./buscar-texto";
import { editar } from "./editar";
import { escribir } from "./escribir";
import type { Herramienta } from "./herramienta";
import { leer } from "./leer";
import { preguntar } from "./preguntar";
import { procesos } from "./procesos";
import { EstadoTerminal } from "./shell";
import { tareas } from "./tareas";
import { terminal } from "./terminal";

export { buscarFicheros, buscarTexto, editar, escribir, leer, preguntar, procesos, tareas, terminal };

export function herramientasPorDefecto(): Herramienta<any>[] {
  return [leer, buscarFicheros, buscarTexto, escribir, editar, terminal, procesos, tareas, preguntar];
}

/** Libera lo que las herramientas dejaron en `ctx.estado`: mata el shell y los procesos en segundo plano de la sesión. */
export async function cerrarEstadoSesion(estado: Map<string, unknown>): Promise<void> {
  for (const [clave, valor] of [...estado]) {
    if (valor instanceof EstadoTerminal) {
      estado.delete(clave);
      await valor.cerrar().catch(() => {});
    }
  }
}
