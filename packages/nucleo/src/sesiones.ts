import type { Mensaje } from "./tipos";

export interface Sesion {
  id: string;
  cwd: string;
  /** Se fija al crear la sesión y no cambia, para que la caché de prompt del proveedor sirva. */
  sistema: string;
  mensajes: Mensaje[];
  turno?: AbortController;
}

export function sistemaBase(cwd: string, fecha = new Date()): string {
  return [
    "Eres Aquiles, un agente personal que trabaja en el ordenador del usuario.",
    `Carpeta de trabajo: ${cwd}`,
    `Fecha: ${fecha.toISOString().slice(0, 10)}`,
    "Responde en el idioma del usuario, de forma directa.",
    "Comprueba con las herramientas en vez de suponer el contenido de los ficheros.",
  ].join("\n");
}

/** Sesiones en memoria (fase 0); la persistencia en disco llega en la fase 1. */
export class Sesiones {
  private porId = new Map<string, Sesion>();

  crear(cwd: string): Sesion {
    const sesion: Sesion = { id: crypto.randomUUID(), cwd, sistema: sistemaBase(cwd), mensajes: [] };
    this.porId.set(sesion.id, sesion);
    return sesion;
  }

  obtener(id: string): Sesion | undefined {
    return this.porId.get(id);
  }
}
