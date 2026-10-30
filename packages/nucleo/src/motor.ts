/**
 * Lo que el servidor ofrece a las piezas que lanzan turnos sin la interfaz delante: tareas programadas (cron.ts)
 * y la pasarela de canales (pasarela.ts). Lo implementa servidor.ts.
 */
import type { Ajustes, Evento, InfoSesion, ModoAprobacion } from "@aquiles/protocolo";
import type { AdjuntoEntrante } from "./adjuntos";
import type { PeticionAprobacion, RespuestaAprobacion, ResultadoTurno } from "./bucle";
import type { Pregunta } from "./herramientas/herramienta";

export interface PeticionTurno {
  /** Sesión existente; si falta, se crea una con `nueva`. */
  sesionId?: string;
  nueva?: {
    cwd?: string;
    proveedor?: string;
    modelo?: string;
    modoAprobacion?: ModoAprobacion;
    titulo?: string;
    origen?: InfoSesion["origen"];
  };
  texto: string;
  /** Ficheros del mensaje (p. ej. los que llegan por un canal); se guardan como los de prompt.enviar. Uno que no vale hace fallar el turno. */
  adjuntos?: AdjuntoEntrante[];
  /** Quién responde a los permisos; si falta, se deniega todo lo que pida permiso. */
  aprobar?: (p: PeticionAprobacion) => Promise<RespuestaAprobacion>;
  /** Quién responde a las preguntas del agente; si falta, reciben «No hay nadie para responder; decide tú». */
  preguntar?: (p: Pregunta) => Promise<string>;
  /** Eventos del turno (p. ej. para mostrar «escribiendo…» en un chat). Una sesión nueva llega primero con `sesion.actualizada`. */
  alEvento?: (e: Evento) => void;
}

export interface Motor {
  /** Lanza un turno y espera a que termine. Falla si la sesión no existe, ya está trabajando o un adjunto no vale. */
  turno(p: PeticionTurno): Promise<{ sesionId: string; resultado: ResultadoTurno }>;
  existeSesion(sesionId: string): boolean;
  /** La sesión tiene un turno en marcha. */
  trabajando(sesionId: string): boolean;
  /** Añade un mensaje al turno en marcha (steer); false si no hay turno. */
  steer(sesionId: string, texto: string): boolean;
  /** Para el turno en marcha; false si no había. */
  parar(sesionId: string): boolean;
  /** Aviso para la app de escritorio (notificación del sistema). */
  notificar(n: { titulo: string; texto: string; sesionId?: string }): void;
  /** Avisa a la interfaz de un cambio (cron.actualizado, canales.actualizados, cron.ejecucion…). */
  emitir(e: Evento): void;
  ajustes(): Ajustes;
  log(mensaje: string): void;
}
