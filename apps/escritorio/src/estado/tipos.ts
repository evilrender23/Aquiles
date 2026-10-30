import type { Ajustes, Diff, EstadoVoz, InfoAdjunto, InfoProveedor, InfoSesion, MotivoFin, PeticionesCliente, ProgresoDescargaModelo, TareaVisible } from "@aquiles/protocolo";

/** Un adjunto en un mensaje del usuario: del historial (con id) o recién enviado (con su miniatura local, si es imagen). */
export interface AdjuntoVisto {
  id?: string;
  nombre: string;
  tipo?: string;
  bytes?: number;
  clase?: InfoAdjunto["clase"];
  ruta?: string;
  miniatura?: string;
}

/** Lo que se pinta en una conversación, en orden. */
export type Elemento =
  | { tipo: "usuario"; id: string; texto: string; hora?: number; adjuntos?: AdjuntoVisto[] }
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
  /** Lo que tardó el modelo en responder y, si el proveedor lo da, el resumen de su razonamiento. Del historial llega sin `ms`. */
  | { tipo: "pensamiento"; id: string; ms?: number; texto?: string }
  | { tipo: "tareas"; id: string; tareas: TareaVisible[] }
  | { tipo: "resumen"; id: string; texto: string }
  | { tipo: "aviso"; id: string; nivel: "aviso" | "error"; texto: string }
  /** Revisión de lo aprendido en segundo plano (aprendizaje.revision); la de «inicio» se sustituye al acabar. */
  | { tipo: "aprendizaje"; id: string; estado: "inicio" | "fin" | "error"; propuestas?: number; aplicadas?: number; error?: string };

export interface Conversacion {
  elementos: Elemento[];
  cargando: boolean;
  /** Turno en marcha según esta interfaz (se combina con `InfoSesion.trabajando`). */
  trabajando: boolean;
  /** Desde cuándo está esperando al modelo, si lo está. */
  pensandoDesde?: number;
  /** Razonamiento que va llegando mientras piensa (pensamiento.delta). */
  pensamientoVivo?: string;
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

export type Vista = "inicio" | "conversacion" | "habilidades" | "memoria" | "automatizaciones" | "estadisticas" | "ajustes";

/** Subagente lanzado con `delegar`: lo que se sabe por sus eventos (subagente.inicio/fin y sus mensaje.delta). */
export interface Subagente {
  subId: string;
  padre: string;
  tarea: string;
  estado: "en-curso" | MotivoFin;
  /** Final del texto que va escribiendo. */
  texto: string;
  error?: string;
}

/** Aviso del núcleo (`notificacion`) mostrado dentro de la app. */
export interface Notificacion {
  id: number;
  titulo: string;
  texto: string;
  sesionId?: string;
}
export type PestanaMemoria = "usuario" | "agente" | "proyecto" | "alma" | "propuestas" | "aprendido";
/** reiniciando: el núcleo se reinicia a propósito (perfil, copia, remoto); no es un error. */
export type EstadoConexion = "conectando" | "conectada" | "caida" | "reiniciando";

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
  revisiones: { memoria: number; skills: number; aprendizaje: number; cron: number; canales: number; mcp: number; plugins: number; modelos: number };
  /** Último progreso de cada descarga de modelo (modelos.progreso), por id. */
  descargasModelos: Record<string, ProgresoDescargaModelo>;
  /** Por subId; los hijos de una sesión se buscan por `padre`. */
  subagentes: Record<string, Subagente>;
  notificaciones: Notificacion[];
  /** Dictado y lectura disponibles (voz.estado al conectar); sin él, no hay botones de voz. */
  voz?: EstadoVoz;
  /** Pedidos desde un menú contextual a otra parte de la interfaz; `n` distingue dos pedidos iguales seguidos. */
  pedidos: {
    /** Texto para añadir a la caja de la conversación abierta (citar, insertar código). */
    caja?: { texto: string; n: number };
    /** Abrir el editor del objetivo de esta sesión. */
    objetivo?: { sesionId: string; n: number };
    /** Buscar este texto en las conversaciones (barra lateral). */
    busqueda?: { texto: string; n: number };
  };
  /** Pestaña con la que se abre Memoria (p. ej. Propuestas desde el aviso de una revisión). */
  pestanaMemoria?: PestanaMemoria;
}
