/**
 * Discord: recibe por el gateway v10 (WebSocket con latido y RESUME si se cae) y envía por la API REST.
 * El `chatId` es el id del canal de Discord (un MD o un canal de un servidor).
 *
 * Sin el intent privilegiado MESSAGE_CONTENT, en los canales de servidor solo llega el texto de los mensajes que
 * mencionan al bot; en los MD llega siempre.
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

const API = "https://discord.com/api/v10";
const TOKEN = "AQUILES_DISCORD_TOKEN";
const MAX_MENSAJE = 2000;
/** GUILD_MESSAGES | DIRECT_MESSAGES. */
const INTENTS = (1 << 9) | (1 << 12);
const CIERRES_FATALES: Record<number, string> = {
  4004: "el token no es válido",
  4010: "shard no válido",
  4011: "el bot necesita sharding",
  4012: "versión de la API no válida",
  4013: "intents no válidos",
  4014: "intents no permitidos: actívalos en el portal de desarrolladores",
};
/** Tras estos cierres la sesión no se puede reanudar: hay que identificarse de nuevo. */
const CIERRES_SIN_SESION = new Set([4007, 4009]);
/** Cierre propio para reconectar: con 1000 Discord invalidaría la sesión y no se podría reanudar. */
const CIERRE_RECONECTAR = 4000;

type AlBoton = (chatId: string, idBotones: string, valor: string) => void;

interface Paquete {
  op: number;
  d: any;
  s?: number | null;
  t?: string | null;
}

export class CanalDiscord implements Canal {
  readonly id = "discord";
  readonly nombre = "Discord";
  readonly conversa = true;
  private control?: AbortController;
  private conectado = false;
  private error?: string;
  private gateway?: string;
  private sesion?: { id: string; url: string };
  private secuencia: number | null = null;
  private botId?: string;

  /** `api`: URL base de la API REST (un servidor falso en los tests); el gateway sale de `GET /gateway/bot`. */
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

  async iniciar(alMensaje: (m: MensajeEntrante) => void, alBoton: AlBoton): Promise<void> {
    await this.detener();
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
    this.sesion = undefined;
    this.secuencia = null;
  }

  async enviar(chatId: string, texto: string, botones?: Botones): Promise<void> {
    const trozos = trocear(texto, MAX_MENSAJE);
    for (const [i, trozo] of trozos.entries()) {
      const componentes = botones && i === trozos.length - 1 ? { components: filas(botones) } : {};
      // Sin menciones: el agente no debe poder avisar a @everyone ni a nadie.
      await this.rest("POST", `/channels/${encodeURIComponent(chatId)}/messages`, { content: trozo, allowed_mentions: { parse: [] }, ...componentes });
    }
  }

  async escribiendo(chatId: string): Promise<void> {
    await this.rest("POST", `/channels/${encodeURIComponent(chatId)}/typing`);
  }

  estado(): { conectado: boolean; error?: string } {
    return { conectado: this.conectado, ...(this.error ? { error: this.error } : {}) };
  }

  /** Abre el gateway y espera a READY (o RESUMED). Si se cae después, llama a `caer`. */
  private async conectar(senal: AbortSignal, alMensaje: (m: MensajeEntrante) => void, alBoton: AlBoton, caer: () => void): Promise<void> {
    this.gateway ??= (await this.rest<{ url: string }>("GET", "/gateway/bot")).url;
    if (senal.aborted) return;
    const token = process.env[TOKEN] ?? "";
    const ws = new WebSocket(`${this.sesion?.url ?? this.gateway}/?v=10&encoding=json`);
    const enviar = (op: number, d: unknown) => ws.send(JSON.stringify({ op, d }));
    const cerrar = () => ws.close(1000);
    senal.addEventListener("abort", cerrar, { once: true });
    let listo = false;
    let primerLatido: ReturnType<typeof setTimeout> | undefined;
    let latidos: ReturnType<typeof setInterval> | undefined;
    let sinRespuesta = false;

    await new Promise<void>((ok, mal) => {
      ws.onmessage = (m) => {
        const p = JSON.parse(String(m.data)) as Paquete;
        if (typeof p.s === "number") this.secuencia = p.s;
        switch (p.op) {
          case 10: {
            // Un latido sin respuesta antes del siguiente es una conexión muerta: se reconecta.
            const latir = () => {
              if (sinRespuesta) return ws.close(CIERRE_RECONECTAR);
              sinRespuesta = true;
              enviar(1, this.secuencia);
            };
            const intervalo = Number(p.d.heartbeat_interval);
            primerLatido = setTimeout(() => {
              latir();
              latidos = setInterval(latir, intervalo);
            }, intervalo * Math.random());
            if (this.sesion) enviar(6, { token, session_id: this.sesion.id, seq: this.secuencia });
            else enviar(2, { token, intents: INTENTS, properties: { os: process.platform, browser: "aquiles", device: "aquiles" } });
            break;
          }
          case 11:
            sinRespuesta = false;
            break;
          case 1:
            enviar(1, this.secuencia);
            break;
          case 7:
            ws.close(CIERRE_RECONECTAR);
            break;
          case 9:
            if (!p.d) {
              this.sesion = undefined;
              this.secuencia = null;
            }
            ws.close(CIERRE_RECONECTAR);
            break;
          case 0:
            if (p.t === "READY") {
              this.sesion = { id: p.d.session_id, url: p.d.resume_gateway_url };
              this.botId = p.d.user?.id;
            }
            if (p.t === "READY" || p.t === "RESUMED") {
              listo = true;
              this.conectado = true;
              this.error = undefined;
              ok();
            } else {
              this.despachar(p.t, p.d, alMensaje, alBoton);
            }
        }
      };
      ws.onclose = (ev) => {
        clearTimeout(primerLatido);
        clearInterval(latidos);
        senal.removeEventListener("abort", cerrar);
        this.conectado = false;
        if (CIERRES_SIN_SESION.has(ev.code)) {
          this.sesion = undefined;
          this.secuencia = null;
        }
        if (senal.aborted) return ok();
        const fatal = CIERRES_FATALES[ev.code];
        const fallo = fatal ? new ErrorCanal(`Discord: ${fatal}`) : new Error(`Discord cerró la conexión (${ev.code})`);
        this.error = fallo.message;
        if (!listo) mal(fallo);
        else if (!fatal) caer();
      };
    });
  }

  private despachar(tipo: string | null | undefined, d: any, alMensaje: (m: MensajeEntrante) => void, alBoton: AlBoton): void {
    if (tipo === "MESSAGE_CREATE") {
      if (!d.author || d.author.bot || d.author.id === this.botId) return;
      const texto = String(d.content ?? "")
        .replace(new RegExp(`<@!?${this.botId}>`, "g"), "")
        .trim();
      if (texto) alMensaje({ chatId: d.channel_id, nombre: d.author.global_name ?? d.author.username ?? d.channel_id, texto });
    } else if (tipo === "INTERACTION_CREATE" && d.type === 3) {
      // Tipo 6: «ya lo he visto», sin cambiar el mensaje; sin contestar, Discord marca la interacción como fallida.
      void this.rest("POST", `/interactions/${d.id}/${d.token}/callback`, { type: 6 }).catch(() => {});
      const boton = leerBoton(d.data?.custom_id ?? "");
      const canal = d.channel_id ?? d.channel?.id;
      if (boton && canal) alBoton(canal, boton.id, boton.valor);
    }
  }

  private async rest<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
    const token = process.env[TOKEN];
    if (!token) throw new ErrorCanal(`Falta ${TOKEN}`);
    const r = await fetch(`${this.o.api ?? API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (aquiles, 1)" },
      ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 401) throw new ErrorCanal("Discord: el token no es válido");
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { message?: string };
      throw new Error(`Discord ${r.status}: ${d.message ?? r.statusText}`);
    }
    return (r.status === 204 ? undefined : await r.json()) as T;
  }
}

/** Botones de Discord: como mucho cinco por fila. */
function filas(b: Botones): unknown[] {
  const botones = b.opciones.map((o) => ({ type: 2, style: 2, label: o.texto.slice(0, 80), custom_id: datoBoton(b.id, o.valor) }));
  const lista: unknown[] = [];
  for (let i = 0; i < botones.length; i += 5) lista.push({ type: 1, components: botones.slice(i, i + 5) });
  return lista;
}
