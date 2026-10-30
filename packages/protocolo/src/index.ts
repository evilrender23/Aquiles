/**
 * Protocolo entre la interfaz (o cualquier cliente) y el núcleo de Aquiles:
 * JSON-RPC 2.0 sobre WebSocket. Los esquemas de parámetros son la única fuente
 * de verdad y se validan en el núcleo; los tipos se comparten con la interfaz.
 */
import { z } from "zod";

export const VERSION_PROTOCOLO = 1;

/** Línea que el núcleo imprime en stdout cuando ya escucha: `AQUILES_READY port=N`. */
export const LINEA_LISTO = "AQUILES_READY";

/** Ruta del WebSocket; el token va en `?token=`. */
export const RUTA_RPC = "/rpc";

export const metodos = {
  "nucleo.info": z.object({}),
  "sesion.crear": z.object({ cwd: z.string().min(1).optional() }),
  "prompt.enviar": z.object({ sesionId: z.string().min(1), texto: z.string().min(1) }),
  "prompt.parar": z.object({ sesionId: z.string().min(1) }),
};

export type NombreMetodo = keyof typeof metodos;
export type Params<M extends NombreMetodo> = z.infer<(typeof metodos)[M]>;

export interface Resultados {
  "nucleo.info": { version: string; protocolo: number; proveedor: string };
  "sesion.crear": { sesionId: string; cwd: string };
  "prompt.enviar": { aceptado: true };
  "prompt.parar": { parado: boolean };
}

export interface Uso {
  entrada: number;
  salida: number;
  razonamiento?: number;
}

export type MotivoFin = "fin" | "parado" | "limite" | "error";

export type Evento =
  | { tipo: "mensaje.delta"; sesionId: string; texto: string }
  | { tipo: "herramienta.inicio"; sesionId: string; id: string; nombre: string; argumentos: unknown }
  | { tipo: "herramienta.fin"; sesionId: string; id: string; nombre: string; resultado: string; error: boolean }
  | { tipo: "turno.fin"; sesionId: string; motivo: MotivoFin; texto: string; uso?: Uso; error?: string };

export interface PeticionRpc {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface ErrorRpc {
  code: number;
  message: string;
  data?: unknown;
}

export interface RespuestaRpc {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: ErrorRpc;
}

/** Los eventos del núcleo viajan como notificación JSON-RPC con método `evento`. */
export interface NotificacionEvento {
  jsonrpc: "2.0";
  method: "evento";
  params: Evento;
}

export const codigosError = {
  parse: -32700,
  peticionInvalida: -32600,
  metodoNoExiste: -32601,
  paramsInvalidos: -32602,
  interno: -32603,
  sesionNoExiste: 1001,
  sesionOcupada: 1002,
} as const;
