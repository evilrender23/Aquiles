/**
 * Shell persistente por sesión y procesos en segundo plano para `terminal` y `procesos`.
 * Cada comando se escribe en stdin seguido de un marcador único que imprime el código de salida
 * y la carpeta actual; la salida del comando es todo lo que llega antes del marcador.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { WINDOWS } from "./ficheros";

export type TipoShell = "bash" | "powershell";

export interface DefShell {
  tipo: TipoShell;
  ejecutable: string;
  /** Nombre para el modelo ("Git Bash", "bash", "PowerShell"). */
  nombre: string;
}

let elegido: DefShell | undefined;

/** Git Bash si existe (bash fuera de Windows); si no, powershell.exe. AQUILES_SHELL lo fuerza: "bash", "powershell" o una ruta. */
export function elegirShell(): DefShell {
  elegido ??= buscarShell();
  return elegido;
}

function buscarShell(): DefShell {
  const forzado = process.env.AQUILES_SHELL?.trim();
  const powershell = (ejecutable: string): DefShell => ({ tipo: "powershell", ejecutable, nombre: "PowerShell" });
  if (forzado && /^(powershell|pwsh)(\.exe)?$/i.test(forzado)) return powershell(buscarPowershell(forzado));
  if (forzado && forzado !== "bash") {
    return /powershell|pwsh/i.test(forzado) ? powershell(forzado) : { tipo: "bash", ejecutable: forzado, nombre: "bash" };
  }
  const bash = buscarBash();
  if (bash) return { tipo: "bash", ejecutable: bash, nombre: WINDOWS ? "Git Bash" : "bash" };
  if (WINDOWS) return powershell(buscarPowershell("powershell.exe"));
  return { tipo: "bash", ejecutable: "/bin/sh", nombre: "sh" };
}

function buscarBash(): string | undefined {
  if (!WINDOWS) return Bun.which("bash") ?? undefined;
  // Nunca el bash.exe de System32 (WSL): solo el de Git for Windows.
  const env = process.env;
  const raices = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]
    .filter((r): r is string => !!r)
    .map((r) => join(r, "Git"));
  const git = Bun.which("git");
  if (git) raices.push(resolve(dirname(git), ".."), resolve(dirname(git), "..", ".."));
  return raices.map((r) => join(r, "bin", "bash.exe")).find((b) => existsSync(b));
}

function buscarPowershell(nombre: string): string {
  const sistema = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (/^powershell(\.exe)?$/i.test(nombre) && existsSync(sistema)) return sistema;
  return Bun.which(nombre) ?? nombre;
}

export function entornoShell(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete env.FORCE_COLOR;
  return env;
}

const TASKKILL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
const argsTaskkill = (pid: number) => [existsSync(TASKKILL) ? TASKKILL : "taskkill", "/T", "/F", "/PID", String(pid)];
const sigue = (proc: Subprocess) => proc.exitCode === null && proc.signalCode === null;

/** Espera a `p` como mucho `ms` sin dejar temporizadores colgados. */
export async function esperarHasta(p: Promise<unknown>, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise((r) => (t = setTimeout(r, ms)))]);
  clearTimeout(t);
}

/** Mata el proceso y todos sus descendientes (en Windows con taskkill /T /F). */
export async function matarArbol(proc: Subprocess): Promise<void> {
  if (sigue(proc)) {
    if (WINDOWS) {
      await Bun.spawn(argsTaskkill(proc.pid), { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
    } else {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }
  }
  await esperarHasta(proc.exited, 3000);
  if (sigue(proc)) proc.kill("SIGKILL");
}

// Red de seguridad: si el núcleo termina sin cerrar las sesiones, no deja procesos huérfanos.
const lanzados = new Set<Subprocess>();
let ganchoSalida = false;

function vigilar(proc: Subprocess): void {
  lanzados.add(proc);
  void proc.exited.then(() => lanzados.delete(proc));
  if (ganchoSalida) return;
  ganchoSalida = true;
  process.on("exit", () => {
    for (const p of lanzados) {
      if (!sigue(p)) continue;
      try {
        if (WINDOWS) Bun.spawnSync(argsTaskkill(p.pid), { stdout: "ignore", stderr: "ignore", windowsHide: true });
        else process.kill(-p.pid, "SIGKILL");
      } catch {
        // Nada más que hacer al salir.
      }
    }
  });
}

// --- Salida ---

export const MAX_SALIDA = 30_000;
const CABEZA = 10_000;
const COLA = 20_000;
const MAX_RETENIDO = 1_000_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: quitar secuencias ANSI exige buscar ESC y BEL.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Quita secuencias ANSI, normaliza CRLF y aplica los retornos de carro (barras de progreso). */
export function limpiar(texto: string): string {
  return texto
    .replace(ANSI, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((l) => {
      const i = l.lastIndexOf("\r");
      return i >= 0 ? l.slice(i + 1) : l;
    })
    .join("\n");
}

/** Salida limpia; si pasa de MAX_SALIDA caracteres, cabeza + cola con aviso. */
export function formatearSalida(texto: string, descartados = 0): string {
  const limpio = limpiar(texto);
  const total = limpio.length + descartados;
  if (total <= MAX_SALIDA) return limpio;
  return (
    `${limpio.slice(0, CABEZA)}\n[… ${total - CABEZA - COLA} caracteres omitidos de ${total}; ` +
    `si necesitas verlo todo, redirige la salida a un fichero y búscalo o léelo por partes …]\n${limpio.slice(-COLA)}`
  );
}

/** Acumula texto conservando el principio y el final si crece demasiado. */
class Acumulador {
  texto = "";
  descartados = 0;

  anadir(t: string): void {
    this.texto += t;
    if (this.texto.length > MAX_RETENIDO) {
      const quitar = this.texto.length - MAX_RETENIDO / 2;
      this.texto = this.texto.slice(0, CABEZA) + this.texto.slice(CABEZA + quitar);
      this.descartados += quitar;
    }
  }
}

async function leerFlujo(flujo: ReadableStream<Uint8Array>, alTrozo: (t: string) => void): Promise<void> {
  const dec = new TextDecoder();
  try {
    for await (const t of flujo) alTrozo(dec.decode(t, { stream: true }));
    const resto = dec.decode();
    if (resto) alTrozo(resto);
  } catch {
    // El flujo se rompe al matar el proceso.
  }
}

// --- Shell persistente ---

export interface ResultadoComando {
  salida: string;
  /** Código de salida del comando, o del shell si `motivo` es "terminado". */
  codigo?: number;
  motivo?: "tiempo" | "cancelado" | "terminado";
}

export interface OpcionesComando {
  timeoutMs: number;
  senal: AbortSignal;
  progreso(texto: string): void;
}

const INICIO_POWERSHELL =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; " +
  "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Continue'\n";

/** El marcador se escribe partido para que no aparezca literal en la entrada (por si el shell la repite). */
function lineaBash(comando: string, marca: string): string {
  const cita = `'${comando.replace(/\r\n?/g, "\n").replace(/'/g, `'\\''`)}'`;
  return `eval ${cita} </dev/null; __aqc=$?; printf '%s%s:%s:' '${marca.slice(0, 4)}' '${marca.slice(4)}' "$__aqc"; pwd -W 2>/dev/null || pwd\n`;
}

function lineaPowershell(comando: string, marca: string): string {
  const b64 = Buffer.from(comando, "utf8").toString("base64");
  return (
    "$global:LASTEXITCODE = 0; $__aqe = $false; $__aqn = $Error.Count; " +
    `try { . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))) 2>&1 | ` +
    'ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { "$_" } else { $_ } } | Out-String -Stream -Width 250 } ' +
    'catch { $__aqe = $true; "$_" }; ' +
    "$__aqc = if ($global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($__aqe -or $Error.Count -gt $__aqn) { 1 } else { 0 }; " +
    `[Console]::Out.Write('${marca.slice(0, 4)}' + '${marca.slice(4)}' + ':' + $__aqc + ':' + (Get-Location).ProviderPath + "\`n"); ` +
    "[Console]::Out.Flush()\n"
  );
}

function argumentosShell(def: DefShell): string[] {
  return def.tipo === "bash" ? [def.ejecutable] : [def.ejecutable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"];
}

export class ShellPersistente {
  readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  /** Carpeta actual del shell según el último comando. */
  cwd: string;
  vivo = true;
  private acumulado = new Acumulador();
  private alTrozo?: (t: string) => void;
  private alSalir?: () => void;
  private readonly lecturas: Promise<void>;

  constructor(
    readonly def: DefShell,
    cwd: string,
  ) {
    this.cwd = cwd;
    this.proc = Bun.spawn({
      cmd: argumentosShell(def),
      cwd,
      env: entornoShell(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      detached: !WINDOWS,
    });
    vigilar(this.proc);
    const recibir = (t: string) => {
      this.acumulado.anadir(t);
      this.alTrozo?.(t);
    };
    this.lecturas = Promise.all([leerFlujo(this.proc.stdout, recibir), leerFlujo(this.proc.stderr, recibir)]).then(() => {});
    void this.proc.exited.then(() => {
      this.vivo = false;
      this.alSalir?.();
    });
    this.escribir(def.tipo === "bash" ? "exec 2>&1\n" : INICIO_POWERSHELL);
  }

  private escribir(texto: string): boolean {
    try {
      this.proc.stdin.write(texto);
      this.proc.stdin.flush();
      return true;
    } catch {
      return false;
    }
  }

  ejecutar(comando: string, o: OpcionesComando): Promise<ResultadoComando> {
    const marca = `__AQFIN_${crypto.randomUUID().replace(/-/g, "")}__`;
    const fin = new RegExp(`${marca}:(-?\\d+):([^\\r\\n]*)\\r?\\n`);
    this.acumulado = new Acumulador();
    const salida = (hasta?: number) => {
      const s = formatearSalida(this.acumulado.texto.slice(0, hasta), this.acumulado.descartados);
      return this.def.tipo === "powershell" ? s.replace(/[ \t]+$/gm, "").replace(/^\n+/, "") : s;
    };

    return new Promise<ResultadoComando>((resolver) => {
      let hecho = false;
      let cortando = false;
      let pendiente = "";
      let silencio = false;

      const terminar = (r: ResultadoComando) => {
        if (hecho) return;
        hecho = true;
        clearTimeout(reloj);
        o.senal.removeEventListener("abort", alAbortar);
        this.alTrozo = undefined;
        this.alSalir = undefined;
        if (pendiente && !silencio) o.progreso(limpiar(pendiente));
        resolver(r);
      };

      // Progreso por líneas completas, sin dejar escapar el marcador.
      const progreso = (t: string) => {
        if (silencio) return;
        pendiente += t;
        const m = pendiente.indexOf(marca.slice(0, 8));
        if (m >= 0) {
          if (m > 0) o.progreso(limpiar(pendiente.slice(0, m)));
          pendiente = "";
          silencio = true;
          return;
        }
        const corte = pendiente.length > 4096 ? pendiente.length - 64 : pendiente.lastIndexOf("\n") + 1;
        if (corte > 0) {
          o.progreso(limpiar(pendiente.slice(0, corte)));
          pendiente = pendiente.slice(corte);
        }
      };

      this.alTrozo = (t) => {
        const texto = this.acumulado.texto;
        const desde = Math.max(0, texto.length - t.length - marca.length - 1024);
        const i = texto.indexOf(marca, desde);
        if (i < 0) return progreso(t);
        progreso(t);
        const m = fin.exec(texto.slice(i));
        if (!m) return;
        const cwd = m[2]?.trim();
        if (cwd && isAbsolute(cwd)) this.cwd = resolve(cwd);
        terminar({ salida: salida(i), codigo: Number(m[1]) });
      };

      const cortar = async (motivo: "tiempo" | "cancelado") => {
        if (hecho || cortando) return;
        cortando = true;
        this.vivo = false;
        await matarArbol(this.proc);
        await esperarHasta(this.lecturas, 500);
        terminar({ salida: salida(), motivo });
      };
      const reloj = setTimeout(() => void cortar("tiempo"), o.timeoutMs);
      const alAbortar = () => void cortar("cancelado");
      o.senal.addEventListener("abort", alAbortar, { once: true });

      this.alSalir = () => {
        if (cortando) return;
        void esperarHasta(this.lecturas, 500).then(() =>
          terminar({ salida: salida(), codigo: this.proc.exitCode ?? undefined, motivo: "terminado" }),
        );
      };

      if (!this.vivo || !this.escribir(this.def.tipo === "bash" ? lineaBash(comando, marca) : lineaPowershell(comando, marca))) {
        terminar({ salida: "", codigo: this.proc.exitCode ?? undefined, motivo: "terminado" });
      } else if (o.senal.aborted) {
        alAbortar();
      }
    });
  }

  async cerrar(): Promise<void> {
    this.vivo = false;
    await matarArbol(this.proc);
  }
}

// --- Procesos en segundo plano ---

const PREAMBULO_POWERSHELL = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'\n";

export class ProcesoFondo {
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  readonly inicio = Date.now();
  fin?: number;
  parado = false;
  private texto = "";
  /** Posición absoluta de `texto[0]` y de lo ya entregado con `nueva()`. */
  private base = 0;
  private leido = 0;

  constructor(
    readonly id: string,
    readonly comando: string,
    readonly nombre: string | undefined,
    def: DefShell,
    readonly cwd: string,
  ) {
    const cmd =
      def.tipo === "bash"
        ? [def.ejecutable, "-c", `exec 2>&1\n${comando.replace(/\r\n?/g, "\n")}`]
        : [
            def.ejecutable,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(PREAMBULO_POWERSHELL + comando, "utf16le").toString("base64"),
          ];
    this.proc = Bun.spawn({
      cmd,
      cwd,
      env: entornoShell(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      detached: !WINDOWS,
    });
    vigilar(this.proc);
    const recibir = (t: string) => this.anadir(t);
    void leerFlujo(this.proc.stdout, recibir);
    void leerFlujo(this.proc.stderr, recibir);
    void this.proc.exited.then(() => {
      this.fin = Date.now();
    });
  }

  get enMarcha(): boolean {
    return this.fin === undefined;
  }

  get codigo(): number | null {
    return this.proc.exitCode;
  }

  private anadir(t: string): void {
    this.texto += t;
    if (this.texto.length > MAX_RETENIDO) {
      const quitar = this.texto.length - MAX_RETENIDO / 2;
      this.texto = this.texto.slice(quitar);
      this.base += quitar;
    }
  }

  /** Salida nueva desde la última llamada. */
  nueva(): string {
    const desde = Math.max(this.leido, this.base);
    const perdidos = desde - this.leido;
    const nuevo = this.texto.slice(desde - this.base);
    this.leido = this.base + this.texto.length;
    const s = formatearSalida(nuevo);
    return perdidos > 0 ? `[… ${perdidos} caracteres anteriores perdidos …]\n${s}` : s;
  }

  async parar(): Promise<void> {
    if (!this.enMarcha) return;
    this.parado = true;
    await matarArbol(this.proc);
  }
}

// --- Estado por sesión ---

export class EstadoTerminal {
  shell?: ShellPersistente;
  readonly procesos = new Map<string, ProcesoFondo>();
  private siguiente = 1;
  private cola: Promise<unknown> = Promise.resolve();

  /** Ejecuta en serie: el shell solo admite un comando a la vez. */
  enCola<T>(f: () => Promise<T>): Promise<T> {
    const r = this.cola.then(f, f);
    this.cola = r.catch(() => {});
    return r;
  }

  /** Shell vivo de la sesión; lo (re)crea en `cwd` si no hay o murió. */
  shellVivo(cwd: string): ShellPersistente {
    if (!this.shell?.vivo) this.shell = new ShellPersistente(elegirShell(), cwd);
    return this.shell;
  }

  lanzar(comando: string, nombre: string | undefined, cwd: string): ProcesoFondo {
    const p = new ProcesoFondo(`p${this.siguiente++}`, comando, nombre, elegirShell(), cwd);
    this.procesos.set(p.id, p);
    return p;
  }

  /** Por id o, si no, por nombre (el más reciente). */
  buscar(clave: string): ProcesoFondo | undefined {
    return this.procesos.get(clave) ?? [...this.procesos.values()].reverse().find((p) => p.nombre === clave);
  }

  async cerrar(): Promise<void> {
    const shell = this.shell;
    this.shell = undefined;
    await Promise.all([shell?.cerrar(), ...[...this.procesos.values()].map((p) => p.parar())]);
  }
}

export const CLAVE_TERMINAL = "terminal";

export function estadoTerminal(estado: Map<string, unknown>): EstadoTerminal {
  let e = estado.get(CLAVE_TERMINAL);
  if (!(e instanceof EstadoTerminal)) {
    e = new EstadoTerminal();
    estado.set(CLAVE_TERMINAL, e);
  }
  return e as EstadoTerminal;
}
