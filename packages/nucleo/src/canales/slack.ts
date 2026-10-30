/**
 * Slack: recibe por Socket Mode (WebSocket abierto con `apps.connections.open` y el token de app xapp-…) y envía
 * con `chat.postMessage` y el token del bot xoxb-…. Cada envelope se confirma con su `envelope_id`; si no, Slack
 * lo reenvía. Para solo entregar basta con el token del bot.
 */
import {
  type Botones,
  type Canal,
  datoBoton,
  ErrorCanal,
  leerBoton,
  type MensajeEntrante,
  mensajeDe,
  reconectar,
  sinOpciones,
  trocear,
} from "./canal";

const API = "https://slack.com/api";
const TOKEN = "AQUILES_SLACK_TOKEN";
const TOKEN_APP = "AQUILES_SLACK_APP_TOKEN";
/** Límite del texto de un bloque `section`. */
const MAX_MENSAJE = 3000;
const ERRORES_FATALES = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type", "missing_scope"]);

type AlBoton = (chatId: string, idBotones: string, valor: string) => void;

interface Sobre {
  type?: string;
  envelope_id?: string;
  payload?: any;
}

export class CanalSlack implements Canal {
  readonly id = "slack";
  readonly nombre = "Slack";
  readonly conversa = true;
  private control?: AbortController;
  private conectado = false;
  private error?: string;
  private nombres = new Map<string, string>();

  /** `api`: URL base de la Web API (un servidor falso en los tests). */
  constructor(private o: { api?: string } = {}) {}

  configurado(): boolean {
    return Boolean(process.env[TOKEN]);
  }

  secretos(): Record<string, boolean> {
    return { [TOKEN]: Boolean(process.env[TOKEN]), [TOKEN_APP]: Boolean(process.env[TOKEN_APP]) };
  }

  opciones(): Record<string, string> {
    return {};
  }

  configurar(opciones: Record<string, string>): void {
    sinOpciones(this.nombre, opciones);
  }

  async iniciar(alMensaje: (m: MensajeEntrante) => void, alBoton: AlBoton): Promise<void> {
    await this.detener();
    if (!process.env[TOKEN_APP]) {
      this.error = `Falta ${TOKEN_APP} (token de app xapp-… con Socket Mode) para recibir mensajes`;
      throw new ErrorCanal(this.error);
    }
    const control = new AbortController();
    this.control = control;
    const conectar = (): Promise<void> => this.conectar(control.signal, alMensaje, alBoton, caer);
    const caer = () => void reconectar(conectar, control.signal, (e) => (this.error = mensajeDe(e)));
    try {
      await conectar();
    } catch (e) {
      this.error = mensajeDe(e);
      if (e instanceof ErrorCanal) throw e;
      caer();
    }
  }

  async detener(): Promise<void> {
    this.control?.abort();
    this.control = undefined;
    this.conectado = false;
  }

  async enviar(chatId: string, texto: string, botones?: Botones): Promise<void> {
    const trozos = trocear(escapar(texto), MAX_MENSAJE);
    for (const [i, trozo] of trozos.entries()) {
      const bloques =
        botones && i === trozos.length - 1
          ? {
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: trozo } },
                {
                  type: "actions",
                  block_id: botones.id,
                  elements: botones.opciones.map((o) => ({
                    type: "button",
                    text: { type: "plain_text", text: o.texto.slice(0, 75) },
                    action_id: datoBoton(botones.id, o.valor),
                    value: o.valor,
                  })),
                },
              ],
            }
          : {};
      await this.api("chat.postMessage", { channel: chatId, text: trozo, ...bloques });
    }
  }

  estado(): { conectado: boolean; error?: string } {
    return { conectado: this.conectado, ...(this.error ? { error: this.error } : {}) };
  }

  /** Abre una conexión de Socket Mode y espera al `hello`. Si se cae después, llama a `caer`. */
  private async conectar(senal: AbortSignal, alMensaje: (m: MensajeEntrante) => void, alBoton: AlBoton, caer: () => void): Promise<void> {
    const { url } = await this.api<{ url: string }>("apps.connections.open", {}, TOKEN_APP);
    if (senal.aborted) return;
    const ws = new WebSocket(url);
    const cerrar = () => ws.close();
    senal.addEventListener("abort", cerrar, { once: true });
    let listo = false;
    await new Promise<void>((ok, mal) => {
      ws.onmessage = (m) => {
        const sobre = JSON.parse(String(m.data)) as Sobre;
        if (sobre.envelope_id) ws.send(JSON.stringify({ envelope_id: sobre.envelope_id }));
        if (sobre.type === "hello") {
          listo = true;
          this.conectado = true;
          this.error = undefined;
          ok();
        } else if (sobre.type === "disconnect") {
          // Slack renueva las conexiones cada pocas horas: se abre otra.
          ws.close();
        } else if (sobre.type === "events_api") {
          void this.mensaje(sobre.payload?.event, alMensaje);
        } else if (sobre.type === "interactive") {
          this.boton(sobre.payload, alBoton);
        }
      };
      ws.onclose = () => {
        senal.removeEventListener("abort", cerrar);
        this.conectado = false;
        if (senal.aborted) return ok();
        if (!listo) return mal(new Error("Slack cerró la conexión antes de saludar"));
        caer();
      };
    });
  }

  private async mensaje(e: any, alMensaje: (m: MensajeEntrante) => void): Promise<void> {
    // Sin bot_id ni subtype: ni los mensajes del propio bot ni ediciones, borrados o avisos del canal.
    if (e?.type !== "message" || e.bot_id || e.subtype || !e.user || !e.channel) return;
    const texto = desescapar(String(e.text ?? "").replace(/^<@[A-Z0-9]+>\s*/, "")).trim();
    if (texto) alMensaje({ chatId: e.channel, nombre: await this.nombreDe(e.user), texto });
  }

  private boton(p: any, alBoton: AlBoton): void {
    if (p?.type !== "block_actions") return;
    const canal = p.channel?.id ?? p.container?.channel_id;
    for (const a of p.actions ?? []) {
      const boton = leerBoton(a.action_id ?? "");
      if (boton && canal) alBoton(canal, boton.id, boton.valor);
    }
  }

  /** Nombre visible de un usuario (necesita el permiso users:read; si falta, se usa el id). */
  private async nombreDe(usuario: string): Promise<string> {
    let nombre = this.nombres.get(usuario);
    if (nombre === undefined) {
      nombre = await this.api<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string } } }>("users.info", { user: usuario })
        .then((d) => d.user?.profile?.display_name || d.user?.real_name || d.user?.name || usuario)
        .catch(() => usuario);
      this.nombres.set(usuario, nombre);
    }
    return nombre;
  }

  /** Llamada a la Web API como formulario, que todos sus métodos aceptan (no todos aceptan JSON). */
  private async api<T>(metodo: string, args: Record<string, unknown>, variable = TOKEN): Promise<T> {
    const token = process.env[variable];
    if (!token) throw new ErrorCanal(`Falta ${variable}`);
    const cuerpo = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    const r = await fetch(`${this.o.api ?? API}/${metodo}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: cuerpo,
      signal: AbortSignal.timeout(15_000),
    });
    const d = (await r.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    if (d.ok) return d;
    const error = d.error ?? `HTTP ${r.status}`;
    if (ERRORES_FATALES.has(error)) throw new ErrorCanal(`Slack: ${error}`);
    throw new Error(`Slack: ${error}`);
  }
}

/** Slack interpreta &, < y > (enlaces y menciones): en texto plano van escapados. */
function escapar(texto: string): string {
  return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function desescapar(texto: string): string {
  return texto.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
