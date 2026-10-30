/**
 * Pasarela de canales: arranca los que conversan, empareja chats con un código de un solo uso, lleva una sesión de
 * Aquiles por chat y entrega mensajes (tareas programadas, pruebas) por cualquier canal.
 *
 * Un chat sin emparejar nunca llega al agente: solo se le dice cómo emparejarlo. Los permisos y las preguntas del
 * agente se contestan con botones o por texto, y caducan a los 10 minutos.
 *
 * Datos en <dir>/canales.json: opciones no secretas de cada canal y sus chats emparejados. Los secretos van en
 * variables de entorno (la app los pone desde el llavero).
 */
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatCanal, Evento, IdCanal, InfoCanal } from "@aquiles/protocolo";
import { textoSinArtefactos } from "@aquiles/protocolo";
import type { PeticionAprobacion, RespuestaAprobacion, ResultadoTurno } from "./bucle";
import { type Botones, type Canal, ErrorCanal, type MensajeEntrante, mensajeDe } from "./canales/canal";
import { CanalCorreo } from "./canales/correo";
import { CanalDiscord } from "./canales/discord";
import { CanalEscritorio } from "./canales/escritorio";
import { CanalSlack } from "./canales/slack";
import { CanalTelegram } from "./canales/telegram";
import { CanalTerminal } from "./canales/terminal";
import type { Pregunta } from "./herramientas/herramienta";
import type { Motor } from "./motor";

const VALIDEZ_CODIGO_MS = 10 * 60_000;
/** Códigos equivocados que se toleran antes de anular el código pendiente: así no se puede probar a ciegas. */
const MAX_FALLOS_CODIGO = 5;
const PLAZO_RESPUESTA_MS = 10 * 60_000;
/** A un chat sin emparejar se le explica cómo emparejarlo como mucho una vez en este tiempo (canales con mucha gente). */
const PAUSA_AVISO_MS = 10 * 60_000;
/** «Escribiendo» dura unos 5 s en Telegram y 10 s en Discord: se renueva mientras el turno trabaja. */
const LATIDO_ESCRIBIENDO_MS = 4000;
/** Los canales no avisan de sus cambios de conexión: se comparan cada poco. */
const VIGILANCIA_MS = 3000;
const MAX_CONTEXTO = 3000;

const RUTA_EMPAREJAR = "Aquiles → Automatizaciones → Canales → Emparejar";
const SIN_EMPAREJAR = `Este chat no está emparejado con Aquiles. Para emparejarlo, abre ${RUTA_EMPAREJAR} y envía aquí el código de 6 cifras.`;
const ORDENES = "Órdenes: /parar (para lo que esté haciendo), /nueva (la próxima conversación empieza de cero) y /estado.";
const DECISIONES: { valor: RespuestaAprobacion; texto: string; hecho: string }[] = [
  { valor: "permitir", texto: "Permitir", hecho: "Permitido." },
  { valor: "siempre", texto: "Siempre", hecho: "Permitido siempre." },
  { valor: "denegar", texto: "Denegar", hecho: "Denegado." },
];

export interface OpcionesPasarela {
  /** Carpeta de datos; null = solo en memoria. */
  dir: string | null;
  motor: Motor;
  cwdPorDefecto: string;
  /** Canales disponibles; por defecto, todos los de Aquiles. */
  canales?: Canal[];
}

interface DatosCanal {
  opciones: Record<string, string>;
  chats: ChatCanal[];
}

/** Algo que el agente espera de un chat: un permiso o la respuesta a una pregunta. */
interface Espera {
  idBotones: string;
  /** Traduce lo que llega (valor de botón o texto) a la respuesta; undefined si no vale. */
  interpretar(valor: string, porBoton: boolean): string | undefined;
  /** Mensaje de vuelta al responder, si hace falta. */
  confirmar(respuesta: string, porBoton: boolean): string | undefined;
  /** Qué hacer con un texto que no vale. */
  pista: string;
  /** Respuesta si caduca o se para el turno. */
  porDefecto: string;
  resolver(respuesta: string): void;
}

/** Estado en memoria de un chat emparejado. */
interface EstadoChat {
  trabajando: boolean;
  /** Sesión del turno en marcha, en cuanto se conoce. */
  sesionId?: string;
  /** Mensajes llegados antes de conocer la sesión del turno en marcha: se le pasan con steer o van en el siguiente. */
  cola: string[];
  esperas: Espera[];
  /** Sube con /nueva: un turno de antes ya no fija su sesión en el chat. */
  generacion: number;
  /** Lo último que se entregó aquí; acompaña al siguiente mensaje para que el agente sepa a qué se responde. */
  entregado?: string;
}

export class Pasarela {
  private motor: Motor;
  private cwdPorDefecto: string;
  private ruta: string | null;
  private canales: Canal[];
  private datos: Partial<Record<IdCanal, DatosCanal>>;
  private estados = new Map<string, EstadoChat>();
  private codigos = new Map<IdCanal, { codigo: string; caduca: number; fallos: number }>();
  private avisados = new Map<string, number>();
  /** Fallos al arrancar que el canal no recoge en su estado. */
  private fallos = new Map<IdCanal, string>();
  private iniciada = false;
  private vigilante?: ReturnType<typeof setInterval>;
  private firma = "";

  constructor(o: OpcionesPasarela) {
    this.motor = o.motor;
    this.cwdPorDefecto = o.cwdPorDefecto;
    this.ruta = o.dir ? join(o.dir, "canales.json") : null;
    if (o.dir) mkdirSync(o.dir, { recursive: true });
    this.canales = o.canales ?? [
      new CanalEscritorio(o.motor),
      new CanalTerminal(o.motor),
      new CanalTelegram(),
      new CanalDiscord(),
      new CanalSlack(),
      new CanalCorreo(),
    ];
    this.datos = this.cargar();
    for (const c of this.canales) {
      const guardadas = this.datos[c.id]?.opciones;
      if (!guardadas || !Object.keys(guardadas).length) continue;
      try {
        c.configurar(guardadas);
      } catch (e) {
        this.log(`opciones guardadas de ${c.nombre} no válidas: ${mensajeDe(e)}`);
      }
    }
  }

  /** Arranca los canales que conversan y están configurados; el fallo de uno no para a los demás. */
  async iniciar(): Promise<void> {
    this.iniciada = true;
    await Promise.all(this.canales.filter((c) => c.conversa && c.configurado()).map((c) => this.arrancar(c)));
    this.firma = this.firmaEstado();
    clearInterval(this.vigilante);
    this.vigilante = setInterval(() => {
      const firma = this.firmaEstado();
      if (firma === this.firma) return;
      this.firma = firma;
      this.avisar();
    }, VIGILANCIA_MS);
    this.vigilante.unref?.();
    this.avisar();
  }

  async detener(): Promise<void> {
    this.iniciada = false;
    clearInterval(this.vigilante);
    for (const estado of this.estados.values()) soltarEsperas(estado);
    await Promise.all(this.canales.map((c) => c.detener().catch((e) => this.log(`al parar ${c.nombre}: ${mensajeDe(e)}`))));
  }

  listar(): InfoCanal[] {
    return this.canales.map((c) => this.info(c));
  }

  /** Cambia opciones no secretas: las dadas sustituyen a las guardadas y una vacía se quita. */
  configurar(id: IdCanal, opciones: Record<string, string>): InfoCanal {
    const c = this.canal(id);
    const nuevas = Object.entries({ ...c.opciones(), ...opciones })
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v !== "");
    c.configurar(Object.fromEntries(nuevas));
    this.datosDe(id).opciones = c.opciones();
    this.guardar();
    this.avisar();
    return this.info(c);
  }

  emparejar(id: IdCanal): { codigo: string; caduca: string } {
    const c = this.canal(id);
    if (!c.conversa) throw new ErrorCanal(`${c.nombre} solo entrega mensajes: no tiene chats que emparejar`);
    const codigo = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const caduca = Date.now() + VALIDEZ_CODIGO_MS;
    this.codigos.set(id, { codigo, caduca, fallos: 0 });
    return { codigo, caduca: new Date(caduca).toISOString() };
  }

  desemparejar(id: IdCanal, chatId: string): InfoCanal {
    const c = this.canal(id);
    const chats = this.datosDe(id).chats;
    const i = chats.findIndex((ch) => ch.id === chatId);
    if (i < 0) throw new ErrorCanal(`No hay ningún chat ${chatId} emparejado en ${c.nombre}`);
    chats.splice(i, 1);
    const estado = this.estados.get(clave(id, chatId));
    if (estado) soltarEsperas(estado);
    this.estados.delete(clave(id, chatId));
    this.guardar();
    this.avisar();
    return this.info(c);
  }

  async probar(id: IdCanal, destino?: string): Promise<void> {
    await this.entregar(id, destino, "Prueba de Aquiles\n\nSi lees esto, el canal funciona.");
  }

  /** Envía a `destino` o, si falta, al primer chat emparejado (en correo, a la opción `para`). Lanza si falla. */
  async entregar(id: IdCanal, destino: string | undefined, texto: string): Promise<void> {
    const c = this.canal(id);
    if (!c.configurado()) throw new ErrorCanal(`${c.nombre} no está configurado`);
    const chatId = destino ?? (c.conversa ? this.datos[id]?.chats[0]?.id : "");
    if (chatId === undefined) throw new ErrorCanal(`No hay ningún chat de ${c.nombre} al que entregar: empareja uno en ${RUTA_EMPAREJAR}`);
    texto = textoSinArtefactos(texto);
    await c.enviar(chatId, texto);
    if (c.conversa && this.chat(id, chatId)) this.estadoChat(id, chatId).entregado = texto.slice(0, MAX_CONTEXTO);
  }

  /** Vuelve a arrancar un canal (tras cambiar su secreto). */
  async reiniciar(id: IdCanal): Promise<void> {
    const c = this.canal(id);
    await c.detener();
    this.fallos.delete(id);
    if (this.iniciada && c.conversa && c.configurado()) await this.arrancar(c);
    this.avisar();
  }

  private async arrancar(c: Canal): Promise<void> {
    try {
      await c.iniciar(
        (m) => void this.recibir(c, m).catch((e) => this.log(`mensaje de ${c.nombre}: ${mensajeDe(e)}`)),
        (chatId, idBotones, valor) => this.pulsar(c, chatId, idBotones, valor),
      );
      this.fallos.delete(c.id);
      const e = c.estado();
      this.log(e.conectado ? `${c.nombre} conectado` : `${c.nombre} sin conexión por ahora (${e.error ?? "sin detalles"}); se reintenta`);
    } catch (e) {
      this.fallos.set(c.id, mensajeDe(e));
      this.log(`${c.nombre} no arranca: ${mensajeDe(e)}`);
    }
  }

  private async recibir(c: Canal, m: MensajeEntrante): Promise<void> {
    const texto = m.texto.trim();
    const chat = this.chat(c.id, m.chatId);
    if (!chat) return this.sinEmparejar(c, m, texto);
    if (!texto) return;
    const estado = this.estadoChat(c.id, chat.id);
    const orden = /^\/(parar|nueva|estado|start|ayuda)(?:@\S+)?(?:\s|$)/i.exec(texto)?.[1]?.toLowerCase();
    if (orden) return this.orden(c, chat, estado, orden);
    const espera = estado.esperas[0];
    if (espera) {
      if (!this.responder(c, chat.id, espera, texto, false)) await this.enviar(c, chat.id, espera.pista);
      return;
    }
    const sesion = estado.sesionId ?? chat.sesionId;
    if (sesion && this.motor.trabajando(sesion) && this.motor.steer(sesion, texto)) return;
    if (estado.trabajando) {
      estado.cola.push(texto);
      return;
    }
    await this.conversar(c, chat, texto);
  }

  private async sinEmparejar(c: Canal, m: MensajeEntrante, texto: string): Promise<void> {
    const codigo = /^(?:\/start(?:@\S+)?\s+)?(\d{6})$/.exec(texto)?.[1];
    const pendiente = this.codigos.get(c.id);
    const ahora = Date.now();
    if (codigo && pendiente && pendiente.caduca > ahora) {
      if (codigo === pendiente.codigo) {
        this.codigos.delete(c.id);
        this.datosDe(c.id).chats.push({ id: m.chatId, nombre: m.nombre || m.chatId, emparejado: new Date(ahora).toISOString() });
        this.guardar();
        this.avisar();
        this.log(`${c.nombre}: emparejado el chat ${m.nombre} (${m.chatId})`);
        return this.enviar(c, m.chatId, `Emparejado. Ya puedes hablar con Aquiles desde aquí. ${ORDENES}`);
      }
      pendiente.fallos += 1;
      if (pendiente.fallos >= MAX_FALLOS_CODIGO) this.codigos.delete(c.id);
    }
    if (codigo) return this.enviar(c, m.chatId, `Ese código no vale o ha caducado. Genera otro en ${RUTA_EMPAREJAR}.`);
    const k = clave(c.id, m.chatId);
    if (ahora - (this.avisados.get(k) ?? 0) < PAUSA_AVISO_MS) return;
    this.avisados.set(k, ahora);
    await this.enviar(c, m.chatId, SIN_EMPAREJAR);
  }

  private async orden(c: Canal, chat: ChatCanal, estado: EstadoChat, orden: string): Promise<void> {
    const sesion = estado.sesionId ?? chat.sesionId;
    switch (orden) {
      case "parar": {
        estado.cola.length = 0;
        soltarEsperas(estado);
        if (sesion && this.motor.parar(sesion)) return this.enviar(c, chat.id, "Parado.");
        return this.enviar(c, chat.id, estado.trabajando ? "Aún está arrancando; prueba otra vez en un momento." : "No hay nada en marcha.");
      }
      case "nueva":
        estado.generacion += 1;
        delete chat.sesionId;
        this.guardar();
        this.avisar();
        return this.enviar(c, chat.id, "Vale: el próximo mensaje empieza una conversación nueva.");
      case "estado": {
        const lineas = [
          `Emparejado desde el ${new Date(chat.emparejado).toLocaleString("es-ES")}.`,
          sesion ? `Sesión ${sesion}${estado.trabajando || this.motor.trabajando(sesion) ? ", trabajando" : ""}.` : "Sin sesión: el próximo mensaje abre una.",
          ...(estado.esperas.length ? ["Esperando tu respuesta."] : []),
        ];
        return this.enviar(c, chat.id, lineas.join("\n"));
      }
      default:
        return this.enviar(c, chat.id, `Este chat ya está emparejado con Aquiles: escribe lo que necesites. ${ORDENES}`);
    }
  }

  private async conversar(c: Canal, chat: ChatCanal, texto: string): Promise<void> {
    if (!this.chat(c.id, chat.id)) return;
    const estado = this.estadoChat(c.id, chat.id);
    const generacion = estado.generacion;
    const previa = chat.sesionId && this.motor.existeSesion(chat.sesionId) ? chat.sesionId : undefined;
    estado.trabajando = true;
    estado.sesionId = previa;
    const contexto = estado.entregado;
    estado.entregado = undefined;
    const escribiendo = this.escribiendo(c, chat.id);
    let respuesta: string | undefined;
    try {
      const { sesionId, resultado } = await this.motor.turno({
        ...(previa
          ? { sesionId: previa }
          : {
              nueva: {
                cwd: this.motor.ajustes().carpeta || this.cwdPorDefecto,
                titulo: `${c.nombre} · ${chat.nombre}`,
                origen: { tipo: "canal" as const, canal: c.id, chatId: chat.id },
              },
            }),
        texto: contexto ? `[Antes enviaste a este chat:]\n${contexto}\n\n[El usuario responde:]\n${texto}` : texto,
        aprobar: (p) => this.aprobar(c, chat.id, p),
        preguntar: (p) => this.preguntar(c, chat.id, p),
        alEvento: (e) => {
          const id = sesionDe(e);
          if (id && id !== estado.sesionId) this.conocerSesion(c.id, chat.id, generacion, id);
        },
      });
      this.conocerSesion(c.id, chat.id, generacion, sesionId);
      respuesta = textoFinal(resultado);
    } catch (e) {
      respuesta = `No he podido responder: ${mensajeDe(e)}`;
    } finally {
      clearInterval(escribiendo);
      estado.trabajando = false;
      estado.sesionId = undefined;
    }
    if (respuesta && this.chat(c.id, chat.id)) await this.enviar(c, chat.id, respuesta);
    const pendientes = estado.cola.splice(0);
    if (pendientes.length) await this.conversar(c, chat, pendientes.join("\n\n"));
  }

  /** Sesión del turno en marcha: se le pasan los mensajes en cola y se guarda en el chat (salvo si hubo /nueva). */
  private conocerSesion(id: IdCanal, chatId: string, generacion: number, sesionId: string): void {
    const estado = this.estadoChat(id, chatId);
    if (estado.trabajando) {
      estado.sesionId = sesionId;
      const cola = estado.cola.splice(0);
      estado.cola.push(...cola.filter((t) => !this.motor.steer(sesionId, t)));
    }
    const chat = this.chat(id, chatId);
    if (!chat || generacion !== estado.generacion || chat.sesionId === sesionId) return;
    chat.sesionId = sesionId;
    this.guardar();
    this.avisar();
  }

  private escribiendo(c: Canal, chatId: string): ReturnType<typeof setInterval> | undefined {
    if (!c.escribiendo) return undefined;
    const latir = () => void c.escribiendo?.(chatId).catch(() => {});
    latir();
    return setInterval(latir, LATIDO_ESCRIBIENDO_MS);
  }

  private async aprobar(c: Canal, chatId: string, p: PeticionAprobacion): Promise<RespuestaAprobacion> {
    const peticion = [`Aquiles pide permiso para ${p.herramienta}:`, p.resumen, p.motivo && `(${p.motivo})`].filter(Boolean).join("\n");
    const r = await this.esperar(c, chatId, `${peticion}\n\nResponde permitir, siempre o denegar.`, {
      opciones: DECISIONES.map((d) => ({ valor: d.valor, texto: d.texto })),
      interpretar: (v) => DECISIONES.find((d) => d.valor === normalizar(v))?.valor,
      confirmar: (decision) => DECISIONES.find((d) => d.valor === decision)?.hecho,
      pista: "Responde permitir, siempre o denegar (o /parar).",
      porDefecto: "denegar",
      caducado: "Sin respuesta en 10 minutos: denegado.",
    });
    return r as RespuestaAprobacion;
  }

  private preguntar(c: Canal, chatId: string, p: Pregunta): Promise<string> {
    const opciones = p.opciones ?? [];
    const texto = opciones.length ? `${p.texto}\n\n${opciones.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : p.texto;
    return this.esperar(c, chatId, texto, {
      opciones: opciones.map((o, i) => ({ valor: String(i), texto: o })),
      interpretar: (v, porBoton) => (porBoton ? opciones[Number(v)] : elegir(opciones, v, p.multiple)),
      confirmar: (r, porBoton) => (porBoton ? `Elegido: ${r}` : undefined),
      pista: "",
      porDefecto: "No hay nadie para responder; decide tú.",
      caducado: "Sin respuesta en 10 minutos: Aquiles decidirá por su cuenta.",
    });
  }

  private async esperar(
    c: Canal,
    chatId: string,
    texto: string,
    o: Omit<Espera, "idBotones" | "resolver"> & { opciones: Botones["opciones"]; caducado: string },
  ): Promise<string> {
    const estado = this.estadoChat(c.id, chatId);
    const idBotones = crypto.randomUUID().slice(0, 8);
    await c.enviar(chatId, texto, o.opciones.length ? { id: idBotones, opciones: o.opciones } : undefined);
    return new Promise((ok) => {
      const plazo = setTimeout(() => {
        espera.resolver(o.porDefecto);
        void this.enviar(c, chatId, o.caducado);
      }, PLAZO_RESPUESTA_MS);
      plazo.unref?.();
      const espera: Espera = {
        idBotones,
        interpretar: o.interpretar,
        confirmar: o.confirmar,
        pista: o.pista,
        porDefecto: o.porDefecto,
        resolver: (r) => {
          clearTimeout(plazo);
          const i = estado.esperas.indexOf(espera);
          if (i >= 0) estado.esperas.splice(i, 1);
          ok(r);
        },
      };
      estado.esperas.push(espera);
    });
  }

  /** Resuelve una espera con lo que llegó; false si no vale. */
  private responder(c: Canal, chatId: string, espera: Espera, valor: string, porBoton: boolean): boolean {
    const r = espera.interpretar(valor, porBoton);
    if (r === undefined) return false;
    espera.resolver(r);
    const confirmacion = espera.confirmar(r, porBoton);
    if (confirmacion) void this.enviar(c, chatId, confirmacion);
    return true;
  }

  private pulsar(c: Canal, chatId: string, idBotones: string, valor: string): void {
    // Los botones solo valen en chats emparejados, aunque alguien reenvíe uno.
    if (!this.chat(c.id, chatId)) return;
    const espera = this.estadoChat(c.id, chatId).esperas.find((e) => e.idBotones === idBotones);
    if (!espera) return void this.enviar(c, chatId, "Eso ya no está pendiente.");
    this.responder(c, chatId, espera, valor, true);
  }

  /** Los artefactos no se pueden ver en un chat: llega una referencia (están en la sesión, en la app). */
  private async enviar(c: Canal, chatId: string, texto: string): Promise<void> {
    await c.enviar(chatId, textoSinArtefactos(texto)).catch((e) => this.log(`no se pudo enviar a ${c.nombre} ${chatId}: ${mensajeDe(e)}`));
  }

  private canal(id: IdCanal): Canal {
    const c = this.canales.find((x) => x.id === id);
    if (!c) throw new ErrorCanal(`El canal ${id} no está disponible`);
    return c;
  }

  private chat(id: IdCanal, chatId: string): ChatCanal | undefined {
    return this.datos[id]?.chats.find((c) => c.id === chatId);
  }

  private datosDe(id: IdCanal): DatosCanal {
    let d = this.datos[id];
    if (!d) this.datos[id] = d = { opciones: {}, chats: [] };
    return d;
  }

  private estadoChat(id: IdCanal, chatId: string): EstadoChat {
    const k = clave(id, chatId);
    let e = this.estados.get(k);
    if (!e) this.estados.set(k, (e = { trabajando: false, cola: [], esperas: [], generacion: 0 }));
    return e;
  }

  private info(c: Canal): InfoCanal {
    const e = c.estado();
    const error = e.error ?? this.fallos.get(c.id);
    return {
      id: c.id,
      nombre: c.nombre,
      configurado: c.configurado(),
      conversa: c.conversa,
      conectado: e.conectado,
      ...(error ? { error } : {}),
      opciones: c.opciones(),
      secretos: c.secretos(),
      chats: (this.datos[c.id]?.chats ?? []).map((ch) => ({ ...ch })),
    };
  }

  private firmaEstado(): string {
    return JSON.stringify(this.canales.map((c) => [c.estado(), this.fallos.get(c.id)]));
  }

  private avisar(): void {
    this.motor.emitir({ tipo: "canales.actualizados" });
  }

  private log(mensaje: string): void {
    this.motor.log(`canales: ${mensaje}`);
  }

  private cargar(): Partial<Record<IdCanal, DatosCanal>> {
    if (!this.ruta || !existsSync(this.ruta)) return {};
    try {
      return JSON.parse(readFileSync(this.ruta, "utf8"));
    } catch (e) {
      this.log(`no se pudo leer ${this.ruta}: ${mensajeDe(e)}`);
      return {};
    }
  }

  private guardar(): void {
    if (this.ruta) writeFileSync(this.ruta, `${JSON.stringify(this.datos, null, 2)}\n`);
  }
}

function clave(id: IdCanal, chatId: string): string {
  return `${id}:${chatId}`;
}

/** Contesta lo pendiente con su respuesta por defecto, para que el turno no se quede esperando. */
function soltarEsperas(estado: EstadoChat): void {
  for (const e of [...estado.esperas]) e.resolver(e.porDefecto);
}

function sesionDe(e: Evento): string | undefined {
  if (e.tipo === "sesion.actualizada") return e.sesion.sesionId;
  return "sesionId" in e ? e.sesionId : undefined;
}

function textoFinal(r: ResultadoTurno): string | undefined {
  switch (r.motivo) {
    case "fin":
      return r.texto.trim() || "Hecho.";
    case "limite":
      return `${r.texto.trim()}\n\n(Me he quedado sin pasos en este turno; dime si sigo.)`.trim();
    case "error":
      return `No he podido terminar: ${r.error ?? "error sin detalles"}`;
    case "parado":
      return undefined;
  }
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/** Respuesta escrita a una pregunta con opciones: un número («2»), varios («1, 3») o el texto de una opción. */
function elegir(opciones: string[], texto: string, multiple?: boolean): string {
  const t = texto.trim();
  const numeros = t.split(/\s*,\s*/).map(Number);
  if (numeros.every((n) => Number.isInteger(n) && n >= 1 && n <= opciones.length) && (multiple || numeros.length === 1)) {
    return numeros.map((n) => opciones[n - 1]).join(", ");
  }
  return opciones.find((o) => normalizar(o) === normalizar(t)) ?? t;
}
