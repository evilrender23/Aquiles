/**
 * Dictado en Linux, que no trae reconocedor de voz del sistema: Vosk (https://alphacephei.com/vosk), sin conexión,
 * con su modelo pequeño de español. Se instala desde Ajustes › General › Voz en `<datos>/dictado/`:
 *   vosk/libvosk.so    la biblioteca (de las releases de vosk-api en GitHub)
 *   modelo/            vosk-model-small-es
 * Las descargas van fijadas por su SHA-256.
 *
 * Cada frase la reconoce un proceso aparte (`aquiles-nucleo --dictado-linux <segundos> <carpeta>`), como el
 * `aquiles-dictado` de Mac: graba del micrófono con `parecord` (PulseAudio o PipeWire) o `arecord` (ALSA), le pasa
 * el audio a Vosk por FFI y contesta con una línea JSON. Si la biblioteca falla, cae ese proceso y no el núcleo.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { miembrosZip } from "./zip";

export const VERSION_VOSK = "0.3.45";
export const MODELO_VOSK = "vosk-model-small-es-0.42";
/** Lo que ocupan las dos descargas, para decirlo antes de instalar. */
export const MB_DICTADO = 47;
const FRECUENCIA = 16_000;
/** Como en Windows y Mac: la frase acaba tras 1,5 s de silencio. */
const SILENCIO_FINAL_MS = 1500;
/** Una frase no dura más que esto después del tiempo de espera inicial. */
const MAX_FRASE_MS = 30_000;

export interface Descarga {
  url: string;
  sha256: string;
}

const LIBRERIAS: Record<string, Descarga> = {
  x64: {
    url: `https://github.com/alphacep/vosk-api/releases/download/v${VERSION_VOSK}/vosk-linux-x86_64-${VERSION_VOSK}.zip`,
    sha256: "bbdc8ed85c43979f6443142889770ea95cbfbc56cffb5c5dcd73afa875c5fbb2",
  },
  arm64: {
    url: `https://github.com/alphacep/vosk-api/releases/download/v${VERSION_VOSK}/vosk-linux-aarch64-${VERSION_VOSK}.zip`,
    sha256: "45e95d37755deb07568e79497d7feba8c03aee5a9e071df29961aa023fd94541",
  },
};
const MODELO: Descarga = {
  url: `https://alphacephei.com/vosk/models/${MODELO_VOSK}.zip`,
  sha256: "09b239888f633ef2f0b4e09736e3d9936acfd810bc65d53fad45261762c6511f",
};

export const rutaLibreria = (dir: string) => join(dir, "vosk", "libvosk.so");
export const rutaModelo = (dir: string) => join(dir, "modelo");

export function dictadoInstalado(dir: string): boolean {
  return existsSync(rutaLibreria(dir)) && existsSync(join(rutaModelo(dir), "am", "final.mdl"));
}

export interface OpcionesInstalar {
  fetch?: typeof fetch;
  arquitectura?: string;
  /** Para los tests: otras descargas. */
  fuentes?: { libreria: Descarga; modelo: Descarga };
}

/** Descarga Vosk y el modelo, comprueba sus huellas y los deja en `dir` (en una carpeta aparte hasta acabar). */
export async function instalarDictado(dir: string, o: OpcionesInstalar = {}): Promise<void> {
  const arquitectura = o.arquitectura ?? process.arch;
  const libreria = o.fuentes?.libreria ?? LIBRERIAS[arquitectura];
  if (!libreria) throw new Error(`El dictado de Linux no está para esta arquitectura (${arquitectura}); solo para x86_64 y ARM64.`);
  const modelo = o.fuentes?.modelo ?? MODELO;
  const nuevo = `${dir}.nuevo`;
  rmSync(nuevo, { recursive: true, force: true });
  try {
    for (const [d, carpeta] of [[libreria, "vosk"], [modelo, "modelo"]] as const) {
      const r = await (o.fetch ?? fetch)(d.url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!r.ok) throw new Error(`No se pudo descargar ${d.url} (${r.status})`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const huella = createHash("sha256").update(bytes).digest("hex");
      if (huella !== d.sha256) throw new Error(`La descarga de ${d.url} no es la esperada (SHA-256 ${huella})`);
      extraerSinRaiz(bytes, join(nuevo, carpeta));
    }
    if (!dictadoInstalado(nuevo)) throw new Error("Las descargas del dictado no traen lo esperado (libvosk.so y el modelo)");
    writeFileSync(join(nuevo, "instalado.json"), `${JSON.stringify({ vosk: VERSION_VOSK, modelo: MODELO_VOSK }, null, 2)}\n`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(nuevo, dir);
  } finally {
    rmSync(nuevo, { recursive: true, force: true });
  }
}

/** Descomprime quitando la carpeta de primer nivel (`vosk-linux-x86_64-0.3.45/`, `vosk-model-small-es-0.42/`). */
function extraerSinRaiz(zip: Uint8Array, destino: string): void {
  const raiz = resolve(destino);
  for (const m of miembrosZip(zip)) {
    const relativa = m.nombre.split("/").slice(1).join("/");
    if (!relativa) continue;
    const ruta = resolve(raiz, relativa);
    if (!ruta.startsWith(raiz + sep)) throw new Error(`Nombre no válido en el zip: ${m.nombre}`);
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, m.leer());
  }
}

// ——— Escuchar una frase ———

/** Lo que hace falta de un reconocedor (Vosk, o uno de prueba). Los textos ya vienen sin el JSON. */
export interface Reconocedor {
  /** Audio PCM de 16 bits; true si acaba de cerrar un trozo de frase (léelo con `resultado`). */
  aceptar(pcm: Uint8Array): boolean;
  resultado(): string;
  parcial(): string;
  final(): string;
  cerrar(): void;
}

/**
 * Escucha hasta tener una frase: espera hasta `segundos` a que se hable y, cuando se ha hablado, acaba tras 1,5 s
 * sin nada nuevo (Vosk corta en pausas más cortas: los trozos se juntan). `bytes`: cuánto audio llegó (0 = el
 * micrófono no dio nada).
 */
export async function escucharFrase(
  audio: AsyncIterable<Uint8Array>,
  r: Reconocedor,
  segundos: number,
  ahora: () => number = () => performance.now(),
): Promise<{ texto: string; bytes: number }> {
  const inicio = ahora();
  const trozos: string[] = [];
  let bytes = 0;
  let resto: Uint8Array | undefined;
  let parcial = "";
  let ultimoSonido: number | undefined;
  const texto = () => trozos.join(" ").replace(/\s+/g, " ").trim();
  for await (let pcm of audio) {
    bytes += pcm.length;
    // Muestras de 2 bytes: un byte suelto espera al siguiente trozo.
    if (resto) pcm = concatenar(resto, pcm);
    resto = pcm.length % 2 ? pcm.slice(-1) : undefined;
    if (resto) pcm = pcm.subarray(0, -1);
    if (pcm.length === 0) continue;
    const t = ahora();
    if (r.aceptar(pcm)) {
      const frase = r.resultado();
      if (frase) {
        trozos.push(frase);
        ultimoSonido = t;
      }
      parcial = "";
    } else {
      const p = r.parcial();
      if (p && p !== parcial) ultimoSonido = t;
      parcial = p;
    }
    if (ultimoSonido === undefined) {
      if (t - inicio > segundos * 1000) return { texto: "", bytes };
    } else if (!parcial && trozos.length > 0 && t - ultimoSonido > SILENCIO_FINAL_MS) {
      return { texto: texto(), bytes };
    }
    if (t - inicio > segundos * 1000 + MAX_FRASE_MS) break;
  }
  const ultimo = r.final();
  if (ultimo) trozos.push(ultimo);
  return { texto: texto(), bytes };
}

function concatenar(a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}

/** Con qué grabar: audio PCM de 16 bits, mono, a 16 kHz, por stdout. */
export function ordenGrabadora(buscar: (programa: string) => string | null = (p) => Bun.which(p)): string[] | undefined {
  const parecord = buscar("parecord");
  if (parecord) return [parecord, "--raw", "--format=s16le", `--rate=${FRECUENCIA}`, "--channels=1", "--latency-msec=100"];
  const arecord = buscar("arecord");
  if (arecord) return [arecord, "-q", "-f", "S16_LE", "-r", String(FRECUENCIA), "-c", "1", "-t", "raw", "--buffer-time=200000", "-"];
  return undefined;
}

/** Vosk por FFI. */
export function abrirVosk(dir: string, frecuencia = FRECUENCIA): Reconocedor {
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const { symbols: v, close } = dlopen(rutaLibreria(dir), {
    vosk_set_log_level: { args: [FFIType.i32], returns: FFIType.void },
    vosk_model_new: { args: [FFIType.cstring], returns: FFIType.ptr },
    vosk_model_free: { args: [FFIType.ptr], returns: FFIType.void },
    vosk_recognizer_new: { args: [FFIType.ptr, FFIType.f32], returns: FFIType.ptr },
    vosk_recognizer_free: { args: [FFIType.ptr], returns: FFIType.void },
    vosk_recognizer_accept_waveform: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    vosk_recognizer_result: { args: [FFIType.ptr], returns: FFIType.cstring },
    vosk_recognizer_partial_result: { args: [FFIType.ptr], returns: FFIType.cstring },
    vosk_recognizer_final_result: { args: [FFIType.ptr], returns: FFIType.cstring },
  });
  v.vosk_set_log_level(-1);
  const modelo = v.vosk_model_new(Buffer.from(`${rutaModelo(dir)}\0`));
  if (!modelo) {
    close();
    throw new Error("Vosk no pudo cargar el modelo");
  }
  const rec = v.vosk_recognizer_new(modelo, frecuencia);
  if (!rec) {
    v.vosk_model_free(modelo);
    close();
    throw new Error("Vosk no pudo crear el reconocedor");
  }
  const campo = (json: unknown, nombre: "text" | "partial") => {
    try {
      const valor = JSON.parse(String(json))[nombre];
      return typeof valor === "string" ? valor.trim() : "";
    } catch {
      return "";
    }
  };
  return {
    aceptar: (pcm) => v.vosk_recognizer_accept_waveform(rec, pcm, pcm.length) === 1,
    resultado: () => campo(v.vosk_recognizer_result(rec), "text"),
    parcial: () => campo(v.vosk_recognizer_partial_result(rec), "partial"),
    final: () => campo(v.vosk_recognizer_final_result(rec), "text"),
    cerrar: () => {
      v.vosk_recognizer_free(rec);
      v.vosk_model_free(modelo);
      close();
    },
  };
}

/** `aquiles-nucleo --dictado-linux <segundos> <carpeta>`: una frase, y una línea JSON con `texto` o `error`. */
export async function principalDictado(args: string[], salida: (linea: string) => void = (l) => console.log(l)): Promise<number> {
  const responder = (datos: Record<string, unknown>) => salida(JSON.stringify(datos));
  const segundos = Math.max(1, Math.min(120, Number(args[0]) || 15));
  const dir = args[1];
  if (!dir || !dictadoInstalado(dir)) {
    responder({ error: "sin-motor" });
    return 0;
  }
  const orden = ordenGrabadora();
  if (!orden) {
    responder({ error: "sin-grabadora" });
    return 0;
  }
  let r: Reconocedor;
  try {
    r = abrirVosk(dir);
  } catch (e) {
    responder({ error: "sin-motor", detalle: e instanceof Error ? e.message : String(e) });
    return 0;
  }
  const grabadora = Bun.spawn(orden, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  // Si cortan el dictado (parar), la grabadora se va con él.
  const salir = () => {
    grabadora.kill();
    process.exit(0);
  };
  process.on("SIGTERM", salir);
  process.on("SIGINT", salir);
  try {
    const { texto, bytes } = await escucharFrase(grabadora.stdout, r, segundos);
    if (bytes === 0) {
      const error = (await new Response(grabadora.stderr).text()).trim();
      responder({ error: "sin-microfono", ...(error ? { detalle: error.slice(0, 300) } : {}) });
    } else responder({ texto, idioma: "es-ES" });
  } catch (e) {
    responder({ error: "reconocedor", detalle: e instanceof Error ? e.message : String(e) });
  } finally {
    grabadora.kill();
    r.cerrar();
  }
  return 0;
}
