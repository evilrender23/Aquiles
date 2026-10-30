/**
 * Telegram por la Bot API. Recibe con long polling (`getUpdates`) y envía en texto plano.
 * El `offset` solo avanza con updates ya recibidos, así que tras un fallo de red se vuelven a pedir los mismos.
 */
import {
  type Botones,
  type Canal,
  datoBoton,
  dormir,
  ErrorCanal,
  esperaReintento,
  leerBoton,
  type MensajeEntrante,
  mensajeDe,
  sinOpciones,
  trocear,
} from "./canal";

const API = "https://api.telegram.org";
const TOKEN = "AQUILES_TELEGRAM_TOKEN";
const MAX_MENSAJE = 4000;
const ESPERA_SONDEO_S = 30;

interface Chat {
  id: number;
  type?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface Update {
  update_id: number;
  message?: { chat: Chat; from?: { is_bot?: boolean }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: Chat } };
}

export class CanalTelegram implements Canal {
  readonly id = "telegram";
  readonly nombre = "Telegram";
  readonly conversa = true;
  private control?: AbortController;
  private conectado = false;
  private error?: string;
  private offset = 0;

  /** `api`: URL base de la Bot API (un servidor falso en los tests). */
  constructor(private o: { api?: string } = {}) {}

  configurado(): boolean {
    return Boolean(process.env[TOKEN]);
  }

  secretos(): Record<string, boolean> {
    return { [TOKEN]: this.configurado() };
  }

  opciones(): Record<string, string> {
    return {};
  }

  configurar(opciones: Record<string, string>): void {
    sinOpciones(this.nombre, opciones);
  }

  async iniciar(alMensaje: (m: MensajeEntrante) => void, alBoton: (chatId: string, idBotones: string, valor: string) => void): Promise<void> {
    await this.detener();
    const control = new AbortController();
    this.control = control;
    try {
      await this.llamar("getMe", {}, control.signal);
      this.conectado = true;
      this.error = undefined;
    } catch (e) {
      this.error = mensajeDe(e);
      if (e instanceof ErrorCanal) throw e;
    }
    void this.escuchar(control.signal, alMensaje, alBoton);
  }

  async detener(): Promise<void> {
    this.control?.abort();
    this.control = undefined;
    this.conectado = false;
  }

  async enviar(chatId: string, texto: string, botones?: Botones): Promise<void> {
    const trozos = trocear(texto, MAX_MENSAJE);
    for (const [i, trozo] of trozos.entries()) {
      const teclado = botones && i === trozos.length - 1 ? { reply_markup: { inline_keyboard: teclas(botones) } } : {};
      await this.llamar("sendMessage", { chat_id: chatId, text: trozo, ...teclado });
    }
  }

  async escribiendo(chatId: string): Promise<void> {
    await this.llamar("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  estado(): { conectado: boolean; error?: string } {
    return { conectado: this.conectado, ...(this.error ? { error: this.error } : {}) };
  }

  private async escuchar(
    senal: AbortSignal,
    alMensaje: (m: MensajeEntrante) => void,
    alBoton: (chatId: string, idBotones: string, valor: string) => void,
  ): Promise<void> {
    for (let fallos = 0; !senal.aborted; ) {
      try {
        const updates = await this.llamar<Update[]>(
          "getUpdates",
          { offset: this.offset, timeout: ESPERA_SONDEO_S, allowed_updates: ["message", "callback_query"] },
          senal,
          (ESPERA_SONDEO_S + 15) * 1000,
        );
        this.conectado = true;
        this.error = undefined;
        fallos = 0;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          this.procesar(u, alMensaje, alBoton);
        }
      } catch (e) {
        if (senal.aborted) return;
        this.conectado = false;
        this.error = mensajeDe(e);
        if (e instanceof ErrorCanal) return;
        await dormir(esperaReintento(fallos++), senal);
      }
    }
  }

  private procesar(u: Update, alMensaje: (m: MensajeEntrante) => void, alBoton: (chatId: string, idBotones: string, valor: string) => void): void {
    const m = u.message;
    if (m?.text && !m.from?.is_bot) {
      alMensaje({ chatId: String(m.chat.id), nombre: nombreChat(m.chat), texto: m.text });
      return;
    }
    const q = u.callback_query;
    if (!q) return;
    // Sin contestar, Telegram deja el botón «cargando» unos segundos.
    void this.llamar("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    const boton = leerBoton(q.data ?? "");
    if (boton && q.message) alBoton(String(q.message.chat.id), boton.id, boton.valor);
  }

  private async llamar<T>(metodo: string, params: Record<string, unknown>, senal?: AbortSignal, plazoMs = 15_000): Promise<T> {
    const token = process.env[TOKEN];
    if (!token) throw new ErrorCanal(`Falta ${TOKEN}`);
    const plazo = AbortSignal.timeout(plazoMs);
    let r: Response;
    try {
      r = await fetch(`${this.o.api ?? API}/bot${token}/${metodo}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: senal ? AbortSignal.any([senal, plazo]) : plazo,
      });
    } catch (e) {
      // El token va en la URL: que no acabe en un mensaje de error.
      throw new Error(`Telegram: ${mensajeDe(e).replaceAll(token, "…")}`);
    }
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (d.ok) return d.result as T;
    if (r.status === 401 || r.status === 404) throw new ErrorCanal("Telegram: el token no es válido");
    throw new Error(`Telegram: ${d.description ?? `HTTP ${r.status}`}`);
  }
}

function nombreChat(c: Chat): string {
  return c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || String(c.id));
}

/** Pocas opciones en una fila; si son más, una por fila para que se lean enteras. */
function teclas(b: Botones): { text: string; callback_data: string }[][] {
  const teclas = b.opciones.map((o) => ({ text: o.texto, callback_data: datoBoton(b.id, o.valor) }));
  return teclas.length <= 3 ? [teclas] : teclas.map((t) => [t]);
}
