import type { Diff, InfoAdjunto, Uso } from "@aquiles/protocolo";

/** Fichero adjunto a un mensaje del usuario, ya guardado (adjuntos.ts). Va tal cual en el JSONL de la sesión. */
export interface AdjuntoGuardado extends Omit<InfoAdjunto, "caracteres"> {
  /** Texto que recibe el modelo (documentos y texto), ya recortado; falta si no se pudo sacar nada. */
  texto?: string;
}

export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  argumentos: unknown;
}

/**
 * Formato interno de la conversación; cada proveedor lo traduce al suyo.
 * `resumen` sustituye a la parte antigua de la conversación tras compactar:
 * los proveedores lo envían como un mensaje de usuario marcado como resumen.
 */
export type Mensaje =
  | { rol: "usuario"; texto: string; adjuntos?: AdjuntoGuardado[] }
  | {
      rol: "asistente";
      texto: string;
      llamadas: LlamadaHerramienta[];
      /** Datos opacos que un proveedor necesita recibir de vuelta (p. ej. bloques de razonamiento firmados). */
      opaco?: { proveedor: string; datos: unknown };
    }
  | {
      rol: "herramienta";
      id: string;
      nombre: string;
      resultado: string;
      error: boolean;
      /** Solo para la interfaz (los proveedores no lo envían): la línea de la tarjeta y los cambios en ficheros. */
      resumen?: string;
      diffs?: Diff[];
    }
  | { rol: "resumen"; texto: string };

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
  /** Límite de tokens de salida de esta llamada; si falta, el proveedor elige. */
  maxTokensSalida?: number;
}

export interface RespuestaModelo {
  texto: string;
  llamadas: LlamadaHerramienta[];
  uso?: Uso;
  opaco?: { proveedor: string; datos: unknown };
  /** El modelo se cortó por el límite de salida. */
  cortada?: boolean;
}

export interface Proveedor {
  readonly nombre: string;
  /** Modelo en uso, para mostrarlo y registrarlo. */
  readonly modelo?: string;
  /** Ventana de contexto del modelo en tokens, si se conoce. */
  readonly ventanaContexto?: number;
  /**
   * El proveedor guarda la conversación por su cuenta (agy): solo recibe los mensajes nuevos,
   * así que el núcleo no compacta su historial.
   */
  readonly conversacionPropia?: boolean;
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

/**
 * Error normalizado de un proveedor. El bucle reintenta los de tipo red, cuota y sobrecarga
 * (con `reintentarEnMs` si el proveedor lo indica) y compacta ante `contexto`.
 */
export type TipoErrorProveedor = "red" | "cuota" | "sobrecarga" | "contexto" | "autenticacion" | "peticion" | "otro";

export class ErrorProveedor extends Error {
  constructor(
    readonly tipo: TipoErrorProveedor,
    mensaje: string,
    readonly detalles: { reintentarEnMs?: number; estado?: number; causa?: unknown } = {},
  ) {
    super(mensaje);
    this.name = "ErrorProveedor";
  }

  get reintentable(): boolean {
    return this.tipo === "red" || this.tipo === "cuota" || this.tipo === "sobrecarga";
  }
}
