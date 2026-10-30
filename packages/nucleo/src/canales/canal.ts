/**
 * Lo que la pasarela necesita de un canal de mensajería. Los secretos (tokens, claves) se leen de `process.env` al
 * usarlos, porque la app los pone desde el llavero y pueden cambiar con el núcleo en marcha (luego se llama a
 * `Pasarela.reiniciar`). Las opciones no secretas las guarda la pasarela; el canal solo las valida y las usa.
 */
import type { IdCanal } from "@aquiles/protocolo";

export interface MensajeEntrante {
  chatId: string;
  /** Nombre del chat o de quien escribe, para mostrarlo en la app. */
  nombre: string;
  texto: string;
}

/** Botones bajo un mensaje; al pulsar uno llega `alBoton(chatId, id, valor)`. */
export interface Botones {
  id: string;
  opciones: { valor: string; texto: string }[];
}

export interface Canal {
  readonly id: IdCanal;
  readonly nombre: string;
  /** Recibe mensajes; si no, solo entrega. */
  readonly conversa: boolean;
  configurado(): boolean;
  /** Secretos que usa: nombre de la variable de entorno → si está puesta. */
  secretos(): Record<string, boolean>;
  opciones(): Record<string, string>;
  /** Valida y guarda las opciones no secretas (el canal no escribe en disco: lo hace la pasarela). */
  configurar(opciones: Record<string, string>): void;
  iniciar(alMensaje: (m: MensajeEntrante) => void, alBoton: (chatId: string, idBotones: string, valor: string) => void): Promise<void>;
  detener(): Promise<void>;
  enviar(chatId: string, texto: string, botones?: Botones): Promise<void>;
  escribiendo?(chatId: string): Promise<void>;
  estado(): { conectado: boolean; error?: string };
}

/** Error de configuración o de credenciales: reintentar no sirve hasta que cambie algo. */
export class ErrorCanal extends Error {}

export function mensajeDe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Exige que no haya opciones (los canales cuyo único ajuste es un secreto). */
export function sinOpciones(nombre: string, opciones: Record<string, string>): void {
  const claves = Object.keys(opciones);
  if (claves.length) throw new ErrorCanal(`${nombre} no tiene opciones (${claves.join(", ")}); su token va en el llavero`);
}

/** Parte un texto en trozos de como mucho `max` caracteres, mejor por un salto de línea o un espacio. */
export function trocear(texto: string, max: number): string[] {
  const trozos: string[] = [];
  let resto = texto;
  while (resto.length > max) {
    let corte = resto.lastIndexOf("\n", max);
    if (corte < max / 2) corte = resto.lastIndexOf(" ", max);
    if (corte < max / 2) corte = max;
    // No partir un carácter que ocupa dos unidades UTF-16 (emojis y similares).
    const codigo = resto.charCodeAt(corte - 1);
    if (codigo >= 0xd800 && codigo <= 0xdbff) corte -= 1;
    trozos.push(resto.slice(0, corte));
    resto = resto.slice(corte).replace(/^[\n ]/, "");
  }
  if (resto || !trozos.length) trozos.push(resto);
  return trozos;
}

/** Dato de un botón (`callback_data`, `custom_id`, `action_id`): id del grupo y valor elegido. */
export function datoBoton(idBotones: string, valor: string): string {
  return `${idBotones}|${valor}`;
}

export function leerBoton(dato: string): { id: string; valor: string } | undefined {
  const i = dato.indexOf("|");
  return i > 0 ? { id: dato.slice(0, i), valor: dato.slice(i + 1) } : undefined;
}

/** Espera antes del reintento número `intento` (desde 0): 1 s, 2 s, 4 s… hasta 1 min. */
export function esperaReintento(intento: number): number {
  return Math.min(1000 * 2 ** intento, 60_000);
}

/** Espera `ms`; termina antes si se aborta la señal (sin error: quien llama mira `senal.aborted`). */
export function dormir(ms: number, senal: AbortSignal): Promise<void> {
  return new Promise((ok) => {
    if (senal.aborted) return ok();
    const t = setTimeout(fin, ms);
    function fin() {
      clearTimeout(t);
      senal.removeEventListener("abort", fin);
      ok();
    }
    senal.addEventListener("abort", fin, { once: true });
  });
}

/** Vuelve a conectar con espera creciente hasta lograrlo, pararse o dar con un error sin remedio. */
export async function reconectar(conectar: () => Promise<void>, senal: AbortSignal, alFallar: (e: unknown) => void): Promise<void> {
  for (let intento = 0; !senal.aborted; intento++) {
    await dormir(esperaReintento(intento), senal);
    if (senal.aborted) return;
    try {
      return await conectar();
    } catch (e) {
      alFallar(e);
      if (e instanceof ErrorCanal) return;
    }
  }
}
