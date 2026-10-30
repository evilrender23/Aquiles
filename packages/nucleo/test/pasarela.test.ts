/** La pasarela con Telegram contra un servidor falso de la Bot API y un motor falso. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ajustes, Evento } from "@aquiles/protocolo";
import type { ResultadoTurno } from "../src/bucle";
import type { Canal } from "../src/canales/canal";
import { CanalEscritorio } from "../src/canales/escritorio";
import { CanalTelegram } from "../src/canales/telegram";
import type { Motor, PeticionTurno } from "../src/motor";
import { Pasarela } from "../src/pasarela";

const TOKEN = "123456:token-de-prueba";
process.env.AQUILES_TELEGRAM_TOKEN = TOKEN;

const fin = (texto: string, motivo: ResultadoTurno["motivo"] = "fin"): ResultadoTurno => ({ motivo, texto, uso: { entrada: 0, salida: 0 } });

class MotorFalso implements Motor {
  turnos: PeticionTurno[] = [];
  sesiones = new Set<string>();
  enMarcha = new Set<string>();
  steers: { sesionId: string; texto: string }[] = [];
  eventos: Evento[] = [];
  logs: string[] = [];
  /** Se llama al parar un turno (el guion lo usa para terminar con «parado»). */
  alParar?: () => void;
  guion: (p: PeticionTurno) => Promise<ResultadoTurno> = async (p) => fin(`eco: ${p.texto}`);
  private n = 0;

  async turno(p: PeticionTurno) {
    if (p.sesionId && !this.sesiones.has(p.sesionId)) throw new Error(`No existe la sesión ${p.sesionId}`);
    const sesionId = p.sesionId ?? `s${++this.n}`;
    this.sesiones.add(sesionId);
    this.enMarcha.add(sesionId);
    this.turnos.push(p);
    p.alEvento?.({ tipo: "mensaje.delta", sesionId, texto: "" });
    try {
      return { sesionId, resultado: await this.guion(p) };
    } finally {
      this.enMarcha.delete(sesionId);
    }
  }
  existeSesion = (id: string) => this.sesiones.has(id);
  trabajando = (id: string) => this.enMarcha.has(id);
  steer = (id: string, texto: string) => {
    if (!this.enMarcha.has(id)) return false;
    this.steers.push({ sesionId: id, texto });
    return true;
  };
  parar = (id: string) => {
    if (!this.enMarcha.has(id)) return false;
    this.alParar?.();
    return true;
  };
  notificar() {}
  emitir(e: Evento) {
    this.eventos.push(e);
  }
  /** Solo lo que leen el programador y la pasarela. */
  ajustes(): Ajustes {
    return { proveedor: "simulado", modoAprobacion: "preguntar-ejecutar", carpeta: "C:/trabajo" } as Ajustes;
  }
  log(m: string) {
    this.logs.push(m);
  }
}

/** Bot API falsa: guarda lo que se envía y sirve updates por long polling (cortos, de 200 ms). */
function telegramFalso() {
  const enviados: { metodo: string; params: any }[] = [];
  const updates: any[] = [];
  let siguiente = 1;
  let avisar: (() => void) | undefined;
  /** Respuestas de getUpdates con updates que «se pierden» por la red (502). */
  let perdidas = 0;
  const servidor = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url).pathname);
      if (m?.[1] !== TOKEN) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
      const metodo = m[2]!;
      const params = (await req.json()) as any;
      if (metodo === "getUpdates") {
        const pendientes = () => updates.filter((u) => u.update_id >= params.offset);
        if (!pendientes().length) {
          await new Promise<void>((ok) => {
            avisar = ok;
            setTimeout(ok, 200);
          });
        }
        if (perdidas > 0 && pendientes().length) {
          perdidas -= 1;
          return new Response("Bad Gateway", { status: 502 });
        }
        return Response.json({ ok: true, result: pendientes() });
      }
      enviados.push({ metodo, params });
      if (metodo === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "aquiles_bot" } });
      return Response.json({ ok: true, result: true });
    },
  });
  const anadir = (u: object) => {
    updates.push({ update_id: siguiente++, ...u });
    avisar?.();
  };
  return {
    url: `http://127.0.0.1:${servidor.port}`,
    enviados,
    perder: (n: number) => (perdidas = n),
    perdidasPendientes: () => perdidas,
    escribir: (chatId: number, text: string, nombre = "Ana") =>
      anadir({ message: { message_id: siguiente, chat: { id: chatId, type: "private", first_name: nombre }, from: { id: chatId, is_bot: false }, text } }),
    pulsar: (chatId: number, data: string) => anadir({ callback_query: { id: `q${siguiente}`, data, message: { chat: { id: chatId } } } }),
    /** Mensajes de texto enviados a un chat. */
    textos: (chatId: number) => enviados.filter((e) => e.metodo === "sendMessage" && e.params.chat_id === String(chatId)).map((e) => e.params.text as string),
    cerrar: () => servidor.stop(true),
  };
}

const limpiezas: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of limpiezas.splice(0)) await f();
});

async function montar(o: { dir?: string; canales?: Canal[] } = {}) {
  const tg = telegramFalso();
  const motor = new MotorFalso();
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "aquiles-pasarela-"));
  const pasarela = new Pasarela({ dir, motor, cwdPorDefecto: "C:/defecto", canales: o.canales ?? [new CanalTelegram({ api: tg.url })] });
  limpiezas.push(() => pasarela.detener(), () => tg.cerrar());
  return { tg, motor, pasarela, dir };
}

async function hasta<R>(f: () => R | undefined | false, ms = 4000): Promise<R> {
  const limite = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > limite) throw new Error("no llegó a tiempo");
    await Bun.sleep(5);
  }
}

/** Espera a que el chat reciba un texto que contenga `parte`. */
const recibe = (tg: ReturnType<typeof telegramFalso>, chatId: number, parte: string) => hasta(() => tg.textos(chatId).find((t) => t.includes(parte)));

async function emparejado(o: { dir?: string } = {}) {
  const m = await montar(o);
  await m.pasarela.iniciar();
  const { codigo } = m.pasarela.emparejar("telegram");
  m.tg.escribir(42, codigo);
  await recibe(m.tg, 42, "Emparejado");
  return m;
}

test("emparejar con código: un chat sin emparejar nunca llega al agente", async () => {
  const { tg, motor, pasarela, dir } = await montar();
  await pasarela.iniciar();
  expect(pasarela.listar()[0]).toMatchObject({ id: "telegram", configurado: true, conversa: true, conectado: true, chats: [] });
  expect(pasarela.listar()[0]!.secretos).toEqual({ AQUILES_TELEGRAM_TOKEN: true });

  tg.escribir(42, "hola");
  await recibe(tg, 42, "Automatizaciones → Canales → Emparejar");
  tg.escribir(42, "¿hola?");
  const { codigo, caduca } = pasarela.emparejar("telegram");
  expect(codigo).toMatch(/^\d{6}$/);
  expect(Date.parse(caduca) - Date.now()).toBeGreaterThan(9 * 60_000);
  tg.escribir(42, codigo === "000000" ? "111111" : "000000");
  await recibe(tg, 42, "Ese código no vale");
  tg.escribir(42, `/start ${codigo}`);
  await recibe(tg, 42, "Emparejado. Ya puedes hablar con Aquiles");
  // El segundo mensaje sin emparejar no repite el aviso.
  expect(tg.textos(42).filter((t) => t.includes("no está emparejado"))).toHaveLength(1);
  expect(motor.turnos).toEqual([]);

  const [chat] = pasarela.listar()[0]!.chats;
  expect(chat).toMatchObject({ id: "42", nombre: "Ana" });
  expect(JSON.parse(readFileSync(join(dir, "canales.json"), "utf8")).telegram.chats[0].id).toBe("42");
  expect(motor.eventos).toContainEqual({ tipo: "canales.actualizados" });

  // El código era de un solo uso: otro chat no puede reutilizarlo.
  tg.escribir(7, codigo, "Intruso");
  await recibe(tg, 7, "Ese código no vale");
  tg.escribir(7, "ejecuta rm -rf /", "Intruso");
  await recibe(tg, 7, "no está emparejado");
  expect(motor.turnos).toEqual([]);
  expect(pasarela.listar()[0]!.chats).toHaveLength(1);
});

test("varios códigos equivocados anulan el código pendiente", async () => {
  const { tg, pasarela } = await montar();
  await pasarela.iniciar();
  const { codigo } = pasarela.emparejar("telegram");
  const malo = codigo === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) tg.escribir(9, malo, "Intruso");
  await hasta(() => tg.textos(9).filter((t) => t.includes("no vale")).length === 5);
  tg.escribir(9, codigo, "Intruso");
  await hasta(() => tg.textos(9).filter((t) => t.includes("no vale")).length === 6);
  expect(pasarela.listar()[0]!.chats).toEqual([]);
});

test("conversar: una sesión por chat, «escribiendo» y la respuesta final", async () => {
  const { tg, motor, pasarela, dir } = await emparejado();
  tg.escribir(42, "hola");
  await recibe(tg, 42, "eco: hola");
  expect(motor.turnos[0]).toMatchObject({
    texto: "hola",
    nueva: { cwd: "C:/trabajo", titulo: "Telegram · Ana", origen: { tipo: "canal", canal: "telegram", chatId: "42" } },
  });
  expect(motor.turnos[0]!.aprobar).toBeFunction();
  expect(motor.turnos[0]!.preguntar).toBeFunction();
  expect(tg.enviados.some((e) => e.metodo === "sendChatAction" && e.params.chat_id === "42" && e.params.action === "typing")).toBe(true);
  expect(pasarela.listar()[0]!.chats[0]!.sesionId).toBe("s1");
  expect(JSON.parse(readFileSync(join(dir, "canales.json"), "utf8")).telegram.chats[0].sesionId).toBe("s1");

  tg.escribir(42, "¿y ahora?");
  await recibe(tg, 42, "eco: ¿y ahora?");
  expect(motor.turnos[1]).toMatchObject({ sesionId: "s1", texto: "¿y ahora?" });
  expect(motor.turnos[1]!.nueva).toBeUndefined();

  // Un error del turno llega como mensaje.
  motor.guion = async () => ({ ...fin(""), motivo: "error", error: "el modelo no responde" });
  tg.escribir(42, "falla");
  await recibe(tg, 42, "No he podido terminar: el modelo no responde");
});

test("permisos: botones Permitir/Siempre/Denegar y también por texto", async () => {
  const { tg, motor } = await emparejado();
  motor.guion = async (p) => {
    const r = await p.aprobar!({ id: "a1", herramienta: "terminal", nivel: "ejecucion", resumen: "rm -rf build", argumentos: {}, motivo: "ejecutar un comando" });
    return fin(`decisión: ${r}`);
  };
  tg.escribir(42, "borra build");
  const peticion = await hasta(() => tg.enviados.find((e) => e.params.reply_markup));
  expect(peticion.params.text).toContain("Aquiles pide permiso para terminal:\nrm -rf build\n(ejecutar un comando)");
  const teclas = peticion.params.reply_markup.inline_keyboard as { text: string; callback_data: string }[][];
  expect(teclas).toHaveLength(1);
  expect(teclas[0]!.map((t) => t.text)).toEqual(["Permitir", "Siempre", "Denegar"]);
  const siempre = teclas[0]![1]!.callback_data;
  expect(siempre).toMatch(/^\w+\|siempre$/);
  tg.pulsar(42, siempre);
  await recibe(tg, 42, "decisión: siempre");
  await recibe(tg, 42, "Permitido siempre.");
  expect(tg.enviados.some((e) => e.metodo === "answerCallbackQuery")).toBe(true);

  // Por texto: lo que no vale pide otra vez; «Denegar» (con mayúscula) vale.
  tg.escribir(42, "borra otra vez");
  await hasta(() => tg.enviados.filter((e) => e.params.reply_markup).length === 2);
  tg.escribir(42, "quizá");
  await recibe(tg, 42, "Responde permitir, siempre o denegar (o /parar)");
  tg.escribir(42, "Denegar");
  await recibe(tg, 42, "decisión: denegar");
  // Un botón de una petición ya contestada no hace nada.
  tg.pulsar(42, siempre);
  await recibe(tg, 42, "Eso ya no está pendiente.");
  expect(tg.textos(42).filter((t) => t.startsWith("decisión"))).toEqual(["decisión: siempre", "decisión: denegar"]);
});

test("preguntas: botones con opciones o el siguiente mensaje como respuesta", async () => {
  const { tg, motor } = await emparejado();
  motor.guion = async (p) => {
    if (p.texto.includes("color")) return fin(`color: ${await p.preguntar!({ texto: "¿Qué color?", opciones: ["rojo", "verde"] })}`);
    return fin(`nombre: ${await p.preguntar!({ texto: "¿Cómo se llama?" })}`);
  };
  tg.escribir(42, "elige un color");
  const pregunta = await hasta(() => tg.enviados.find((e) => e.params.reply_markup));
  expect(pregunta.params.text).toBe("¿Qué color?\n\n1. rojo\n2. verde");
  const [, verde] = pregunta.params.reply_markup.inline_keyboard[0];
  tg.pulsar(42, verde.callback_data);
  await recibe(tg, 42, "color: verde");
  await recibe(tg, 42, "Elegido: verde");

  tg.escribir(42, "otro color");
  await hasta(() => tg.enviados.filter((e) => e.params.reply_markup).length === 2);
  tg.escribir(42, "1");
  await recibe(tg, 42, "color: rojo");

  tg.escribir(42, "ponle nombre");
  await recibe(tg, 42, "¿Cómo se llama?");
  expect(tg.enviados.find((e) => e.params.text === "¿Cómo se llama?")!.params.reply_markup).toBeUndefined();
  tg.escribir(42, "Rex");
  await recibe(tg, 42, "nombre: Rex");
  expect(motor.turnos).toHaveLength(3);
});

test("órdenes: steer mientras trabaja, /estado, /parar y /nueva", async () => {
  const { tg, motor } = await emparejado();
  motor.guion = () =>
    new Promise((ok) => {
      motor.alParar = () => ok(fin("a medias", "parado"));
    });
  tg.escribir(42, "trabaja mucho");
  await hasta(() => motor.turnos.length === 1);
  tg.escribir(42, "y añade esto");
  await hasta(() => motor.steers.length === 1);
  expect(motor.steers[0]).toEqual({ sesionId: "s1", texto: "y añade esto" });
  tg.escribir(42, "/estado");
  await recibe(tg, 42, "Sesión s1, trabajando.");
  tg.escribir(42, "/parar");
  await recibe(tg, 42, "Parado.");
  expect(tg.textos(42).some((t) => t.includes("a medias"))).toBe(false);
  tg.escribir(42, "/parar");
  await recibe(tg, 42, "No hay nada en marcha.");

  motor.guion = async (p) => fin(`eco: ${p.texto}`);
  tg.escribir(42, "sigo");
  await recibe(tg, 42, "eco: sigo");
  expect(motor.turnos[1]!.sesionId).toBe("s1");
  tg.escribir(42, "/nueva");
  await recibe(tg, 42, "el próximo mensaje empieza una conversación nueva");
  tg.escribir(42, "de cero");
  await recibe(tg, 42, "eco: de cero");
  expect(motor.turnos[2]!.sesionId).toBeUndefined();
  expect(motor.turnos[2]!.nueva?.titulo).toBe("Telegram · Ana");
});

test("entregar: al primer chat emparejado, en trozos de 4000, y la respuesta lleva lo entregado", async () => {
  const { tg, motor, pasarela } = await emparejado();
  await pasarela.entregar("telegram", undefined, "Informe diario\n\nTodo en orden.");
  await recibe(tg, 42, "Informe diario");
  tg.escribir(42, "gracias, ¿y mañana?");
  await recibe(tg, 42, "eco:");
  expect(motor.turnos[0]!.texto).toContain("Informe diario\n\nTodo en orden.");
  expect(motor.turnos[0]!.texto).toContain("gracias, ¿y mañana?");

  const largo = `${"a".repeat(3000)}\n${"b".repeat(3000)}\n${"c".repeat(3000)}`;
  await pasarela.entregar("telegram", "99", largo);
  const trozos = tg.textos(99);
  expect(trozos).toHaveLength(3);
  expect(trozos.every((t) => t.length <= 4000)).toBe(true);
  expect(trozos.join("\n")).toBe(largo);
  await pasarela.probar("telegram");
  await recibe(tg, 42, "Prueba de Aquiles");
});

test("entregar sin chats emparejados, o por un canal sin configurar, falla con un mensaje claro", async () => {
  const { pasarela } = await montar();
  await expect(pasarela.entregar("telegram", undefined, "x")).rejects.toThrow("No hay ningún chat de Telegram");
  await expect(pasarela.entregar("slack", undefined, "x")).rejects.toThrow("no está disponible");
  delete process.env.AQUILES_TELEGRAM_TOKEN;
  try {
    await expect(pasarela.entregar("telegram", "1", "x")).rejects.toThrow("Telegram no está configurado");
    expect(pasarela.listar()[0]).toMatchObject({ configurado: false, secretos: { AQUILES_TELEGRAM_TOKEN: false } });
  } finally {
    process.env.AQUILES_TELEGRAM_TOKEN = TOKEN;
  }
});

test("los chats emparejados y su sesión sobreviven a un reinicio; desemparejar los quita", async () => {
  const primera = await emparejado();
  primera.tg.escribir(42, "hola");
  await recibe(primera.tg, 42, "eco: hola");
  await primera.pasarela.detener();

  const { tg, motor, pasarela } = await montar({ dir: primera.dir });
  motor.sesiones.add("s1");
  await pasarela.iniciar();
  expect(pasarela.listar()[0]!.chats).toMatchObject([{ id: "42", sesionId: "s1" }]);
  tg.escribir(42, "sigo aquí");
  await recibe(tg, 42, "eco: sigo aquí");
  expect(motor.turnos[0]!.sesionId).toBe("s1");

  expect(pasarela.desemparejar("telegram", "42").chats).toEqual([]);
  tg.escribir(42, "¿hola?");
  await recibe(tg, 42, "no está emparejado");
  expect(motor.turnos).toHaveLength(1);
  expect(() => pasarela.desemparejar("telegram", "42")).toThrow("No hay ningún chat 42");
});

test("si la red pierde una respuesta de getUpdates, se vuelve a pedir con el mismo offset", async () => {
  const { tg, motor } = await emparejado();
  tg.perder(1);
  tg.escribir(42, "no te lo pierdas");
  await recibe(tg, 42, "eco: no te lo pierdas");
  // La respuesta con el mensaje se perdió (502) y aun así llegó, una sola vez.
  expect(tg.perdidasPendientes()).toBe(0);
  expect(motor.turnos).toHaveLength(1);
  expect(motor.turnos[0]!.texto).toBe("no te lo pierdas");
});

test("un canal que falla al arrancar no tumba a los demás; los no configurados no arrancan", async () => {
  const motorSolo = new MotorFalso();
  let arrancados = 0;
  const falso = (id: "discord" | "slack", configurado: boolean): Canal => ({
    id, nombre: id, conversa: true, configurado: () => configurado, secretos: () => ({}), opciones: () => ({}), configurar() {},
    async iniciar() {
      arrancados += 1;
      throw new Error("sin red");
    },
    async detener() {}, async enviar() {}, estado: () => ({ conectado: false }),
  });
  const tg = telegramFalso();
  const pasarela = new Pasarela({
    dir: null, motor: motorSolo, cwdPorDefecto: "C:/defecto",
    canales: [new CanalEscritorio(motorSolo), new CanalTelegram({ api: tg.url }), falso("discord", true), falso("slack", false)],
  });
  limpiezas.push(() => pasarela.detener(), () => tg.cerrar());
  await pasarela.iniciar();
  expect(arrancados).toBe(1);
  const info = Object.fromEntries(pasarela.listar().map((c) => [c.id, c]));
  expect(info.telegram).toMatchObject({ conectado: true });
  expect(info.discord).toMatchObject({ conectado: false, error: "sin red" });
  expect(info.slack!.error).toBeUndefined();
  expect(info.escritorio).toMatchObject({ configurado: true, conversa: false });
  expect(() => pasarela.emparejar("escritorio")).toThrow("solo entrega");
  expect(() => pasarela.configurar("telegram", { modo: "x" })).toThrow("no tiene opciones");
});
