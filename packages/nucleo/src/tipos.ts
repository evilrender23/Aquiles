import type { Uso } from "@aquiles/protocolo";

export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  argumentos: unknown;
}

/** Formato interno de la conversación; cada proveedor lo traduce al suyo. */
export type Mensaje =
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[] }
  | { rol: "herramienta"; id: string; nombre: string; resultado: string; error: boolean };

export interface EspecHerramienta {
  nombre: string;
  descripcion: string;
  /** JSON Schema de los argumentos. */
  esquema: Record<string, unknown>;
}

export interface PeticionModelo {
  sesionId: string;
  sistema: string;
  mensajes: readonly Mensaje[];
  herramientas: readonly EspecHerramienta[];
  cwd: string;
  senal: AbortSignal;
}

export interface RespuestaModelo {
  texto: string;
  llamadas: LlamadaHerramienta[];
  uso?: Uso;
}

export interface Proveedor {
  readonly nombre: string;
  /** Una llamada al modelo. `alDelta` recibe el texto visible a medida que llega. */
  responder(peticion: PeticionModelo, alDelta: (texto: string) => void): Promise<RespuestaModelo>;
  /** Libera lo asociado a una sesión (o a todas si se omite). */
  cerrar?(sesionId?: string): Promise<void>;
}

export class ErrorAbortado extends Error {
  constructor() {
    super("abortado");
    this.name = "ErrorAbortado";
  }
}
