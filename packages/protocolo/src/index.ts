/**
 * Protocolo entre la interfaz (o cualquier cliente) y el núcleo de Aquiles:
 * JSON-RPC 2.0 sobre WebSocket. Los esquemas de parámetros son la única fuente
 * de verdad y se validan en el núcleo; los tipos se comparten con la interfaz.
 *
 * Además de responder, el núcleo hace peticiones al cliente (aprobaciones y preguntas)
 * con ids de texto que empiezan por "n"; el cliente contesta con el mismo id.
 */
import { z } from "zod";

export const VERSION_PROTOCOLO = 4;

/** Línea que el núcleo imprime en stdout cuando ya escucha: `AQUILES_READY port=N`. */
export const LINEA_LISTO = "AQUILES_READY";

/** Ruta del WebSocket; el token va en `?token=`. */
export const RUTA_RPC = "/rpc";

export const MODOS_APROBACION = ["preguntar-siempre", "preguntar-ejecutar", "libre-proyecto"] as const;
export type ModoAprobacion = (typeof MODOS_APROBACION)[number];

const idSesion = z.string().min(1);

export const metodos = {
  "nucleo.info": z.object({}),
  /** Proveedores conocidos, si están disponibles ahora y sus modelos. */
  "proveedores.listar": z.object({}),
  /** Ajustes por defecto del perfil (los usan las sesiones nuevas). */
  "ajustes.leer": z.object({}),
  "ajustes.guardar": z.object({
    proveedor: z.string().min(1).optional(),
    modelo: z.string().optional(),
    modoAprobacion: z.enum(MODOS_APROBACION).optional(),
    carpeta: z.string().min(1).optional(),
  }),
  /** Clave de API para este proceso (no se guarda: la app la guarda en el llavero y la pasa al arrancar). */
  "ajustes.clave": z.object({ proveedor: z.string().min(1), clave: z.string() }),
  "sesion.crear": z.object({
    cwd: z.string().min(1).optional(),
    modoAprobacion: z.enum(MODOS_APROBACION).optional(),
    proveedor: z.string().min(1).optional(),
    modelo: z.string().optional(),
  }),
  "sesion.listar": z.object({}),
  "sesion.reanudar": z.object({ sesionId: idSesion }),
  /** Cambia proveedor, modelo o permisos de una sesión (vale desde el siguiente turno). */
  "sesion.ajustar": z.object({
    sesionId: idSesion,
    proveedor: z.string().min(1).optional(),
    modelo: z.string().optional(),
    modoAprobacion: z.enum(MODOS_APROBACION).optional(),
  }),
  "sesion.renombrar": z.object({ sesionId: idSesion, titulo: z.string().min(1).max(120) }),
  "sesion.borrar": z.object({ sesionId: idSesion }),
  "prompt.enviar": z.object({ sesionId: idSesion, texto: z.string().min(1) }),
  "prompt.steer": z.object({ sesionId: idSesion, texto: z.string().min(1) }),
  "prompt.parar": z.object({ sesionId: idSesion }),
  /** Memoria del perfil; con `cwd`, también la del proyecto de esa carpeta. */
  "memoria.leer": z.object({ cwd: z.string().min(1).optional() }),
  /** Sustituye todas las entradas de un destino (la interfaz edita la lista entera). */
  "memoria.guardar": z.object({
    destino: z.enum(["usuario", "agente", "proyecto"]),
    cwd: z.string().min(1).optional(),
    entradas: z.array(z.string()),
  }),
  /** Personalidad (SOUL.md). Vale para las sesiones nuevas. */
  "memoria.alma": z.object({ texto: z.string() }),
  "skills.listar": z.object({ cwd: z.string().min(1).optional() }),
  "skills.leer": z.object({ nombre: z.string().min(1), cwd: z.string().min(1).optional() }),
  "skills.ajustar": z.object({ nombre: z.string().min(1), activa: z.boolean(), cwd: z.string().min(1).optional() }),
  "buscar.sesiones": z.object({ consulta: z.string().min(1), limite: z.number().int().min(1).max(100).optional() }),
};

export type NombreMetodo = keyof typeof metodos;
export type Params<M extends NombreMetodo> = z.infer<(typeof metodos)[M]>;

export interface InfoProveedor {
  /** Lo que se pasa como `proveedor` (agy, anthropic, ollama…). */
  id: string;
  nombre: string;
  disponible: boolean;
  /** Por qué no está disponible (falta la clave, no está instalado, no responde…). */
  motivo?: string;
  necesitaClave: boolean;
  /** Modelos conocidos; vacío = se escribe el id a mano. */
  modelos: string[];
  /** Modelo que se usa si no se elige ninguno; ausente = el del propio proveedor. */
  modeloPorDefecto?: string;
}

export interface Ajustes {
  proveedor: string;
  modelo?: string;
  modoAprobacion: ModoAprobacion;
  /** Carpeta de trabajo de las sesiones nuevas. */
  carpeta: string;
}

export interface InfoSesion {
  sesionId: string;
  cwd: string;
  titulo?: string;
  creada: string;
  actualizada: string;
  mensajes: number;
  modoAprobacion: ModoAprobacion;
  proveedor: string;
  modelo?: string;
  /** Hay un turno en marcha. */
  trabajando: boolean;
}

/** Cambios de una herramienta de escritura en un fichero, como diff por bloques con 3 líneas de contexto. */
export interface Diff {
  ruta: string;
  /** El fichero no existía antes. */
  nuevo: boolean;
  anadidas: number;
  quitadas: number;
  bloques: {
    /** Primera línea del bloque en el fichero antes / después (desde 1). */
    lineaAntes: number;
    lineaDespues: number;
    lineas: { tipo: "+" | "-" | " "; texto: string }[];
  }[];
  /** Se recortó por ser demasiado largo. */
  truncado?: boolean;
}

export type MensajeHistorial =
  | { rol: "usuario" | "asistente" | "resumen"; texto: string }
  | { rol: "herramienta"; id: string; nombre: string; resumen?: string; resultado: string; error: boolean; diffs?: Diff[] };

export interface Resultados {
  "nucleo.info": { version: string; protocolo: number; proveedor: string; modelo?: string };
  "proveedores.listar": { proveedores: InfoProveedor[] };
  "ajustes.leer": Ajustes;
  "ajustes.guardar": Ajustes;
  "ajustes.clave": { ok: true };
  "sesion.crear": InfoSesion;
  "sesion.listar": { sesiones: InfoSesion[] };
  "sesion.reanudar": InfoSesion & { historial: MensajeHistorial[] };
  "sesion.ajustar": InfoSesion;
  "sesion.renombrar": InfoSesion;
  "sesion.borrar": { borrada: true };
  "prompt.enviar": { aceptado: true };
  "prompt.steer": { encolado: true };
  "prompt.parar": { parado: boolean };
  "memoria.leer": { usuario: BloqueMemoria; agente: BloqueMemoria; proyecto?: BloqueMemoria & { cwd: string }; alma: string };
  "memoria.guardar": BloqueMemoria;
  "memoria.alma": { texto: string };
  "skills.listar": { skills: InfoSkill[] };
  "skills.leer": InfoSkill & { contenido: string; ficheros: string[] };
  "skills.ajustar": InfoSkill;
  "buscar.sesiones": { resultados: ResultadoBusqueda[] };
}

export type DestinoMemoria = "usuario" | "agente" | "proyecto";

/** Memoria acotada: entradas cortas con un límite de caracteres por destino. */
export interface BloqueMemoria {
  entradas: string[];
  /** Caracteres usados y límite. */
  usados: number;
  limite: number;
}

export interface InfoSkill {
  nombre: string;
  descripcion: string;
  /** incluida = viene con Aquiles; manual = la puso alguien a mano; aprendida = la creó el agente. */
  origen: "incluida" | "manual" | "aprendida";
  /** Dónde está: carpeta del perfil, del proyecto (`<cwd>/.aquiles/skills`) o las incluidas. */
  ubicacion: "perfil" | "proyecto" | "incluida";
  ruta: string;
  activa: boolean;
  usos: number;
  ultimoUso?: string;
  creada?: string;
  actualizada: string;
}

export interface ResultadoBusqueda {
  sesionId: string;
  titulo?: string;
  cwd: string;
  /** Fecha del mensaje encontrado (ISO). */
  fecha: string;
  rol: "usuario" | "asistente" | "herramienta" | "resumen";
  /** Trozo del mensaje con la coincidencia marcada con «» */
  fragmento: string;
}

/** Peticiones del núcleo al cliente. */
export interface PeticionesCliente {
  "aprobacion.pedir": {
    params: { sesionId: string; id: string; herramienta: string; nivel: string; resumen: string; argumentos: unknown; motivo: string };
    resultado: { decision: "permitir" | "siempre" | "denegar" };
  };
  "pregunta.hacer": {
    params: { sesionId: string; texto: string; opciones?: string[]; multiple?: boolean };
    resultado: { respuesta: string };
  };
}
export type NombrePeticionCliente = keyof PeticionesCliente;

export interface Uso {
  entrada: number;
  salida: number;
  razonamiento?: number;
}

export type MotivoFin = "fin" | "parado" | "limite" | "error";

export interface TareaVisible {
  texto: string;
  estado: "pendiente" | "en-curso" | "hecha";
}

export type Evento =
  | { tipo: "mensaje.delta"; sesionId: string; texto: string }
  | { tipo: "herramienta.inicio"; sesionId: string; id: string; nombre: string; argumentos: unknown; resumen?: string }
  | { tipo: "herramienta.progreso"; sesionId: string; id: string; texto: string }
  | { tipo: "herramienta.fin"; sesionId: string; id: string; nombre: string; resultado: string; error: boolean; diffs?: Diff[] }
  | { tipo: "sesion.actualizada"; sesion: InfoSesion }
  | { tipo: "memoria.actualizada"; destino: DestinoMemoria | "alma"; cwd?: string }
  | { tipo: "skills.actualizadas" }
  | { tipo: "tareas"; sesionId: string; tareas: TareaVisible[] }
  | { tipo: "contexto.uso"; sesionId: string; tokens: number; ventana?: number }
  | { tipo: "contexto.compactado"; sesionId: string; metodo: "poda" | "resumen"; antes: number; despues: number }
  | { tipo: "turno.reintento"; sesionId: string; intento: number; esperaMs: number; motivo: string }
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
  sinTurno: 1003,
} as const;
