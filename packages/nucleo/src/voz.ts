/**
 * Voz local con System.Speech de Windows: dictado con el reconocedor del sistema y lectura con sus voces.
 * Cada operación es un PowerShell aparte que devuelve una línea JSON; parar() mata el que esté en marcha.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EstadoVoz } from "@aquiles/protocolo";
import { WINDOWS } from "./herramientas/ficheros";
import { matarArbol } from "./herramientas/shell";

type Ejecutar = (script: string, senal: AbortSignal) => Promise<string>;

interface Deteccion {
  reconocedores: string[];
  voces: { nombre: string; idioma: string }[];
}

const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const SILENCIO_FINAL_S = 1.5;

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

/** El texto va en base64: nunca se interpola crudo en el script. */
function scriptLeer(texto: string): string {
  const b64 = Buffer.from(texto, "utf8").toString("base64");
  return `Add-Type -AssemblyName System.Speech
$texto = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
try {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voces = @($s.GetInstalledVoices() | Where-Object { $_.Enabled })
  $v = $voces | Where-Object { $_.VoiceInfo.Culture.Name -eq 'es-ES' } | Select-Object -First 1
  if (-not $v) { $v = $voces | Where-Object { $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'es' } | Select-Object -First 1 }
  if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
  $s.SetOutputToDefaultAudioDevice()
  $s.Speak($texto)
  $s.Dispose()
  ConvertTo-Json -Compress @{ ok = $true }
} catch { ConvertTo-Json -Compress @{ error = 'lectura'; detalle = "$($_.Exception.Message)" } }`;
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

const ERRORES: Record<string, string> = {
  "sin-reconocedor":
    "No hay ningún reconocedor de voz de Windows instalado: añade el reconocimiento de voz del idioma en Configuración › Hora e idioma › Idioma y región.",
  "sin-microfono": "No hay micrófono: conecta uno o elígelo como dispositivo de entrada predeterminado en Windows.",
  reconocedor: "Error del reconocedor de voz",
  lectura: "No se pudo leer en voz alta",
};

/** La última línea de la salida, que el script escribe en JSON; un `error` se convierte en excepción. */
function respuesta(salida: string): Record<string, unknown> {
  const linea = salida.trim().split(/\r?\n/).pop() ?? "";
  let datos: Record<string, unknown>;
  try {
    datos = JSON.parse(linea);
  } catch {
    throw new Error(`PowerShell no devolvió lo esperado: ${salida.trim().slice(0, 300) || "(nada)"}`);
  }
  if (typeof datos.error === "string") {
    const texto = ERRORES[datos.error] ?? datos.error;
    throw new Error(datos.detalle ? `${texto}: ${datos.detalle}` : texto);
  }
  return datos;
}

export class Voz {
  private ejecutar: Ejecutar;
  private deteccion?: Promise<Deteccion>;
  private actual?: AbortController;

  constructor(o: { ejecutar?: Ejecutar } = {}) {
    this.ejecutar = o.ejecutar ?? ejecutarPowershell;
  }

  async estado(): Promise<EstadoVoz> {
    const d = await this.detectar().catch((): Deteccion => ({ reconocedores: [], voces: [] }));
    const idioma = d.reconocedores.find((r) => r === "es-ES") ?? d.reconocedores.find((r) => r.startsWith("es")) ?? d.reconocedores[0];
    return {
      dictado: d.reconocedores.length > 0,
      ...(idioma ? { idiomaDictado: idioma } : {}),
      lectura: d.voces.length > 0,
      voces: d.voces.map((v) => v.nombre),
      ocupada: this.actual !== undefined,
    };
  }

  /** Lo dictado al micrófono por defecto; "" si no se oyó nada o se cortó con parar(). */
  async dictar(segundos = 15): Promise<string> {
    const salida = await this.operar(scriptDictar(Math.max(1, Math.round(segundos))));
    if (salida === undefined) return "";
    const texto = respuesta(salida).texto;
    return typeof texto === "string" ? texto.trim() : "";
  }

  async leer(texto: string): Promise<void> {
    const limpio = textoParaLeer(texto);
    if (!limpio) return;
    const salida = await this.operar(scriptLeer(limpio));
    if (salida !== undefined) respuesta(salida);
  }

  parar(): void {
    this.actual?.abort();
  }

  /** Solo una operación a la vez: la nueva corta la anterior (leer mientras se dicta acabaría en el micrófono). */
  private async operar(script: string): Promise<string | undefined> {
    this.parar();
    const c = new AbortController();
    this.actual = c;
    try {
      return await this.ejecutar(script, c.signal);
    } catch (e) {
      if (c.signal.aborted) return undefined;
      throw e;
    } finally {
      if (this.actual === c) this.actual = undefined;
    }
  }

  /** Reconocedores y voces no cambian mientras corre el núcleo: se miran una vez (si falla, se reintenta la próxima). */
  private detectar(): Promise<Deteccion> {
    this.deteccion ??= this.ejecutar(SCRIPT_ESTADO, AbortSignal.timeout(30_000)).then((salida) => {
      const d = respuesta(salida);
      const lista = <T>(v: unknown): T[] => (Array.isArray(v) ? v : v ? [v] : []) as T[];
      return { reconocedores: lista<string>(d.reconocedores), voces: lista<Deteccion["voces"][number]>(d.voces) };
    });
    this.deteccion.catch(() => (this.deteccion = undefined));
    return this.deteccion;
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
