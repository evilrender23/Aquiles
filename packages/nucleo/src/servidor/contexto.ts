/**
 * Lo que comparten los manejadores JSON-RPC: las piezas que crea `iniciarServidor` (ajustes, sesiones, conocimiento,
 * automatizaciones, extensiones…) y las funciones de su cierre que los manejadores necesitan. Cada rutas-*.ts
 * recibe este contexto y devuelve los manejadores de su área.
 */
import type { CambioCurador, Evento, InfoSesion, NombreMetodo, Resultados } from "@aquiles/protocolo";
import type { AdjuntoEntrante } from "../adjuntos";
import type { AlmacenAjustes } from "../ajustes";
import type { Auditoria } from "../auditoria";
import type { Aprendizaje } from "../aprendizaje";
import type { VistasArtefactos } from "../artefactos";
import type { PeticionAprobacion, RespuestaAprobacion, ResultadoTurno } from "../bucle";
import type { Comandos } from "../comandos";
import type { Conocimiento } from "../conocimiento";
import type { Programador } from "../cron";
import type { Herramienta, Pregunta } from "../herramientas/herramienta";
import type { Descargas } from "../locales/huggingface";
import type { ClienteMcp } from "../mcp";
import type { Objetivos } from "../objetivos";
import type { Pasarela } from "../pasarela";
import type { Plugins } from "../plugins";
import type { AlmacenSesiones, OpcionesSesion, Sesion } from "../sesiones";
import type { OpcionesServidor } from "../servidor";
import type { AdjuntoGuardado, Proveedor } from "../tipos";
import type { Voz } from "../voz";

/** Un manejador por método del protocolo; cada rutas-*.ts devuelve una parte (`satisfies Partial<Manejadores>`). */
export type Manejadores = { [M in NombreMetodo]: (params: any) => Resultados[M] | Promise<Resultados[M]> };

/** Cómo se lanza un turno: quién responde a permisos y preguntas, y quién más escucha sus eventos. */
export interface OpcionesEjecucion {
  aprobar: (p: PeticionAprobacion, senal: AbortSignal) => Promise<RespuestaAprobacion>;
  preguntar: (p: Pregunta, senal: AbortSignal) => Promise<string>;
  alEvento?: (e: Evento) => void;
  /** Herramientas de esta ejecución; por defecto, las de la sesión. */
  herramientas?: readonly Herramienta<any>[];
}

export interface ContextoServidor {
  o: OpcionesServidor;
  log: (mensaje: string) => void;
  /** Manda un evento a todas las interfaces conectadas. */
  emitir: (evento: Evento) => void;

  ajustes: AlmacenAjustes;
  sesiones: AlmacenSesiones;
  auditoria: Auditoria;
  memoria: Conocimiento["memoria"];
  skills: Conocimiento["skills"];
  indice: Conocimiento["indice"];
  registro: Conocimiento["registro"];
  aprendizaje: Aprendizaje;
  objetivos: Objetivos;
  comandos: Comandos;
  pasarela: Pasarela;
  programador: Programador;
  plugins: Plugins;
  mcp: ClienteMcp;
  voz: Voz;
  vistas: VistasArtefactos;
  descargas: Descargas;

  /** Proveedores abiertos por (nombre, modelo, esfuerzo); la clave sale de `claveProveedor`. */
  proveedores: Map<string, Proveedor>;
  claveProveedor: (nombre: string, modelo?: string, esfuerzo?: string) => string;
  /** Si el navegador está abierto, lo suelta y lo cierra (al apagarlo en los ajustes). */
  soltarNavegador: () => void;

  /** La sesión o FalloRpc sesionNoExiste. */
  obtener: (sesionId: string) => Sesion;
  /** InfoSesion con lo que vive fuera de la sesión (su objetivo). */
  vista: (s: Sesion) => InfoSesion;
  /** Emite sesion.actualizada. */
  avisar: (s: Sesion) => void;
  crearSesion: (cwd: string | undefined, x?: Partial<OpcionesSesion>) => Sesion;
  /** Guarda los adjuntos de un mensaje en la carpeta de la sesión. */
  guardarEn: (s: Sesion, entrantes: readonly AdjuntoEntrante[]) => Promise<AdjuntoGuardado[]>;
  ejecutarConAdjuntos: (s: Sesion, texto: string, x: OpcionesEjecucion, adjuntos?: AdjuntoGuardado[]) => Promise<ResultadoTurno>;
  /** Permisos y preguntas a la interfaz, en la conversación `s`. */
  aprobarEnApp: (s: Sesion) => OpcionesEjecucion["aprobar"];
  preguntarEnApp: (s: Sesion) => OpcionesEjecucion["preguntar"];
  /** Pasa el curador de skills y avisa si cambió algo. */
  curar: () => CambioCurador[];
}
