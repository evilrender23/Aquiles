/** Escritorio: solo entrega, como notificación del sistema que muestra la app. La primera línea es el título. */
import type { Motor } from "../motor";
import { type Canal, sinOpciones } from "./canal";

export class CanalEscritorio implements Canal {
  readonly id = "escritorio";
  readonly nombre = "Escritorio";
  readonly conversa = false;

  constructor(private motor: Pick<Motor, "notificar">) {}

  configurado(): boolean {
    return true;
  }

  secretos(): Record<string, boolean> {
    return {};
  }

  opciones(): Record<string, string> {
    return {};
  }

  configurar(opciones: Record<string, string>): void {
    sinOpciones(this.nombre, opciones);
  }

  async iniciar(): Promise<void> {}

  async detener(): Promise<void> {}

  async enviar(_chatId: string, texto: string): Promise<void> {
    const [primera = "", ...resto] = texto.trim().split("\n");
    const cuerpo = resto.join("\n").trim();
    this.motor.notificar(cuerpo ? { titulo: primera.trim(), texto: cuerpo } : { titulo: "Aquiles", texto: primera });
  }

  estado(): { conectado: boolean } {
    return { conectado: false };
  }
}
