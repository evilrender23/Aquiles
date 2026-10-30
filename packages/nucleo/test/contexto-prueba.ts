import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextoHerramienta, NotificacionHerramienta, Pregunta } from "../src/herramientas/herramienta";
import { cerrarEstadoSesion } from "../src/herramientas/index";

export interface ContextoPrueba extends ContextoHerramienta {
  notificaciones: NotificacionHerramienta[];
  progresos: string[];
  preguntas: Pregunta[];
  /** Respuestas que dará `preguntar`, en orden. */
  respuestas: string[];
  controlador: AbortController;
  cerrar(): Promise<void>;
}

export function contextoPrueba(cwd: string, extra: Partial<ContextoHerramienta> = {}): ContextoPrueba {
  const controlador = new AbortController();
  const ctx: ContextoPrueba = {
    cwd,
    senal: controlador.signal,
    sesionId: "prueba",
    lecturas: new Map(),
    estado: new Map(),
    notificaciones: [],
    progresos: [],
    preguntas: [],
    respuestas: [],
    controlador,
    async preguntar(p) {
      ctx.preguntas.push(p);
      return ctx.respuestas.shift() ?? "";
    },
    notificar(n) {
      ctx.notificaciones.push(n);
    },
    progreso(t) {
      ctx.progresos.push(t);
    },
    cerrar: () => cerrarEstadoSesion(ctx.estado),
    ...extra,
  };
  return ctx;
}

export async function carpetaTemporal(prefijo: string): Promise<{ dir: string; borrar(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `aquiles-${prefijo}-`));
  return { dir, borrar: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/** true si el proceso con ese pid sigue vivo. */
export function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
