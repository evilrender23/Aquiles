/** Discord, Slack y correo contra servidores falsos en 127.0.0.1; escritorio, terminal y utilidades. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { createServer as crearServidorTls, TLSSocket } from "node:tls";
import type { Ajustes, Evento } from "@aquiles/protocolo";
import type { ServerWebSocket } from "bun";
import { type Botones, ErrorCanal, type MensajeEntrante, trocear } from "../src/canales/canal";
import { CanalCorreo } from "../src/canales/correo";
import { CanalDiscord } from "../src/canales/discord";
import { CanalEscritorio } from "../src/canales/escritorio";
import { CanalSlack } from "../src/canales/slack";
import { CanalTerminal } from "../src/canales/terminal";
import type { Motor, PeticionTurno } from "../src/motor";
import { Pasarela } from "../src/pasarela";

const DISCORD = "token-discord-de-prueba";
const SLACK_BOT = "xoxb-de-prueba";
const SLACK_APP = "xapp-de-prueba";
process.env.AQUILES_DISCORD_TOKEN = DISCORD;
process.env.AQUILES_SLACK_TOKEN = SLACK_BOT;
process.env.AQUILES_SLACK_APP_TOKEN = SLACK_APP;
process.env.AQUILES_CORREO_CLAVE = "clave-secreta";

/** Certificado propio para localhost y 127.0.0.1, válido hasta 2126: solo para estos tests. */
const CERT = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUGgAwIBAgIUdZW5kapYZT/DS8wqQhw65+W+PEcwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAzMDA0MjgyN1oYDzIxMjYxMDA2
MDQyODI3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARstHWGnK2CnVjH+nX/HNurOYx04CAJo7A81+9edRCUKD650lFX5pZk
279E39hwTqw6n/Hc8PBlgNTFOsro2O4Po28wbTAdBgNVHQ4EFgQUc4fB6Rn7EvmP
Wupkqe21nSLj0m4wHwYDVR0jBBgwFoAUc4fB6Rn7EvmPWupkqe21nSLj0m4wDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSQAwRgIhALMvK3iSJCzqvN9vSTz92yRFQrpx2u68rFRntabDzpeMAiEA
q7elOQ1P9mDoUOYTEna9ffM7jX6IZ1SnP8d13QtMvbM=
-----END CERTIFICATE-----`;
const CLAVE_CERT = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgdCrF2/JuUyVy71RX
yuznn/tVP5AJIThSD9sa7HvE33+hRANCAARstHWGnK2CnVjH+nX/HNurOYx04CAJ
o7A81+9edRCUKD650lFX5pZk279E39hwTqw6n/Hc8PBlgNTFOsro2O4P
-----END PRIVATE KEY-----`;

const limpiezas: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of limpiezas.splice(0)) await f();
});

async function hasta<R>(f: () => R | undefined | false, ms = 4000): Promise<R> {
  const limite = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > limite) throw new Error("no llegó a tiempo");
    await Bun.sleep(5);
  }
}

/** Motor mínimo: contesta «eco: …» y apunta los turnos. */
class MotorEco implements Motor {
  turnos: PeticionTurno[] = [];
  notificaciones: { titulo: string; texto: string }[] = [];
  logs: string[] = [];
  private n = 0;
  async turno(p: PeticionTurno) {
    this.turnos.push(p);
    return { sesionId: p.sesionId ?? `s${++this.n}`, resultado: { motivo: "fin" as const, texto: `eco: ${p.texto}`, uso: { entrada: 0, salida: 0 } } };
  }
  existeSesion = () => true;
  trabajando = () => false;
  steer = () => false;
  parar = () => false;
  notificar(n: { titulo: string; texto: string }) {
    this.notificaciones.push(n);
  }
  emitir(_e: Evento) {}
  /** Solo lo que leen el programador y la pasarela. */
  ajustes(): Ajustes {
    return { proveedor: "simulado", modoAprobacion: "preguntar-ejecutar", carpeta: "C:/trabajo" } as Ajustes;
  }
  log(m: string) {
    this.logs.push(m);
  }
}

function recogedor() {
  const mensajes: MensajeEntrante[] = [];
  const botones: [string, string, string][] = [];
  return { mensajes, botones, alMensaje: (m: MensajeEntrante) => mensajes.push(m), alBoton: (c: string, id: string, v: string) => botones.push([c, id, v]) };
}

const BOTONES: Botones = { id: "b1", opciones: [{ valor: "permitir", texto: "Permitir" }, { valor: "denegar", texto: "Denegar" }] };

// ── Utilidades ──────────────────────────────────────────────────────────────

test("trocear prefiere saltos de línea y no parte emojis", () => {
  expect(trocear("corto", 10)).toEqual(["corto"]);
  expect(trocear("", 10)).toEqual([""]);
  expect(trocear("uno dos\ntres cuatro", 12)).toEqual(["uno dos", "tres cuatro"]);
  expect(trocear("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  const conEmoji = `abc${"😀".repeat(3)}`;
  const trozos = trocear(conEmoji, 4);
  expect(trozos.join("")).toBe(conEmoji);
  expect(trozos.every((t) => !/[\ud800-\udbff]$/.test(t))).toBe(true);
});

test("escritorio notifica con la primera línea de título; terminal escribe en el registro", async () => {
  const motor = new MotorEco();
  await new CanalEscritorio(motor).enviar("", "Informe\n\nTodo bien.");
  await new CanalEscritorio(motor).enviar("", "Solo una línea");
  expect(motor.notificaciones).toEqual([{ titulo: "Informe", texto: "Todo bien." }, { titulo: "Aquiles", texto: "Solo una línea" }]);
  const salida = spyOn(console, "log").mockImplementation(() => {});
  try {
    await new CanalTerminal(motor).enviar("", "a la terminal");
    expect(salida).toHaveBeenCalledWith("a la terminal");
  } finally {
    salida.mockRestore();
  }
  expect(motor.logs).toContain("a la terminal");
  expect(() => new CanalEscritorio(motor).configurar({ x: "1" })).toThrow(ErrorCanal);
});

// ── Discord ─────────────────────────────────────────────────────────────────

function discordFalso() {
  const rest: { metodo: string; ruta: string; cuerpo: any }[] = [];
  const gateway: any[] = [];
  const rutasWs: string[] = [];
  let ws: ServerWebSocket<{ ruta: string }> | undefined;
  let s = 0;
  const servidor = Bun.serve<{ ruta: string }>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/gw")) return srv.upgrade(req, { data: { ruta: url.pathname } }) ? undefined : new Response("", { status: 400 });
      if (req.headers.get("authorization") !== `Bot ${DISCORD}`) return Response.json({ message: "401: Unauthorized" }, { status: 401 });
      rest.push({ metodo: req.method, ruta: url.pathname, cuerpo: req.method === "GET" ? undefined : await req.json().catch(() => undefined) });
      if (url.pathname === "/api/v10/gateway/bot") return Response.json({ url: `ws://127.0.0.1:${srv.port}/gw` });
      if (url.pathname.endsWith("/callback") || url.pathname.endsWith("/typing")) return new Response(null, { status: 204 });
      return Response.json({ id: "m1" });
    },
    websocket: {
      open(socket) {
        ws = socket;
        rutasWs.push(socket.data.ruta);
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
      },
      message(socket, m) {
        const p = JSON.parse(String(m));
        gateway.push(p);
        const resume = `ws://127.0.0.1:${servidor.port}/gw-reanudar`;
        if (p.op === 2) socket.send(JSON.stringify({ op: 0, s: ++s, t: "READY", d: { session_id: "ses1", resume_gateway_url: resume, user: { id: "999" } } }));
        if (p.op === 6) socket.send(JSON.stringify({ op: 0, s: ++s, t: "RESUMED", d: {} }));
      },
    },
  });
  return {
    api: `http://127.0.0.1:${servidor.port}/api/v10`,
    rest,
    gateway,
    rutasWs,
    despachar: (t: string, d: unknown) => ws?.send(JSON.stringify({ op: 0, s: ++s, t, d })),
    cortar: () => ws?.close(4000, "corte"),
    cerrar: () => servidor.stop(true),
  };
}

test("Discord: IDENTIFY, recibir mensajes de usuarios, botones, envío en trozos y RESUME", async () => {
  const dc = discordFalso();
  const canal = new CanalDiscord({ api: dc.api });
  limpiezas.push(() => canal.detener(), () => dc.cerrar());
  const r = recogedor();
  await canal.iniciar(r.alMensaje, r.alBoton);
  expect(canal.estado()).toEqual({ conectado: true });
  expect(dc.gateway[0]).toMatchObject({ op: 2, d: { token: DISCORD, intents: (1 << 9) | (1 << 12) } });

  const autor = { id: "1", username: "ana", global_name: "Ana" };
  dc.despachar("MESSAGE_CREATE", { id: "x1", channel_id: "c1", author: { id: "5", username: "otro", bot: true }, content: "soy un bot" });
  dc.despachar("MESSAGE_CREATE", { id: "x2", channel_id: "c1", author: { id: "999", username: "aquiles" }, content: "soy yo" });
  dc.despachar("MESSAGE_CREATE", { id: "x3", channel_id: "c1", author: autor, content: "<@999> hola" });
  await hasta(() => r.mensajes.length);
  expect(r.mensajes).toEqual([{ chatId: "c1", nombre: "Ana", texto: "hola" }]);

  await canal.enviar("c1", `${"a".repeat(1900)}\n${"b".repeat(1900)}\n${"c".repeat(500)}`, BOTONES);
  const envios = dc.rest.filter((x) => x.ruta === "/api/v10/channels/c1/messages");
  expect(envios.map((x) => x.cuerpo.content.length)).toEqual([1900, 1900, 500]);
  expect(envios.every((x) => x.cuerpo.allowed_mentions.parse.length === 0)).toBe(true);
  expect(envios[0]!.cuerpo.components).toBeUndefined();
  expect(envios[2]!.cuerpo.components).toEqual([
    { type: 1, components: [{ type: 2, style: 2, label: "Permitir", custom_id: "b1|permitir" }, { type: 2, style: 2, label: "Denegar", custom_id: "b1|denegar" }] },
  ]);

  dc.despachar("INTERACTION_CREATE", { id: "i1", token: "tk", type: 3, channel_id: "c1", data: { custom_id: "b1|permitir" } });
  await hasta(() => r.botones.length);
  expect(r.botones).toEqual([["c1", "b1", "permitir"]]);
  const respuesta = await hasta(() => dc.rest.find((x) => x.ruta === "/api/v10/interactions/i1/tk/callback"));
  expect(respuesta.cuerpo).toEqual({ type: 6 });

  await canal.escribiendo("c1");
  expect(dc.rest.some((x) => x.ruta === "/api/v10/channels/c1/typing")).toBe(true);

  // Se cae la conexión: vuelve por la URL de reanudación con RESUME y la última secuencia.
  dc.cortar();
  const resume = await hasta(() => dc.gateway.find((p) => p.op === 6), 5000);
  expect(resume.d).toEqual({ token: DISCORD, session_id: "ses1", seq: 5 });
  expect(dc.rutasWs).toEqual(["/gw/", "/gw-reanudar/"]);
  await hasta(() => canal.estado().conectado);
  dc.despachar("MESSAGE_CREATE", { id: "x4", channel_id: "c1", author: autor, content: "sigo" });
  await hasta(() => r.mensajes.length === 2);
});

test("Discord: token no válido es un error sin reintentos", async () => {
  const dc = discordFalso();
  limpiezas.push(() => dc.cerrar());
  process.env.AQUILES_DISCORD_TOKEN = "malo";
  try {
    const canal = new CanalDiscord({ api: dc.api });
    const r = recogedor();
    await expect(canal.iniciar(r.alMensaje, r.alBoton)).rejects.toThrow("el token no es válido");
    expect(canal.estado()).toEqual({ conectado: false, error: "Discord: el token no es válido" });
  } finally {
    process.env.AQUILES_DISCORD_TOKEN = DISCORD;
  }
});

test("Discord por la pasarela: emparejar, contestar y entregar", async () => {
  const dc = discordFalso();
  const motor = new MotorEco();
  const pasarela = new Pasarela({ dir: null, motor, cwdPorDefecto: "C:/defecto", canales: [new CanalDiscord({ api: dc.api })] });
  limpiezas.push(() => pasarela.detener(), () => dc.cerrar());
  await pasarela.iniciar();
  const textos = () => dc.rest.filter((x) => x.ruta === "/api/v10/channels/dm1/messages").map((x) => x.cuerpo.content as string);
  const autor = { id: "1", username: "ana", global_name: "Ana" };
  const { codigo } = pasarela.emparejar("discord");
  dc.despachar("MESSAGE_CREATE", { id: "x1", channel_id: "dm1", author: autor, content: codigo });
  await hasta(() => textos().some((t) => t.startsWith("Emparejado")));
  dc.despachar("MESSAGE_CREATE", { id: "x2", channel_id: "dm1", author: autor, content: "hola" });
  await hasta(() => textos().includes("eco: hola"));
  expect(motor.turnos[0]!.nueva?.titulo).toBe("Discord · Ana");
  await pasarela.entregar("discord", undefined, "Aviso programado");
  expect(textos()).toContain("Aviso programado");
});

// ── Slack ───────────────────────────────────────────────────────────────────

function slackFalso() {
  const llamadas: { metodo: string; token?: string; args: Record<string, string> }[] = [];
  const confirmados: string[] = [];
  let ws: ServerWebSocket<unknown> | undefined;
  let conexiones = 0;
  const servidor = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/socket") return srv.upgrade(req, { data: undefined }) ? undefined : new Response("", { status: 400 });
      const metodo = url.pathname.replace("/api/", "");
      const token = req.headers.get("authorization")?.replace("Bearer ", "");
      llamadas.push({ metodo, token, args: Object.fromEntries(new URLSearchParams(await req.text())) });
      if (metodo === "apps.connections.open") {
        return Response.json(token === SLACK_APP ? { ok: true, url: `ws://127.0.0.1:${srv.port}/socket` } : { ok: false, error: "invalid_auth" });
      }
      if (token !== SLACK_BOT) return Response.json({ ok: false, error: "invalid_auth" });
      if (metodo === "users.info") return Response.json({ ok: true, user: { name: "ana", real_name: "Ana García", profile: { display_name: "" } } });
      return Response.json({ ok: true, ts: "1.0" });
    },
    websocket: {
      open(socket) {
        ws = socket;
        conexiones += 1;
        socket.send(JSON.stringify({ type: "hello" }));
      },
      message(_socket, m) {
        confirmados.push(JSON.parse(String(m)).envelope_id);
      },
    },
  });
  return {
    api: `http://127.0.0.1:${servidor.port}/api`,
    llamadas,
    confirmados,
    conexiones: () => conexiones,
    sobre: (sobre: object) => ws?.send(JSON.stringify(sobre)),
    mensaje: (id: string, evento: object) => ws?.send(JSON.stringify({ type: "events_api", envelope_id: id, payload: { event: { type: "message", ...evento } } })),
    cerrar: () => servidor.stop(true),
  };
}

test("Slack: Socket Mode, confirmar envelopes, filtrar bots, botones y chat.postMessage", async () => {
  const sl = slackFalso();
  const canal = new CanalSlack({ api: sl.api });
  limpiezas.push(() => canal.detener(), () => sl.cerrar());
  const r = recogedor();
  await canal.iniciar(r.alMensaje, r.alBoton);
  expect(canal.estado()).toEqual({ conectado: true });
  expect(sl.llamadas[0]).toMatchObject({ metodo: "apps.connections.open", token: SLACK_APP });

  sl.mensaje("e1", { channel: "D1", user: "U1", bot_id: "B1", text: "de un bot" });
  sl.mensaje("e2", { channel: "D1", user: "U1", subtype: "message_changed", text: "editado" });
  sl.mensaje("e3", { channel: "D1", user: "U1", text: "<@UBOT> hola &amp; adiós &lt;3" });
  await hasta(() => r.mensajes.length);
  expect(r.mensajes).toEqual([{ chatId: "D1", nombre: "Ana García", texto: "hola & adiós <3" }]);
  await hasta(() => sl.confirmados.length === 3);
  expect(sl.confirmados).toEqual(["e1", "e2", "e3"]);

  sl.sobre({ type: "interactive", envelope_id: "e4", payload: { type: "block_actions", channel: { id: "D1" }, actions: [{ action_id: "b1|denegar", value: "denegar" }] } });
  await hasta(() => r.botones.length);
  expect(r.botones).toEqual([["D1", "b1", "denegar"]]);

  await canal.enviar("D1", "a < b & c", BOTONES);
  const envio = sl.llamadas.find((x) => x.metodo === "chat.postMessage")!;
  expect(envio.token).toBe(SLACK_BOT);
  expect(envio.args.channel).toBe("D1");
  expect(envio.args.text).toBe("a &lt; b &amp; c");
  const [seccion, acciones] = JSON.parse(envio.args.blocks!);
  expect(seccion).toEqual({ type: "section", text: { type: "mrkdwn", text: "a &lt; b &amp; c" } });
  expect(acciones.elements.map((e: any) => e.action_id)).toEqual(["b1|permitir", "b1|denegar"]);

  // Slack pide renovar la conexión: se abre otra.
  sl.sobre({ type: "disconnect", reason: "refresh_requested" });
  await hasta(() => sl.conexiones() === 2, 5000);
  await hasta(() => canal.estado().conectado);
  sl.mensaje("e5", { channel: "D1", user: "U1", text: "sigo" });
  await hasta(() => r.mensajes.length === 2);
});

test("Slack: sin token de app no recibe, pero entrega con el del bot", async () => {
  const sl = slackFalso();
  limpiezas.push(() => sl.cerrar());
  delete process.env.AQUILES_SLACK_APP_TOKEN;
  try {
    const canal = new CanalSlack({ api: sl.api });
    expect(canal.configurado()).toBe(true);
    expect(canal.secretos()).toEqual({ AQUILES_SLACK_TOKEN: true, AQUILES_SLACK_APP_TOKEN: false });
    const r = recogedor();
    await expect(canal.iniciar(r.alMensaje, r.alBoton)).rejects.toThrow("Falta AQUILES_SLACK_APP_TOKEN");
    await canal.enviar("C9", "entrega");
    expect(sl.llamadas.at(-1)).toMatchObject({ metodo: "chat.postMessage", args: { channel: "C9", text: "entrega" } });
  } finally {
    process.env.AQUILES_SLACK_APP_TOKEN = SLACK_APP;
  }
});

test("Slack por la pasarela: emparejar, contestar y entregar", async () => {
  const sl = slackFalso();
  const motor = new MotorEco();
  const pasarela = new Pasarela({ dir: null, motor, cwdPorDefecto: "C:/defecto", canales: [new CanalSlack({ api: sl.api })] });
  limpiezas.push(() => pasarela.detener(), () => sl.cerrar());
  await pasarela.iniciar();
  const textos = () => sl.llamadas.filter((x) => x.metodo === "chat.postMessage" && x.args.channel === "D1").map((x) => x.args.text!);
  const { codigo } = pasarela.emparejar("slack");
  sl.mensaje("e1", { channel: "D1", user: "U1", text: codigo });
  await hasta(() => textos().some((t) => t.startsWith("Emparejado")));
  sl.mensaje("e2", { channel: "D1", user: "U1", text: "hola" });
  await hasta(() => textos().includes("eco: hola"));
  expect(motor.turnos[0]!.nueva?.titulo).toBe("Slack · Ana García");
  await pasarela.entregar("slack", undefined, "Aviso programado");
  expect(textos()).toContain("Aviso programado");
});

// ── Correo ──────────────────────────────────────────────────────────────────

interface CorreoRecibido {
  ordenes: string[];
  de?: string;
  para: string[];
  datos?: string;
  usuario?: string;
  clave?: string;
  cifrado: boolean;
}

/** Servidor SMTP falso: EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA y QUIT. */
async function smtpFalso(o: { tls?: boolean; starttls?: boolean; auth?: string; ochoBits?: boolean; rechazarRcpt?: boolean } = {}) {
  const sesiones: CorreoRecibido[] = [];
  const b64 = (t: string) => Buffer.from(t, "base64").toString("utf8");
  const atender = (s: Socket, cifrado: boolean, c: CorreoRecibido) => {
    let pendiente = "";
    let modo: "orden" | "datos" | "usuario" | "clave" = "orden";
    const decir = (l: string) => s.write(`${l}\r\n`);
    const alDatos = (d: Buffer) => {
      pendiente += d.toString("utf8");
      for (;;) {
        if (modo === "datos") {
          const fin = pendiente.indexOf("\r\n.\r\n");
          if (fin < 0) return;
          c.datos = pendiente.slice(0, fin);
          pendiente = pendiente.slice(fin + 5);
          modo = "orden";
          decir("250 2.0.0 aceptado");
          continue;
        }
        const i = pendiente.indexOf("\r\n");
        if (i < 0) return;
        const linea = pendiente.slice(0, i);
        pendiente = pendiente.slice(i + 2);
        c.ordenes.push(linea);
        if (modo === "usuario") {
          c.usuario = b64(linea);
          modo = "clave";
          decir("334 UGFzc3dvcmQ6");
          continue;
        }
        if (modo === "clave") {
          c.clave = b64(linea);
          modo = "orden";
          decir("235 2.7.0 dentro");
          continue;
        }
        const [orden, ...args] = linea.split(" ");
        switch (orden!.toUpperCase()) {
          case "EHLO":
            decir("250-smtp.falso hola");
            if (o.ochoBits !== false) decir("250-8BITMIME");
            if (o.starttls && !cifrado) decir("250-STARTTLS");
            decir(`250 AUTH ${o.auth ?? "PLAIN LOGIN"}`);
            break;
          case "STARTTLS": {
            decir("220 2.0.0 adelante");
            s.off("data", alDatos);
            const seguro = new TLSSocket(s, { isServer: true, key: CLAVE_CERT, cert: CERT });
            c.cifrado = true;
            atender(seguro, true, c);
            return;
          }
          case "AUTH":
            if (args[0] === "PLAIN") {
              const [, usuario, clave] = b64(args[1]!).split("\0");
              Object.assign(c, { usuario, clave });
              decir("235 2.7.0 dentro");
            } else {
              modo = "usuario";
              decir("334 VXNlcm5hbWU6");
            }
            break;
          case "MAIL":
            c.de = /<(.*)>/.exec(linea)?.[1];
            decir("250 2.1.0 ok");
            break;
          case "RCPT":
            if (o.rechazarRcpt) decir("550 5.1.1 no existe");
            else {
              c.para.push(/<(.*)>/.exec(linea)![1]!);
              decir("250 2.1.5 ok");
            }
            break;
          case "DATA":
            modo = "datos";
            decir("354 adelante");
            break;
          case "QUIT":
            decir("221 2.0.0 adiós");
            s.end();
            return;
          default:
            decir("502 5.5.1 no entiendo");
        }
      }
    };
    s.on("data", alDatos);
    s.on("error", () => {});
  };
  const nueva = (s: Socket, cifrado: boolean) => {
    const c: CorreoRecibido = { ordenes: [], para: [], cifrado };
    sesiones.push(c);
    s.write("220 smtp.falso ESMTP\r\n");
    atender(s, cifrado, c);
  };
  const servidor: Server = o.tls ? crearServidorTls({ key: CLAVE_CERT, cert: CERT }, (s) => nueva(s, true)) : createServer((s) => nueva(s, false));
  await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
  limpiezas.push(() => servidor.close());
  return { puerto: String((servidor.address() as { port: number }).port), sesiones };
}

/** Lee cabeceras y cuerpo de un correo recibido (las palabras codificadas de RFC 2047 se decodifican). */
function leerCorreo(datos: string) {
  const [cabeza = "", ...resto] = datos.split("\r\n\r\n");
  const cabeceras: Record<string, string> = {};
  for (const l of cabeza.replace(/\r\n /g, " ").split("\r\n")) {
    const i = l.indexOf(": ");
    cabeceras[l.slice(0, i)] = l
      .slice(i + 2)
      .replace(/=\?UTF-8\?B\?([^?]*)\?=\s?/g, (_, b) => Buffer.from(b, "base64").toString("utf8"));
  }
  return { cabeceras, cuerpo: resto.join("\r\n\r\n") };
}

const TEXTO = "Informe diario: ñandú y café\n\nLínea uno\n.línea que empieza por punto\nfin";

test("correo en claro a un SMTP local: AUTH PLAIN, cabeceras, UTF-8 en 8 bits y dot-stuffing", async () => {
  const smtp = await smtpFalso();
  const canal = new CanalCorreo();
  canal.configurar({ servidor: "127.0.0.1", puerto: smtp.puerto, seguridad: "ninguna", usuario: "yo", de: "aquiles@casa.es", para: "yo@casa.es" });
  expect(canal.configurado()).toBe(true);
  await canal.enviar("", TEXTO);
  const [c] = smtp.sesiones;
  expect(c).toMatchObject({ de: "aquiles@casa.es", para: ["yo@casa.es"], usuario: "yo", clave: "clave-secreta", cifrado: false });
  expect(c!.ordenes).toContain("MAIL FROM:<aquiles@casa.es> BODY=8BITMIME");
  expect(c!.ordenes.at(-1)).toBe("QUIT");
  const { cabeceras, cuerpo } = leerCorreo(c!.datos!);
  expect(cabeceras.Subject).toBe("Informe diario: ñandú y café");
  expect(cabeceras.From).toBe("Aquiles <aquiles@casa.es>");
  expect(cabeceras.To).toBe("yo@casa.es");
  expect(Number.isNaN(Date.parse(cabeceras.Date!))).toBe(false);
  expect(cabeceras["Content-Type"]).toBe("text/plain; charset=utf-8");
  expect(cabeceras["Content-Transfer-Encoding"]).toBe("8bit");
  expect(cuerpo).toBe("Informe diario: ñandú y café\r\n\r\nLínea uno\r\n..línea que empieza por punto\r\nfin");
  expect(canal.estado()).toEqual({ conectado: false });
});

test("correo: AUTH LOGIN, base64 sin 8BITMIME y destinatario explícito", async () => {
  const smtp = await smtpFalso({ auth: "LOGIN", ochoBits: false });
  const canal = new CanalCorreo();
  canal.configurar({ servidor: "127.0.0.1", puerto: smtp.puerto, seguridad: "ninguna", de: "aquiles@casa.es", para: "yo@casa.es" });
  await canal.enviar("otra@casa.es, tercera@casa.es", TEXTO);
  const [c] = smtp.sesiones;
  // Sin usuario, entra con el remitente.
  expect(c).toMatchObject({ usuario: "aquiles@casa.es", clave: "clave-secreta", para: ["otra@casa.es", "tercera@casa.es"] });
  expect(c!.ordenes).toContain("MAIL FROM:<aquiles@casa.es>");
  const { cabeceras, cuerpo } = leerCorreo(c!.datos!);
  expect(cabeceras["Content-Transfer-Encoding"]).toBe("base64");
  expect(Buffer.from(cuerpo.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(TEXTO.replace(/\n/g, "\r\n"));
});

test("correo con STARTTLS y con TLS implícito", async () => {
  const conStarttls = await smtpFalso({ starttls: true });
  const canal = new CanalCorreo({ ca: CERT });
  canal.configurar({ servidor: "127.0.0.1", puerto: conStarttls.puerto, seguridad: "starttls", de: "aquiles@casa.es", para: "yo@casa.es" });
  await canal.enviar("", "Por STARTTLS");
  const [c] = conStarttls.sesiones;
  expect(c).toMatchObject({ cifrado: true, clave: "clave-secreta" });
  // La clave solo viaja después de cifrar.
  expect(c!.ordenes.indexOf("STARTTLS")).toBeLessThan(c!.ordenes.findIndex((l) => l.startsWith("AUTH")));
  expect(leerCorreo(c!.datos!).cabeceras.Subject).toBe("Por STARTTLS");

  const implicito = await smtpFalso({ tls: true });
  canal.configurar({ servidor: "127.0.0.1", puerto: implicito.puerto, seguridad: "tls", de: "aquiles@casa.es", para: "yo@casa.es" });
  await canal.enviar("", "Por TLS");
  expect(implicito.sesiones[0]).toMatchObject({ cifrado: true, para: ["yo@casa.es"] });

  // Si el servidor no ofrece STARTTLS, no se sigue en claro.
  const sinStarttls = await smtpFalso();
  canal.configurar({ servidor: "127.0.0.1", puerto: sinStarttls.puerto, seguridad: "starttls", de: "aquiles@casa.es", para: "yo@casa.es" });
  await expect(canal.enviar("", "x")).rejects.toThrow("no ofrece STARTTLS");
  expect(sinStarttls.sesiones[0]!.ordenes.some((l) => l.startsWith("AUTH"))).toBe(false);
});

test("correo: errores del servidor y opciones que no valen", async () => {
  const smtp = await smtpFalso({ rechazarRcpt: true });
  const canal = new CanalCorreo();
  canal.configurar({ servidor: "127.0.0.1", puerto: smtp.puerto, seguridad: "ninguna", de: "aquiles@casa.es", para: "nadie@casa.es" });
  await expect(canal.enviar("", "x")).rejects.toThrow("550 5.1.1 no existe");
  expect(canal.estado().error).toContain("550");

  expect(() => canal.configurar({ servidor: "smtp.gmail.com", seguridad: "ninguna", de: "a@b.es" })).toThrow("servidor local");
  expect(() => canal.configurar({ servidor: "localhost", seguridad: "ninguna", de: "a@b.es" })).not.toThrow();
  expect(() => canal.configurar({ servidor: "smtp.gmail.com", color: "rojo" })).toThrow("Opciones desconocidas");
  expect(() => canal.configurar({ servidor: "smtp.gmail.com", de: "sin arroba" })).toThrow("no es una dirección");
  expect(() => canal.configurar({ servidor: "smtp.gmail.com", puerto: "99999" })).toThrow("puerto");
  expect(() => canal.configurar({ servidor: "smtp.gmail.com", seguridad: "a veces" })).toThrow("seguridad");
  const vacio = new CanalCorreo();
  expect(vacio.configurado()).toBe(false);
  await expect(vacio.enviar("", "x")).rejects.toThrow("no está configurado");
});

test("correo por la pasarela: opciones guardadas y entrega a «para» o al destino", async () => {
  const smtp = await smtpFalso();
  const motor = new MotorEco();
  const pasarela = new Pasarela({ dir: null, motor, cwdPorDefecto: "C:/defecto", canales: [new CanalCorreo()] });
  const info = pasarela.configurar("correo", { servidor: "127.0.0.1", puerto: smtp.puerto, seguridad: "ninguna", de: "aquiles@casa.es", para: "yo@casa.es" });
  expect(info).toMatchObject({ configurado: true, conversa: false, secretos: { AQUILES_CORREO_CLAVE: true }, opciones: { para: "yo@casa.es" } });
  await pasarela.entregar("correo", undefined, "Resumen semanal\n\nTodo bien");
  await pasarela.entregar("correo", "jefa@casa.es", "Copia");
  expect(smtp.sesiones.map((s) => s.para)).toEqual([["yo@casa.es"], ["jefa@casa.es"]]);
  expect(leerCorreo(smtp.sesiones[0]!.datos!).cabeceras.Subject).toBe("Resumen semanal");
  // Una opción vacía se quita.
  expect(pasarela.configurar("correo", { para: "" }).opciones.para).toBeUndefined();
});
