import type { Ajustes, Diff, InfoProveedor, InfoSesion, PeticionesCliente, TareaVisible } from "@aquiles/protocolo";

/** Lo que se pinta en una conversación, en orden. */
export type Elemento =
  | { tipo: "usuario"; id: string; texto: string; hora?: number }
  | { tipo: "asistente"; id: string; texto: string; /** sigue llegando en streaming */ abierto: boolean; hora?: number }
  | {
      tipo: "herramienta";
      id: string;
      nombre: string;
      resumen: string;
      estado: "en-curso" | "ok" | "fallo";
      salida?: string;
      diffs?: Diff[];
      inicio?: number;
      ms?: number;
    }
  | { tipo: "pensamiento"; id: string; ms: number }
  | { tipo: "tareas"; id: string; tareas: TareaVisible[] }
  | { tipo: "resumen"; id: string; texto: string }
  | { tipo: "aviso"; id: string; nivel: "aviso" | "error"; texto: string };

export interface Conversacion {
  elementos: Elemento[];
  cargando: boolean;
  /** Turno en marcha según esta interfaz (se combina con `InfoSesion.trabajando`). */
  trabajando: boolean;
  /** Desde cuándo está esperando al modelo, si lo está. */
  pensandoDesde?: number;
  contexto?: { tokens: number; ventana?: number };
}

export type Pendiente =
  | {
      tipo: "aprobacion";
      id: string;
      sesionId: string;
      params: PeticionesCliente["aprobacion.pedir"]["params"];
      responder: (d: PeticionesCliente["aprobacion.pedir"]["resultado"]["decision"]) => void;
    }
  | {
      tipo: "pregunta";
      id: string;
      sesionId: string;
      params: PeticionesCliente["pregunta.hacer"]["params"];
      responder: (r: string) => void;
    };

export type Vista = "inicio" | "conversacion" | "habilidades" | "memoria" | "ajustes";
export type EstadoConexion = "conectando" | "conectada" | "caida";

export interface EstadoApp {
  conexion: EstadoConexion;
  errorConexion?: string;
  vista: Vista;
  activa?: string;
  sesiones: Record<string, InfoSesion>;
  conversaciones: Record<string, Conversacion>;
  pendientes: Pendiente[];
  proveedores: InfoProveedor[];
  ajustes?: Ajustes;
  /** Suben con memoria.actualizada y skills.actualizadas (y al reconectar): las vistas que las muestran vuelven a pedirlas. */
  revisiones: { memoria: number; skills: number };
}
