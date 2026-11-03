/**
 * Voz con lo que trae cada sistema, sin conexión ni claves.
 * - Windows: System.Speech para dictar (el reconocedor del idioma) y para leer (sus voces). Cada operación es un
 *   PowerShell aparte que devuelve una línea JSON.
 * - Mac: `say` para leer y, para dictar, `aquiles-dictado` (apps/escritorio/src-tauri/macos/dictado.swift, con el
 *   reconocedor de voz de macOS), que va junto a este ejecutable dentro de Aquiles.app y también contesta en JSON.
 * - Linux: `espeak-ng` (o `espeak`) para leer y, si no está, `spd-say` (Speech Dispatcher). Sin dictado: Linux no
 *   trae un reconocedor de voz del sistema.
 * Una sola operación a la vez (leer mientras se dicta acabaría en el micrófono); parar() corta la que esté en marcha.
 */
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VELOCIDAD_VOZ, type AjustesVoz, type EstadoVoz, type VozSistema } from "@aquiles/protocolo";
import { WINDOWS } from "./herramientas/ficheros";
import { matarArbol } from "./herramientas/shell";

/** Un script de PowerShell → su salida. */
type Ejecutar = (script: string, senal: AbortSignal) => Promise<string>;
/** Un programa con sus argumentos → su salida (Mac y Linux). */
type Lanzar = (orden: string[], senal: AbortSignal) => Promise<string>;
export type SistemaVoz = "windows" | "mac" | "linux" | "ninguno";

interface Deteccion {
  reconocedores: string[];
  voces: VozSistema[];
  /** Linux: con qué se lee y, de cada voz, el nombre que entiende ese programa. */
  lector?: { programa: string; tipo: "espeak" | "spd"; codigos: Record<string, string> };
}

const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const SILENCIO_FINAL_S = 1.5;
/** Palabras por minuto de `say` y de `espeak-ng` a velocidad normal. */
const PPM_SAY = 180;
const PPM_ESPEAK = 175;
/** Lo que usa la lectura de los ajustes de voz. */
type AjustesLectura = Pick<AjustesVoz, "voz" | "velocidad">;
const SIN_AJUSTES: AjustesLectura = { velocidad: 0 };

// Primero es-ES, luego cualquier español y, si no, lo que haya.
const ELEGIR_RECONOCEDOR = `
$todos = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
$info = $todos | Where-Object { $_.Culture.Name -eq 'es-ES' } | Select-Object -First 1
if (-not $info) { $info = $todos | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq 'es' } | Select-Object -First 1 }
if (-not $info) { $info = $todos | Select-Object -First 1 }`;

const SCRIPT_ESTADO = `Add-Type -AssemblyName System.Speech
$r = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name })
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$v = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { @{ nombre = $_.VoiceInfo.Name; idioma = $_.VoiceInfo.Culture.Name } })
$s.Dispose()
ConvertTo-Json -Compress -Depth 3 @{ reconocedores = $r; voces = $v }`;

/** Una sola frase: termina tras ~1,5 s de silencio o al pasar `segundos`, lo que llegue antes. */
function scriptDictar(segundos: number): string {
  return `Add-Type -AssemblyName System.Speech
${ELEGIR_RECONOCEDOR}
if (-not $info) { ConvertTo-Json -Compress @{ error = 'sin-reconocedor' }; return }
$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
try { $rec.SetInputToDefaultAudioDevice() } catch { ConvertTo-Json -Compress @{ error = 'sin-microfono' }; return }
$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(${segundos})
$rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(${SILENCIO_FINAL_S})
$rec.BabbleTimeout = [TimeSpan]::Zero
$null = Register-ObjectEvent -InputObject $rec -EventName RecognizeCompleted -SourceIdentifier fin
$rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Single)
$e = Wait-Event -SourceIdentifier fin -Timeout ${segundos}
if (-not $e) { $rec.RecognizeAsyncStop(); $e = Wait-Event -SourceIdentifier fin -Timeout 5 }
if ($e -and $e.SourceEventArgs.Error) { ConvertTo-Json -Compress @{ error = 'reconocedor'; detalle = "$($e.SourceEventArgs.Error.Message)" }; return }
$res = if ($e) { $e.SourceEventArgs.Result } else { $null }
ConvertTo-Json -Compress @{ texto = $(if ($res) { $res.Text } else { '' }); idioma = $info.Culture.Name }
$rec.Dispose()`;
}

/** El texto y el nombre de la voz van en base64: nunca se interpolan crudos en el script. */
function scriptLeer(texto: string, a: AjustesLectura): string {
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");
  const rate = Math.max(-10, Math.min(10, Math.round(a.velocidad / 10)));
  return `Add-Type -AssemblyName System.Speech
$texto = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(texto)}'))
$elegida = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(a.voz ?? "")}'))
try {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voces = @($s.GetInstalledVoices() | Where-Object { $_.Enabled })
  $v = $voces | Where-Object { $_.VoiceInfo.Name -eq $elegida } | Select-Object -First 1
  if (-not $v) { $v = $voces | Where-Object { $_.VoiceInfo.Culture.Name -eq 'es-ES' } | Select-Object -First 1 }
  if (-not $v) { $v = $voces | Where-Object { $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'es' } | Select-Object -First 1 }
  if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
  $s.Rate = ${rate}
  $s.SetOutputToDefaultAudioDevice()
  $s.Speak($texto)
  $s.Dispose()
  ConvertTo-Json -Compress @{ ok = $true }
} catch { ConvertTo-Json -Compress @{ error = 'lectura'; detalle = "$($_.Exception.Message)" } }`;
}

/** Las líneas de `say -v '?'`: «Mónica              es_ES    # Hola, me llamo Mónica.» */
export function vocesDeSay(salida: string): VozSistema[] {
  const voces: VozSistema[] = [];
  for (const linea of salida.split(/\r?\n/)) {
    const m = linea.match(/^(.*\S)\s+([a-z]{2,3})_([A-Za-z0-9]+)\s+#/);
    if (m) voces.push({ nombre: m[1]!, idioma: `${m[2]}-${m[3]}` });
  }
  return voces;
}

/** «es» → «es-ES» (el español de espeak es el de España), «en-us» → «en-US». */
function idiomaEspeak(codigo: string): string {
  if (codigo === "es") return "es-ES";
  const [lengua, region] = codigo.split("-");
  return region && region.length === 2 ? `${lengua}-${region.toUpperCase()}` : codigo;
}

/**
 * Las líneas de `espeak-ng --voices`, con el código que entiende `-v` de cada una:
 * « 5  es              --/M      Spanish_(Spain)    roa/es»
 */
export function vocesDeEspeak(salida: string): { voces: VozSistema[]; codigos: Record<string, string> } {
  const voces: VozSistema[] = [];
  const codigos: Record<string, string> = {};
  for (const linea of salida.split(/\r?\n/)) {
    const m = linea.match(/^\s*\d+\s+(\S+)\s+\S+\s+(\S+)/);
    if (!m) continue;
    const nombre = m[2]!.replaceAll("_", " ");
    if (codigos[nombre]) continue;
    voces.push({ nombre, idioma: idiomaEspeak(m[1]!) });
    codigos[nombre] = m[1]!;
  }
  return { voces, codigos };
}

/** Las líneas de `spd-say -L`: «   Spanish (Spain)     es     none» (la primera es la cabecera). */
export function vocesDeSpd(salida: string): VozSistema[] {
  const voces: VozSistema[] = [];
  for (const linea of salida.split(/\r?\n/)) {
    const m = linea.match(/^\s*(.+?)\s+([a-z]{2,3}(?:-[A-Za-z0-9]+)?)\s+(\S+)\s*$/);
    if (m && m[1] !== "NAME") voces.push({ nombre: m[1]!, idioma: idiomaEspeak(m[2]!) });
  }
  return voces;
}

/** Las de español primero (es-ES delante), luego las demás por nombre. */
export function ordenarVoces(voces: VozSistema[]): VozSistema[] {
  const rango = (v: VozSistema) => (v.idioma === "es-ES" ? 0 : v.idioma.startsWith("es") ? 1 : 2);
  return [...voces].sort((a, b) => rango(a) - rango(b) || a.nombre.localeCompare(b.nombre, "es"));
}

/** La voz con la que leer: la elegida si existe; si no, la primera española; si no hay, la del sistema. */
export function vozParaLeer(voces: VozSistema[], elegida?: string): string | undefined {
  if (elegida && voces.some((v) => v.nombre === elegida)) return elegida;
  const espanola = ordenarVoces(voces)[0];
  return espanola?.idioma.startsWith("es") ? espanola.nombre : undefined;
}

/** Quita las marcas de Markdown que la voz leería en alto («almohadilla», «asterisco»). */
export function textoParaLeer(texto: string): string {
  return texto
    .replace(/^```.*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/(\*\*|__|\*|`|~~)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ERRORES_COMUNES: Record<string, string> = {
  reconocedor: "Error del reconocedor de voz",
  lectura: "No se pudo leer en voz alta",
};

const ERRORES: Record<"windows" | "mac", Record<string, string>> = {
  windows: {
    ...ERRORES_COMUNES,
    "sin-reconocedor":
      "No hay ningún reconocedor de voz de Windows instalado: añade el reconocimiento de voz del idioma en Configuración › Hora e idioma › Idioma y región.",
    "sin-microfono": "No hay micrófono: conecta uno o elígelo como dispositivo de entrada predeterminado en Windows.",
  },
  mac: {
    ...ERRORES_COMUNES,
    "sin-reconocedor": "El reconocimiento de voz de macOS no está disponible: activa el dictado en Ajustes del Sistema › Teclado › Dictado.",
    "sin-microfono": "No hay micrófono: conecta uno o elígelo en Ajustes del Sistema › Sonido › Entrada.",
    "sin-permiso-microfono": "Aquiles no tiene permiso para usar el micrófono: actívalo en Ajustes del Sistema › Privacidad y seguridad › Micrófono.",
    "sin-permiso-voz":
      "Aquiles no tiene permiso para el reconocimiento de voz: actívalo en Ajustes del Sistema › Privacidad y seguridad › Reconocimiento de voz.",
  },
};

/** La última línea de la salida, en JSON; un `error` se convierte en excepción con el texto de ese sistema. */
function respuesta(salida: string, sistema: "windows" | "mac"): Record<string, unknown> {
  const linea = salida.trim().split(/\r?\n/).pop() ?? "";
  let datos: Record<string, unknown>;
  try {
    datos = JSON.parse(linea);
  } catch {
    throw new Error(`La voz del sistema no devolvió lo esperado: ${salida.trim().slice(0, 300) || "(nada)"}`);
  }
  if (typeof datos.error === "string") {
    const texto = ERRORES[sistema][datos.error] ?? datos.error;
    throw new Error(datos.detalle ? `${texto}: ${datos.detalle}` : texto);
  }
  return datos;
}

export interface OpcionesVoz {
  /** Linux: dónde está un programa (por defecto, en el PATH). */
  buscar?: (programa: string) => string | null;
  /** Por defecto, el de este equipo. */
  sistema?: SistemaVoz;
  ejecutar?: Ejecutar;
  lanzar?: Lanzar;
  /** Ajustes de lectura, leídos en cada lectura. */
  ajustes?: () => AjustesLectura;
  /** Mac: el programa de dictado. Por defecto, `aquiles-dictado` junto a este ejecutable (o AQUILES_DICTADO). */
  dictado?: string;
}

export class Voz {
  private sistema: SistemaVoz;
  private ejecutar: Ejecutar;
  private lanzar: Lanzar;
  private ajustes: () => AjustesLectura;
  private dictado: string;
  private buscar: (programa: string) => string | null;
  private deteccion?: Promise<Deteccion>;
  private actual?: AbortController;

  constructor(o: OpcionesVoz = {}) {
    this.sistema = o.sistema ?? (WINDOWS ? "windows" : process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : "ninguno");
    this.buscar = o.buscar ?? ((p) => Bun.which(p));
    this.ejecutar = o.ejecutar ?? ejecutarPowershell;
    this.lanzar = o.lanzar ?? ejecutarProceso;
    this.ajustes = o.ajustes ?? (() => SIN_AJUSTES);
    this.dictado = o.dictado ?? process.env.AQUILES_DICTADO ?? join(dirname(process.execPath), "aquiles-dictado");
  }

  async estado(): Promise<EstadoVoz> {
    const d = await this.detectar().catch((): Deteccion => ({ reconocedores: [], voces: [] }));
    const idioma = d.reconocedores.find((r) => r === "es-ES") ?? d.reconocedores.find((r) => r.startsWith("es")) ?? d.reconocedores[0];
    return {
      dictado: d.reconocedores.length > 0,
      ...(idioma ? { idiomaDictado: idioma } : {}),
      lectura: d.voces.length > 0 || d.lector !== undefined,
      voces: ordenarVoces(d.voces),
      ocupada: this.actual !== undefined,
    };
  }

  /** Lo dictado al micrófono por defecto, una frase (hasta ~1,5 s de silencio); "" si no se oyó nada o se cortó con parar(). */
  async dictar(segundos = 15): Promise<string> {
    const s = Math.max(1, Math.round(segundos));
    let salida: string | undefined;
    if (this.sistema === "windows") salida = await this.operar((senal) => this.ejecutar(scriptDictar(s), senal));
    else if (this.sistema === "mac") {
      if (!existsSync(this.dictado)) throw new Error("Esta copia de Aquiles no trae el dictado de macOS (aquiles-dictado): actualízala con el instalador.");
      salida = await this.operar((senal) => this.lanzar([this.dictado, String(s), "es-ES"], senal));
    } else if (this.sistema === "linux") throw new Error("En Linux no hay un reconocedor de voz del sistema: el dictado está en Windows y Mac.");
    else throw new Error("La voz no está disponible en este sistema.");
    if (salida === undefined) return "";
    const texto = respuesta(salida, this.sistema).texto;
    return typeof texto === "string" ? texto.trim() : "";
  }

  async leer(texto: string): Promise<void> {
    const limpio = textoParaLeer(texto);
    if (!limpio) return;
    const a = this.ajustes();
    if (this.sistema === "windows") {
      const salida = await this.operar((senal) => this.ejecutar(scriptLeer(limpio, a), senal));
      if (salida !== undefined) respuesta(salida, "windows");
      return;
    }
    if (this.sistema === "ninguno") throw new Error("La voz no está disponible en este sistema.");
    const deteccion = await this.detectar().catch(() => undefined);
    const voz = vozParaLeer(deteccion?.voces ?? [], a.voz);
    const velocidad = Math.max(VELOCIDAD_VOZ.min, Math.min(VELOCIDAD_VOZ.max, a.velocidad));
    if (this.sistema === "linux") return this.leerEnLinux(limpio, deteccion?.lector, voz, velocidad);
    // El texto por fichero: ni comillas ni guiones al principio se toman por opciones.
    const fichero = join(tmpdir(), `aquiles-leer-${crypto.randomUUID()}.txt`);
    await writeFile(fichero, limpio, "utf8");
    try {
      await this.operar((senal) =>
        this.lanzar(["say", ...(voz ? ["-v", voz] : []), "-r", String(Math.round(PPM_SAY * (1 + velocidad / 100))), "-f", fichero], senal),
      );
    } finally {
      await rm(fichero, { force: true }).catch(() => {});
    }
  }

  private async leerEnLinux(texto: string, lector: Deteccion["lector"], voz: string | undefined, velocidad: number): Promise<void> {
    if (!lector) throw new Error("No hay ninguna voz del sistema: instala espeak-ng (o speech-dispatcher) con el gestor de paquetes.");
    if (lector.tipo === "spd") {
      // spd-say solo encarga la lectura a Speech Dispatcher: al cortar, también hay que pedirle que se calle.
      await this.operar(async (senal) => {
        const callar = () => void this.lanzar([lector.programa, "-C"], AbortSignal.timeout(5000)).catch(() => {});
        senal.addEventListener("abort", callar, { once: true });
        const orden = [lector.programa, "-w", "-r", String(velocidad), ...(voz ? ["-y", voz] : ["-l", "es"]), "--", texto];
        return this.lanzar(orden, senal);
      });
      return;
    }
    const ppm = Math.max(80, Math.min(450, Math.round(PPM_ESPEAK * (1 + velocidad / 100))));
    const fichero = join(tmpdir(), `aquiles-leer-${crypto.randomUUID()}.txt`);
    await writeFile(fichero, texto, "utf8");
    try {
      await this.operar((senal) => this.lanzar([lector.programa, "-v", (voz && lector.codigos[voz]) || "es", "-s", String(ppm), "-f", fichero], senal));
    } finally {
      await rm(fichero, { force: true }).catch(() => {});
    }
  }

  parar(): void {
    this.actual?.abort();
  }

  /** Solo una operación a la vez: la nueva corta la anterior. Cortada con parar(), devuelve undefined sin error. */
  private async operar<T>(f: (senal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    this.parar();
    const c = new AbortController();
    this.actual = c;
    try {
      return await f(c.signal);
    } catch (e) {
      if (c.signal.aborted) return undefined;
      throw e;
    } finally {
      if (this.actual === c) this.actual = undefined;
    }
  }

  /** Reconocedores y voces no cambian mientras corre el núcleo: se miran una vez (si falla, se reintenta la próxima). */
  private detectar(): Promise<Deteccion> {
    this.deteccion ??= this.detectarAhora();
    this.deteccion.catch(() => (this.deteccion = undefined));
    return this.deteccion;
  }

  private async detectarAhora(): Promise<Deteccion> {
    if (this.sistema === "windows") {
      const d = respuesta(await this.ejecutar(SCRIPT_ESTADO, AbortSignal.timeout(30_000)), "windows");
      const lista = <T>(v: unknown): T[] => (Array.isArray(v) ? v : v ? [v] : []) as T[];
      return { reconocedores: lista<string>(d.reconocedores), voces: lista<VozSistema>(d.voces) };
    }
    if (this.sistema === "mac") {
      const voces = vocesDeSay(await this.lanzar(["say", "-v", "?"], AbortSignal.timeout(15_000)));
      return { reconocedores: existsSync(this.dictado) ? ["es-ES"] : [], voces };
    }
    if (this.sistema === "linux") {
      const espeak = this.buscar("espeak-ng") ?? this.buscar("espeak");
      if (espeak) {
        const { voces, codigos } = vocesDeEspeak(await this.lanzar([espeak, "--voices"], AbortSignal.timeout(15_000)));
        return { reconocedores: [], voces, lector: { programa: espeak, tipo: "espeak", codigos } };
      }
      const spd = this.buscar("spd-say");
      if (spd) {
        const voces = vocesDeSpd(await this.lanzar([spd, "-L"], AbortSignal.timeout(15_000)).catch(() => ""));
        return { reconocedores: [], voces, lector: { programa: spd, tipo: "spd", codigos: {} } };
      }
    }
    return { reconocedores: [], voces: [] };
  }
}

/** Un programa con su salida; la señal lo mata. Con código distinto de 0, error con lo que dijo por stderr. */
export async function ejecutarProceso(orden: string[], senal: AbortSignal): Promise<string> {
  if (senal.aborted) throw new Error("Cancelado");
  const proc = Bun.spawn(orden, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const matar = () => void matarArbol(proc);
  senal.addEventListener("abort", matar, { once: true });
  try {
    const [salida, errores, codigo] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (senal.aborted) throw new Error("Cancelado");
    if (codigo !== 0) throw new Error(`${orden[0]} terminó con código ${codigo}: ${errores.trim().slice(0, 500)}`);
    return salida;
  } finally {
    senal.removeEventListener("abort", matar);
  }
}

/**
 * `powershell -NoProfile -NonInteractive -Command -` con el script por stdin. Con «-Command -» PowerShell lee stdin
 * línea a línea y se salta en silencio las construcciones de varias líneas, así que el script va en una sola, en base64.
 */
export async function ejecutarPowershell(script: string, senal: AbortSignal): Promise<string> {
  if (!WINDOWS) throw new Error("La voz local necesita Windows (System.Speech).");
  if (senal.aborted) throw new Error("Cancelado");
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const linea =
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; " +
    `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))))\n`;
  const proc = Bun.spawn([existsSync(POWERSHELL) ? POWERSHELL : "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "-"], {
    stdin: Buffer.from(linea),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const matar = () => void matarArbol(proc);
  senal.addEventListener("abort", matar, { once: true });
  try {
    const [salida, errores, codigo] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (senal.aborted) throw new Error("Cancelado");
    if (codigo !== 0) throw new Error(`PowerShell terminó con código ${codigo}: ${errores.trim().slice(0, 500)}`);
    return salida;
  } finally {
    senal.removeEventListener("abort", matar);
  }
}
