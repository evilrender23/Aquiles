/**
 * Correo: solo entrega, con un cliente SMTP propio (EHLO, STARTTLS o TLS implícito, AUTH PLAIN o LOGIN, DATA).
 * El asunto es la primera línea del texto. La clave va en AQUILES_CORREO_CLAVE; el usuario, si falta, es el remitente.
 */
import { hostname } from "node:os";
import { isIP, connect as conectarTcp, type Socket } from "node:net";
import { connect as conectarTls } from "node:tls";
import { type Canal, ErrorCanal, mensajeDe } from "./canal";

const CLAVE = "AQUILES_CORREO_CLAVE";
const OPCIONES = ["servidor", "puerto", "seguridad", "usuario", "de", "para"];
const SEGURIDADES = ["tls", "starttls", "ninguna"] as const;
type Seguridad = (typeof SEGURIDADES)[number];
const PUERTOS: Record<Seguridad, number> = { tls: 465, starttls: 587, ninguna: 25 };
const LOCALES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PLAZO_MS = 30_000;
const MAX_ASUNTO = 78;
/** Una línea de más de 998 octetos no cabe en 8 bits: el cuerpo va entonces en base64. */
const MAX_LINEA = 998;
const DIRECCION = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;

export interface Correo {
  servidor: string;
  puerto: number;
  seguridad: Seguridad;
  usuario?: string;
  clave?: string;
  de: string;
  para: string[];
  asunto: string;
  cuerpo: string;
  /** Certificado raíz de confianza adicional (servidores de prueba). */
  ca?: string;
}

export class CanalCorreo implements Canal {
  readonly id = "correo";
  readonly nombre = "Correo";
  readonly conversa = false;
  private datos: Record<string, string> = {};
  private ultimoError?: string;

  /** `ca`: certificado raíz adicional en el que confiar (para probar TLS contra un servidor local). */
  constructor(private o: { ca?: string } = {}) {}

  configurado(): boolean {
    return Boolean(this.datos.servidor && this.datos.de);
  }

  secretos(): Record<string, boolean> {
    return { [CLAVE]: Boolean(process.env[CLAVE]) };
  }

  opciones(): Record<string, string> {
    return { ...this.datos };
  }

  configurar(opciones: Record<string, string>): void {
    const desconocidas = Object.keys(opciones).filter((k) => !OPCIONES.includes(k));
    if (desconocidas.length) throw new ErrorCanal(`Opciones desconocidas del correo: ${desconocidas.join(", ")} (valen ${OPCIONES.join(", ")})`);
    const { servidor, puerto, seguridad, usuario, de, para } = opciones;
    if (servidor !== undefined && !/^[\w.-]+$|^\[?[\d:a-f.]+\]?$/i.test(servidor)) throw new ErrorCanal(`El servidor «${servidor}» no es válido`);
    if (puerto !== undefined && !(/^\d+$/.test(puerto) && Number(puerto) >= 1 && Number(puerto) <= 65535)) throw new ErrorCanal(`El puerto «${puerto}» no es válido`);
    if (seguridad !== undefined && !SEGURIDADES.includes(seguridad as Seguridad)) throw new ErrorCanal(`La seguridad tiene que ser ${SEGURIDADES.join(", ")}`);
    if (seguridad === "ninguna" && !LOCALES.has(servidor?.toLowerCase() ?? "")) {
      throw new ErrorCanal("Sin cifrado solo se permite con un servidor local (localhost o 127.0.0.1): la clave viajaría en claro");
    }
    if (usuario !== undefined && (/\s/.test(usuario) || usuario.includes("\0"))) throw new ErrorCanal("El usuario no puede tener espacios");
    if (de !== undefined && !DIRECCION.test(de)) throw new ErrorCanal(`«${de}» no es una dirección de correo`);
    for (const d of para === undefined ? [] : direcciones(para)) if (!DIRECCION.test(d)) throw new ErrorCanal(`«${d}» no es una dirección de correo`);
    this.datos = { ...opciones };
  }

  async iniciar(): Promise<void> {}

  async detener(): Promise<void> {}

  /** `chatId`: destinatarios separados por comas; si está vacío, los de la opción `para`. */
  async enviar(chatId: string, texto: string): Promise<void> {
    const { servidor, de } = this.datos;
    if (!servidor || !de) throw new ErrorCanal("El correo no está configurado: faltan el servidor y el remitente");
    const para = direcciones(chatId || this.datos.para || "");
    if (!para.length) throw new ErrorCanal("Falta el destinatario: pon «para» en las opciones del correo");
    const malas = para.filter((d) => !DIRECCION.test(d));
    if (malas.length) throw new ErrorCanal(`${malas.join(", ")} no es una dirección de correo`);
    const seguridad = (this.datos.seguridad as Seguridad | undefined) ?? (this.datos.puerto === "465" ? "tls" : "starttls");
    const clave = process.env[CLAVE];
    try {
      await enviarCorreo({
        servidor,
        puerto: this.datos.puerto ? Number(this.datos.puerto) : PUERTOS[seguridad],
        seguridad,
        ...(clave ? { usuario: this.datos.usuario || de, clave } : {}),
        de,
        para,
        asunto: asunto(texto),
        cuerpo: texto,
        ...(this.o.ca ? { ca: this.o.ca } : {}),
      });
      this.ultimoError = undefined;
    } catch (e) {
      this.ultimoError = mensajeDe(e);
      throw e;
    }
  }

  estado(): { conectado: boolean; error?: string } {
    return { conectado: false, ...(this.ultimoError ? { error: this.ultimoError } : {}) };
  }
}

function direcciones(texto: string): string[] {
  return texto
    .split(/[,;]/)
    .map((d) => d.trim())
    .filter(Boolean);
}

function asunto(texto: string): string {
  const primera = texto.trim().split(/\r?\n/)[0]?.trim() || "Aquiles";
  return primera.length > MAX_ASUNTO ? `${primera.slice(0, MAX_ASUNTO - 1)}…` : primera;
}

/** Envía un correo; lanza con la respuesta del servidor si algo falla. */
export async function enviarCorreo(c: Correo): Promise<void> {
  const servername = isIP(c.servidor.replace(/^\[|\]$/g, "")) ? undefined : c.servidor;
  const host = c.servidor.replace(/^\[|\]$/g, "");
  const socket =
    c.seguridad === "tls" ? conectarTls({ host, port: c.puerto, servername, ca: c.ca }) : conectarTcp({ host, port: c.puerto });
  const smtp = new Smtp(socket);
  try {
    await smtp.listo(c.seguridad === "tls" ? "secureConnect" : "connect");
    await smtp.orden(null, 2);
    let capacidades = await smtp.ehlo();
    if (c.seguridad === "starttls") {
      // Sin STARTTLS no se sigue en claro: sería fácil forzar que la clave viaje sin cifrar.
      if (!capacidades.has("STARTTLS")) throw new Error("El servidor de correo no ofrece STARTTLS");
      await smtp.orden("STARTTLS", 2);
      await smtp.cifrar(servername, c.ca);
      capacidades = await smtp.ehlo();
    }
    if (c.clave) await smtp.autenticar(capacidades, c.usuario ?? c.de, c.clave);
    const lineas = c.cuerpo.split(/\r?\n/);
    const ochoBits = capacidades.has("8BITMIME") && lineas.every((l) => Buffer.byteLength(l) <= MAX_LINEA);
    await smtp.orden(`MAIL FROM:<${c.de}>${ochoBits ? " BODY=8BITMIME" : ""}`, 2);
    for (const d of c.para) await smtp.orden(`RCPT TO:<${d}>`, 2);
    await smtp.orden("DATA", 3);
    await smtp.orden(`${componer(c, lineas, ochoBits)}\r\n.`, 2);
    await smtp.orden("QUIT", 2).catch(() => {});
  } finally {
    smtp.cerrar();
  }
}

function componer(c: Correo, lineas: string[], ochoBits: boolean): string {
  const cabeceras = [
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `From: Aquiles <${c.de}>`,
    `To: ${c.para.join(", ")}`,
    `Subject: ${cabecera(c.asunto)}`,
    `Message-ID: <${crypto.randomUUID()}@${c.de.split("@")[1]}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${ochoBits ? "8bit" : "base64"}`,
  ];
  const cuerpo = ochoBits ? lineas : (Buffer.from(lineas.join("\r\n")).toString("base64").match(/.{1,76}/g) ?? []);
  // Dot-stuffing: una línea que empieza por «.» se dobla para que no se confunda con el final de DATA.
  return [...cabeceras, "", ...cuerpo.map((l) => (l.startsWith(".") ? `.${l}` : l))].join("\r\n");
}

/** Cabecera en ASCII tal cual; si no, como palabras codificadas (RFC 2047) de como mucho 75 caracteres. */
function cabecera(texto: string): string {
  if (/^[\x20-\x7e]*$/.test(texto)) return texto;
  const palabras: string[] = [];
  let trozo = "";
  for (const caracter of texto) {
    if (Buffer.byteLength(trozo + caracter) > 45) {
      palabras.push(trozo);
      trozo = "";
    }
    trozo += caracter;
  }
  palabras.push(trozo);
  return palabras.map((p) => `=?UTF-8?B?${Buffer.from(p).toString("base64")}?=`).join("\r\n ");
}

/** Conversación SMTP sobre un socket: órdenes de una línea y respuestas de varias («250-…» hasta «250 …»). */
class Smtp {
  private pendiente = "";
  private lineas: string[] = [];
  private fallo?: Error;
  private avisar?: () => void;

  constructor(private socket: Socket) {
    this.escuchar(socket);
  }

  listo(evento: "connect" | "secureConnect"): Promise<void> {
    return new Promise((ok, mal) => {
      this.socket.once(evento, () => ok());
      this.socket.once("error", mal);
    });
  }

  private escuchar(s: Socket): void {
    s.setTimeout(PLAZO_MS, () => s.destroy(new Error("El servidor de correo no responde")));
    s.on("data", (datos: Buffer) => {
      this.pendiente += datos.toString("utf8");
      for (let i = this.pendiente.indexOf("\r\n"); i >= 0; i = this.pendiente.indexOf("\r\n")) {
        this.lineas.push(this.pendiente.slice(0, i));
        this.pendiente = this.pendiente.slice(i + 2);
      }
      this.avisar?.();
    });
    s.on("error", (e) => {
      this.fallo = e;
      this.avisar?.();
    });
    s.on("close", () => {
      this.fallo ??= new Error("El servidor de correo cerró la conexión");
      this.avisar?.();
    });
  }

  /** Envía `linea` (si hay) y lee la respuesta; falla si su código no empieza por `clase` (2 = bien, 3 = sigue). */
  async orden(linea: string | null, clase: number): Promise<string[]> {
    if (linea !== null) this.socket.write(`${linea}\r\n`);
    const texto: string[] = [];
    for (;;) {
      while (!this.lineas.length) {
        if (this.fallo) throw this.fallo;
        await new Promise<void>((ok) => {
          this.avisar = ok;
        });
      }
      const l = this.lineas.shift()!;
      texto.push(l.slice(4));
      if (l[3] === "-") continue;
      if (l[0] !== String(clase)) throw new Error(`El servidor de correo respondió ${l}`);
      return texto;
    }
  }

  async ehlo(): Promise<Set<string>> {
    const nombre = hostname().replace(/[^\w.-]/g, "") || "aquiles";
    const lineas = await this.orden(`EHLO ${nombre}`, 2);
    return new Set(lineas.slice(1).flatMap((l) => {
      const [clave, ...resto] = l.toUpperCase().split(/[ =]/);
      return clave === "AUTH" ? resto.map((m) => `AUTH ${m}`) : [clave!];
    }));
  }

  async cifrar(servername: string | undefined, ca: string | undefined): Promise<void> {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
    this.socket.removeAllListeners("timeout");
    this.socket.setTimeout(0);
    this.socket = conectarTls({ socket: this.socket, servername, ca });
    this.escuchar(this.socket);
    await this.listo("secureConnect");
  }

  async autenticar(capacidades: Set<string>, usuario: string, clave: string): Promise<void> {
    const b64 = (t: string) => Buffer.from(t).toString("base64");
    if (capacidades.has("AUTH PLAIN")) {
      await this.orden(`AUTH PLAIN ${b64(`\0${usuario}\0${clave}`)}`, 2);
    } else if (capacidades.has("AUTH LOGIN")) {
      await this.orden("AUTH LOGIN", 3);
      await this.orden(b64(usuario), 3);
      await this.orden(b64(clave), 2);
    } else {
      throw new Error("El servidor de correo no ofrece AUTH PLAIN ni LOGIN");
    }
  }

  cerrar(): void {
    this.socket.destroy();
  }
}
