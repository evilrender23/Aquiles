/** Terminal: solo entrega, al registro del núcleo y a la salida estándar (útil con la CLI o al depurar). */
import type { Motor } from "../motor";
import { type Canal, sinOpciones } from "./canal";

export class CanalTerminal implements Canal {
  readonly id = "terminal";
  readonly nombre = "Terminal";
  readonly conversa = false;

  constructor(private motor: Pick<Motor, "log">) {}

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
    this.motor.log(texto);
    console.log(texto);
  }

  estado(): { conectado: boolean } {
    return { conectado: false };
  }
}
