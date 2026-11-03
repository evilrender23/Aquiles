/**
 * Voces neuronales de Microsoft Edge («Leer en voz alta»): el servicio en línea que usa el navegador, sin clave.
 * Por WebSocket se manda la configuración y el texto en SSML, y el MP3 llega en mensajes binarios hasta `turn.end`.
 * Cada trozo de texto va en una conexión propia; el texto largo se parte por frases.
 */

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/** La versión de Edge que dice ser; el servicio la pide en Sec-MS-GEC-Version y en el User-Agent. */
const VERSION_EDGE = "143.0.3650.75";
const URL_EDGE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
/** La lista de voces, por HTTPS normal: aquí solo interesa la hora del servidor (cabecera Date). */
const URL_VOCES = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TOKEN}`;
const FORMATO = "audio-24khz-48kbitrate-mono-mp3";
/** kbit/s del formato: con él se sabe cuánto dura un MP3 sin decodificarlo. */
export const KBPS_EDGE = 48;
/** El servicio corta los mensajes de más de ~4 KB; con el SSML alrededor, el texto escapado cabe holgado en esto. */
const MAX_BYTES_TROZO = 3000;
/** El primer trozo, corto: así empieza a sonar enseguida mientras se pide el resto. */
const MAX_BYTES_PRIMERO = 500;
const LIMITE_MS = 30_000;

/** Lo que manda el servicio cuando el texto no tiene nada que leer o la voz no existe: cerrar sin audio. */
export class ErrorEdge extends Error {}

/**
 * Sec-MS-GEC: SHA-256 (en mayúsculas) de los ticks de Windows (100 ns desde 1601) redondeados a 5 minutos, seguidos
 * del token. Sin él, el servicio rechaza la conexión.
 */
export function secMsGec(ahoraMs = Date.now()): string {
  let s = Math.floor(ahoraMs / 1000) + 11_644_473_600;
  s -= s % 300;
  return new Bun.CryptoHasher("sha256").update(`${BigInt(s) * 10_000_000n}${TOKEN}`).digest("hex").toUpperCase();
}

/** «es-ES-ElviraNeural» → «Microsoft Server Speech Text to Speech Voice (es-ES, ElviraNeural)», como la pide el SSML. */
export function nombreLargo(voz: string): string {
  const m = voz.match(/^([a-z]{2,3}-[A-Z]{2,})-(.+)$/);
  if (!m) throw new ErrorEdge(`Voz de Edge no válida: ${voz}`);
  return `Microsoft Server Speech Text to Speech Voice (${m[1]}, ${m[2]})`;
}

/** Escapa lo que rompería el XML y cambia por espacios los caracteres de control, que el servicio no admite. */
function escapar(texto: string): string {
  return (
    texto
      // biome-ignore lint/suspicious/noControlCharactersInRegex: justo esos son los que hay que quitar.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

const bytes = (t: string) => Buffer.byteLength(escapar(t), "utf8");

/**
 * Parte el texto en trozos que el servicio acepta, por frases (o por palabras si una frase no cabe). El primero es corto
 * para que la lectura empiece pronto.
 */
export function trocear(texto: string): string[] {
  const frases = texto.replace(/\s+/g, " ").trim().match(/[^.!?;:…\n]+[.!?;:…]*\s*/g) ?? [];
  const trozos: string[] = [];
  let actual = "";
  const limite = () => (trozos.length === 0 ? MAX_BYTES_PRIMERO : MAX_BYTES_TROZO);
  const cerrar = () => {
    if (actual.trim()) trozos.push(actual.trim());
    actual = "";
  };
  for (const frase of frases) {
    if (bytes(actual + frase) <= limite()) {
      actual += frase;
      continue;
    }
    cerrar();
    if (bytes(frase) <= limite()) {
      actual = frase;
      continue;
    }
    for (const palabra of frase.split(/(?<=\s)/)) {
      if (actual && bytes(actual + palabra) > limite()) cerrar();
      // Una «palabra» de más de 3 KB (una URL enorme): se corta a lo bruto.
      actual += bytes(palabra) > limite() ? palabra.slice(0, Math.floor(limite() / 4)) : palabra;
    }
  }
  cerrar();
  return trozos;
}

/** La fecha como la escribe JavaScript en el navegador: «Tue Nov 03 2026 10:00:00 GMT+0000 (Coordinated Universal Time)». */
function marcaDeTiempo(d = new Date()): string {
  const [dia, num, mes, anio, hora] = d.toUTCString().replace(",", "").split(" ");
  return `${dia} ${mes} ${num} ${anio} ${hora} GMT+0000 (Coordinated Universal Time)`;
}

const id = () => crypto.randomUUID().replaceAll("-", "");

export interface OpcionesEdge {
  voz: string;
  /** Velocidad en %, de -50 a +100 (0 = la normal). */
  velocidad?: number;
  senal?: AbortSignal;
  /** Para los tests: otro servidor y otra forma de abrir el WebSocket. */
  url?: string;
  abrir?: (url: string, cabeceras: Record<string, string>) => WebSocket;
}

/** El WebSocket de Bun admite cabeceras (el del navegador no, y los tipos del DOM no lo saben). */
const WebSocketConCabeceras = WebSocket as unknown as new (url: string, o: { headers: Record<string, string> }) => WebSocket;
const abrirWebSocket = (url: string, headers: Record<string, string>) => new WebSocketConCabeceras(url, { headers });

/** El MP3 de un trozo de texto (de los que da `trocear`). */
export function sintetizar(texto: string, o: OpcionesEdge): Promise<Uint8Array> {
  const mayor = VERSION_EDGE.split(".")[0];
  const url =
    `${o.url ?? URL_EDGE}?TrustedClientToken=${TOKEN}&ConnectionId=${id()}` +
    `&Sec-MS-GEC=${secMsGec(Date.now() + desfaseMs)}&Sec-MS-GEC-Version=1-${VERSION_EDGE}`;
  const cabeceras = {
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${mayor}.0.0.0 Safari/537.36 Edg/${mayor}.0.0.0`,
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: `muid=${id().toUpperCase()};`,
  };
  const velocidad = Math.round(Math.min(100, Math.max(-50, o.velocidad ?? 0)));
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${nombreLargo(o.voz)}'><prosody pitch='+0Hz' rate='${velocidad >= 0 ? "+" : ""}${velocidad}%' volume='+0%'>` +
    `${escapar(texto)}</prosody></voice></speak>`;

  return new Promise((resolver, rechazar) => {
    if (o.senal?.aborted) return rechazar(new Error("Cancelado"));
    const ws = (o.abrir ?? abrirWebSocket)(url, cabeceras);
    ws.binaryType = "arraybuffer";
    const audio: Uint8Array[] = [];
    let acabado = false;
    const acabar = (error?: Error) => {
      if (acabado) return;
      acabado = true;
      clearTimeout(limite);
      o.senal?.removeEventListener("abort", abortar);
      try {
        ws.close();
      } catch {}
      if (error) return rechazar(error);
      if (!audio.length) return rechazar(new ErrorEdge("Edge no devolvió audio (¿la voz existe?)"));
      resolver(Buffer.concat(audio));
    };
    const abortar = () => acabar(new Error("Cancelado"));
    const limite = setTimeout(() => acabar(new Error(`Edge no respondió en ${LIMITE_MS / 1000} s`)), LIMITE_MS);
    o.senal?.addEventListener("abort", abortar, { once: true });

    ws.onopen = () => {
      const ahora = marcaDeTiempo();
      ws.send(
        `X-Timestamp:${ahora}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${FORMATO}"}}}}\r\n`,
      );
      ws.send(`X-RequestId:${id()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ahora}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    };
    ws.onmessage = (m) => {
      if (typeof m.data === "string") {
        if (m.data.includes("Path:turn.end")) acabar();
        return;
      }
      // Binario: 2 bytes con el largo de la cabecera (big-endian), la cabecera y, si es Path:audio, el audio.
      const datos = new Uint8Array(m.data as ArrayBuffer);
      if (datos.length < 2) return;
      const largo = (datos[0]! << 8) | datos[1]!;
      const cabecera = Buffer.from(datos.subarray(2, 2 + largo)).toString("utf8");
      // Path exacto: también llegan «audio.metadata» y otros que no son sonido.
      if (/^Path:audio\r?$/m.test(cabecera) && datos.length > 2 + largo) audio.push(datos.slice(2 + largo));
    };
    ws.onerror = () => acabar(new Error("No se pudo conectar con el servicio de voz de Edge"));
    ws.onclose = (e) => acabar(audio.length ? undefined : new Error(`El servicio de voz de Edge cerró la conexión${e.reason ? `: ${e.reason}` : ""}`));
  });
}

/** Diferencia entre la hora del servidor y la de este equipo: con el reloj desfasado, Sec-MS-GEC no vale. */
let desfaseMs = 0;

/** Ajusta `desfaseMs` con la hora del servidor; true si cambió lo bastante para que valga la pena reintentar. */
async function ajustarReloj(): Promise<boolean> {
  try {
    const r = await fetch(URL_VOCES, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    const servidor = Date.parse(r.headers.get("date") ?? "");
    if (Number.isNaN(servidor)) return false;
    const nuevo = servidor - Date.now();
    const cambia = Math.abs(nuevo - desfaseMs) > 60_000;
    desfaseMs = nuevo;
    return cambia;
  } catch {
    return false;
  }
}

/** `sintetizar` con un reintento si la conexión falló por tener el reloj desfasado (el servicio la rechaza sin decir por qué). */
export async function sintetizarTrozo(texto: string, o: OpcionesEdge): Promise<Uint8Array> {
  try {
    return await sintetizar(texto, o);
  } catch (e) {
    if (o.senal?.aborted || e instanceof ErrorEdge || o.url || !(await ajustarReloj())) throw e;
    return sintetizar(texto, o);
  }
}

/** Milisegundos que dura un MP3 del formato de Edge (bitrate constante). */
export const duracionMs = (mp3: Uint8Array) => Math.ceil((mp3.length * 8) / KBPS_EDGE);
