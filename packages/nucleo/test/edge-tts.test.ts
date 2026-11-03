import { afterAll, expect, test } from "bun:test";
import { duracionMs, nombreLargo, secMsGec, sintetizar, trocear } from "../src/edge-tts";

test("Sec-MS-GEC: SHA-256 de los ticks de Windows redondeados a 5 minutos (los mismos valores que edge-tts)", () => {
  const A = "A58E667C394188C05F0D6B1D4B7F2F6526F56ECC2B2B8BC31A507464B43E8F88";
  expect(secMsGec(1_793_700_000_000)).toBe(A);
  expect(secMsGec(1_793_700_299_999)).toBe(A);
  expect(secMsGec(1_793_700_300_000)).toBe("56CE4BDFAF178CA29D46C6CD898F22F329A77B989151936E0A968ECBF91CFA1E");
});

test("nombre de voz largo para el SSML", () => {
  expect(nombreLargo("es-ES-ElviraNeural")).toBe("Microsoft Server Speech Text to Speech Voice (es-ES, ElviraNeural)");
  expect(nombreLargo("en-US-AvaMultilingualNeural")).toBe("Microsoft Server Speech Text to Speech Voice (en-US, AvaMultilingualNeural)");
  expect(() => nombreLargo("Elvira")).toThrow("no válida");
});

test("trocear: por frases, el primero corto, ninguno pasa del límite y no se pierde texto", () => {
  expect(trocear("  Hola.   ¿Qué tal?\n\nBien  ")).toEqual(["Hola. ¿Qué tal? Bien"]);
  expect(trocear("   ")).toEqual([]);
  const frase = "Esta es una frase de prueba con acentos y eñes, para medir. ";
  const largo = frase.repeat(150);
  const trozos = trocear(largo);
  expect(Buffer.byteLength(trozos[0]!)).toBeLessThanOrEqual(500);
  for (const t of trozos) expect(Buffer.byteLength(t)).toBeLessThanOrEqual(3000);
  expect(trozos.join(" ").replace(/\s+/g, " ")).toBe(largo.trim().replace(/\s+/g, " "));
  // Una frase enorme sin puntos se corta por palabras.
  const sinPuntos = trocear("palabra ".repeat(1000));
  expect(sinPuntos.length).toBeGreaterThan(2);
  for (const t of sinPuntos) expect(t.startsWith("palabra")).toBe(true);
  // Los & < > cuentan escapados.
  for (const t of trocear("<&> ".repeat(800))) expect(Buffer.byteLength(t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))).toBeLessThanOrEqual(3000);
});

test("duración de un MP3 a 48 kbit/s", () => {
  expect(duracionMs(new Uint8Array(6000))).toBe(1000);
});

/** Un servicio de Edge falso: guarda lo que recibe y contesta con audio en dos mensajes y turn.end. */
type Datos = { url: string; cabeceras: Record<string, string>; mensajes: string[] };
const recibidos: Datos[] = [];
let modo: "audio" | "sin-audio" | "colgado" = "audio";
const cabecera = (texto: string) => {
  const c = Buffer.from(texto, "utf8");
  return Buffer.concat([Buffer.from([c.length >> 8, c.length & 0xff]), c]);
};
const servidor = Bun.serve<Datos>({
  port: 0,
  fetch(req, s) {
    const cabeceras = Object.fromEntries(req.headers.entries());
    if (s.upgrade(req, { data: { url: req.url, cabeceras, mensajes: [] } })) return;
    return new Response("no", { status: 400 });
  },
  websocket: {
    open(ws) {
      recibidos.push(ws.data);
    },
    message(ws, m) {
      ws.data.mensajes.push(String(m));
      if (!String(m).includes("Path:ssml")) return;
      if (modo === "colgado") return;
      if (modo === "sin-audio") return ws.close(1000, "sin audio");
      ws.send("X-RequestId:x\r\nPath:turn.start\r\n\r\n{}");
      ws.send(Buffer.concat([cabecera("X-RequestId:x\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n"), Buffer.from("MP3-1")]));
      ws.send(Buffer.concat([cabecera("X-RequestId:x\r\nPath:audio.metadata\r\n"), Buffer.from("no")]));
      ws.send(Buffer.concat([cabecera("X-RequestId:x\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n"), Buffer.from("MP3-2")]));
      ws.send("X-RequestId:x\r\nPath:turn.end\r\n\r\n{}");
    },
  },
});
afterAll(() => servidor.stop(true));
const url = () => `ws://127.0.0.1:${servidor.port}/edge`;

test("sintetizar: configuración, SSML con la voz, la velocidad y el texto escapado; junta el audio hasta turn.end", async () => {
  modo = "audio";
  const mp3 = await sintetizar(`Hola <b> & 'adiós' "fin"`, { voz: "es-ES-AlvaroNeural", velocidad: -20, url: url() });
  expect(Buffer.from(mp3).toString()).toBe("MP3-1MP3-2");
  const r = recibidos.at(-1)!;
  expect(r.url).toContain("TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4");
  expect(r.url).toMatch(/Sec-MS-GEC=[0-9A-F]{64}&Sec-MS-GEC-Version=1-\d+\./);
  expect(r.cabeceras.origin).toBe("chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
  expect(r.cabeceras["user-agent"]).toContain("Edg/");
  expect(r.mensajes[0]).toContain("Path:speech.config");
  expect(r.mensajes[0]).toContain('"outputFormat":"audio-24khz-48kbitrate-mono-mp3"');
  expect(r.mensajes[1]).toContain("Path:ssml");
  expect(r.mensajes[1]).toContain("<voice name='Microsoft Server Speech Text to Speech Voice (es-ES, AlvaroNeural)'>");
  expect(r.mensajes[1]).toContain("rate='-20%'");
  expect(r.mensajes[1]).toContain("Hola &lt;b&gt; &amp; &apos;adiós&apos; &quot;fin&quot;");
  expect(r.mensajes[1]).toMatch(/X-Timestamp:\w{3} \w{3} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT\+0000 \(Coordinated Universal Time\)Z/);
});

test("sintetizar: cierre sin audio, error claro; cancelar corta la espera", async () => {
  modo = "sin-audio";
  await expect(sintetizar("hola", { voz: "es-ES-ElviraNeural", url: url() })).rejects.toThrow("cerró la conexión: sin audio");
  modo = "colgado";
  const c = new AbortController();
  const espera = sintetizar("hola", { voz: "es-ES-ElviraNeural", url: url(), senal: c.signal });
  await Bun.sleep(50);
  c.abort();
  await expect(espera).rejects.toThrow("Cancelado");
  await expect(sintetizar("hola", { voz: "es-ES-ElviraNeural", url: "ws://127.0.0.1:1/nada" })).rejects.toThrow("No se pudo conectar");
});
