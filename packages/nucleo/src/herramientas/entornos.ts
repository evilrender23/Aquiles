/**
 * Entornos remotos de la terminal: un contenedor Docker propio de la sesión u otra máquina por SSH.
 * En los dos, el shell persistente y cada proceso en segundo plano son un cliente local (`docker exec -i`
 * o `ssh`) que abre allí un shell que lee los comandos de stdin. Matar ese cliente no mata lo que corre
 * al otro lado, así que para cortar se manda aparte un `kill` a su grupo de procesos (ver shell.ts).
 */
import { existsSync } from "node:fs";
import type { AjustesHerramientas } from "@aquiles/protocolo";
import type { Subprocess } from "bun";
import { rutaDocker } from "./docker";
import { ErrorHerramienta } from "./herramienta";

/** Clave de `ctx.estado` donde el servidor deja, antes del turno, dónde corre la terminal de la sesión. */
export const CLAVE_ENTORNO = "terminal.entorno";
export type AjusteEntorno = AjustesHerramientas["terminal"];

export interface Remoto {
  readonly tipo: "docker" | "ssh";
  /** Para los mensajes: "Docker (aquiles-…)" o "SSH (yo@host)". */
  readonly nombre: string;
  /** Carpeta donde empieza el shell; sin ella, la del usuario remoto. */
  readonly carpeta?: string;
  /** Línea para el primer resultado de la sesión, para que el modelo sepa dónde está. */
  readonly aviso: string;
  /** Deja el entorno listo antes de abrir un shell o un proceso (Docker: crea o reutiliza el contenedor). */
  preparar(o: { senal: AbortSignal; progreso(texto: string): void }): Promise<void>;
  /** Orden local que abre allí un shell (bash, o sh si no hay) que lee los comandos de stdin. */
  argsShell(): string[];
  /** Mata allí un proceso (`pid`) o un grupo (`-pgid`); devuelve por qué no pudo, si falla. */
  matar(objetivo: string): Promise<string | undefined>;
  /** Error claro cuando no se pudo abrir el shell, con lo que dijo docker o ssh. */
  error(detalle: string): ErrorHerramienta;
  /** Libera lo que dejó el entorno al cerrar la sesión. */
  cerrar(): Promise<void>;
}

/** El entorno remoto según el ajuste; undefined es local, igual que si no hay ajuste. */
export function crearRemoto(ajuste: AjusteEntorno | undefined, sesionId: string, cwd: string): Remoto | undefined {
  if (ajuste?.entorno === "docker") {
    const imagen = ajuste.imagen?.trim();
    if (!imagen || imagen.startsWith("-")) throw new ErrorHerramienta("Falta una imagen de Docker válida en los ajustes de la terminal.");
    return new Docker(imagen, nombreContenedor(sesionId), cwd);
  }
  if (ajuste?.entorno === "ssh") {
    const destino = ajuste.ssh?.trim();
    // Un destino que empieza por "-" lo tomaría ssh por una opción.
    if (!destino || !/^[^\s-]\S*$/.test(destino)) {
      throw new ErrorHerramienta("Falta un destino SSH válido (usuario@host) en los ajustes de la terminal.");
    }
    return new Ssh(destino);
  }
  return undefined;
}

/** Un contenedor por sesión; Docker solo admite letras, números, "_", "." y "-" en el nombre. */
export function nombreContenedor(sesionId: string): string {
  return `aquiles-${sesionId.slice(0, 12).replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

export const cancelado = () => new ErrorHerramienta("Cancelado: no se ejecutó el comando.");

/** Abre bash si lo hay y si no sh. No lleva comillas simples porque por SSH va entre ellas. */
const LANZADOR = "command -v bash >/dev/null 2>&1 && exec bash; exec sh";

/**
 * AQUILES_DOCKER y AQUILES_SSH: un ejecutable (la ruta puede tener espacios) o una orden con argumentos
 * entre comillas si hace falta ("podman", "ssh -F C:/ssh/config").
 */
function ejecutable(variable: string, defecto: string): string[] {
  const valor = process.env[variable]?.trim();
  if (!valor) return [Bun.which(defecto) ?? defecto];
  if (existsSync(valor)) return [valor];
  const [primero = defecto, ...resto] = [...valor.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  return [Bun.which(primero) ?? primero, ...resto];
}

class Docker implements Remoto {
  readonly tipo = "docker";
  readonly carpeta = "/trabajo";
  readonly nombre: string;
  readonly aviso: string;
  private readonly docker = process.env.AQUILES_DOCKER?.trim() ? ejecutable("AQUILES_DOCKER", "docker") : [rutaDocker() ?? "docker"];
  private usado = false;
  /** Tras el `rm -f` no queda nada dentro que matar. */
  private cerrado = false;

  constructor(
    private readonly imagen: string,
    private readonly contenedor: string,
    private readonly montaje: string,
  ) {
    this.nombre = `Docker (${contenedor})`;
    this.aviso =
      `[terminal en Docker: contenedor ${contenedor} (${imagen}) con la carpeta de trabajo montada en /trabajo; ` +
      "leer, escribir y editar usan las rutas de este equipo]";
  }

  async preparar(o: { senal: AbortSignal; progreso(texto: string): void }): Promise<void> {
    this.usado = true;
    const estado = await this.estado(o.senal);
    if (estado === "running") return;
    // Existe pero parado: se crea de nuevo para que tenga los flags y el montaje de ahora.
    if (estado !== undefined) await orden([...this.docker, "rm", "-f", this.contenedor], 30_000);
    o.progreso(`[creando el contenedor ${this.contenedor} con ${this.imagen}]\n`);
    // Sin capacidades ni escalada de privilegios y con límites de procesos, memoria y CPU.
    const crear = ["run", "-d", "--rm", "--name", this.contenedor, "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
    const limites = ["--pids-limit", "256", "--memory", "2g", "--cpus", "2"];
    const resto = ["-v", `${this.montaje}:/trabajo`, "-w", "/trabajo", this.imagen, "sleep", "infinity"];
    // Hasta 10 minutos: la primera vez descarga la imagen, y ese progreso se ve en vivo.
    const r = await orden([...this.docker, ...crear, ...limites, ...resto], 600_000, { senal: o.senal, alErrores: o.progreso });
    if (r.fallo === CANCELADA) throw cancelado();
    if (r.codigo === 0) return;
    // Otra llamada de la misma sesión pudo crearlo a la vez.
    if (/already in use/i.test(r.errores) && (await this.estado(o.senal)) === "running") return;
    throw new ErrorHerramienta(`No se pudo crear el contenedor ${this.contenedor} con la imagen ${this.imagen}: ${detalle(r)}`);
  }

  /** "running", otro estado si existe sin correr, o undefined si no existe. */
  private async estado(senal: AbortSignal): Promise<string | undefined> {
    const filtro = ["ps", "-a", "--filter", `name=${this.contenedor}`, "--format", "{{.Names}} {{.State}}"];
    const r = await orden([...this.docker, ...filtro], 20_000, { senal });
    if (r.fallo === CANCELADA) throw cancelado();
    if (r.fallo || r.codigo !== 0) throw new ErrorHerramienta(`Docker no está instalado o no responde: ${detalle(r)}. Puedes ofrecer instalarlo o arrancarlo con instalar_docker.`);
    // El filtro busca por trozo de nombre: hay que quedarse con el exacto.
    for (const linea of r.salida.split("\n")) {
      const [nombre, estado = ""] = linea.trim().split(/\s+/);
      if (nombre === this.contenedor) return estado;
    }
    return undefined;
  }

  argsShell(): string[] {
    return [...this.docker, "exec", "-i", this.contenedor, "sh", "-c", LANZADOR];
  }

  async matar(objetivo: string): Promise<string | undefined> {
    if (this.cerrado) return undefined;
    return sinError(await orden([...this.docker, "exec", this.contenedor, "sh", "-c", `kill -9 ${objetivo}`], 20_000));
  }

  error(detalle: string): ErrorHerramienta {
    return new ErrorHerramienta(`No se pudo abrir el shell en el contenedor ${this.contenedor}: ${detalle}`);
  }

  async cerrar(): Promise<void> {
    if (!this.usado || this.cerrado) return;
    this.cerrado = true;
    await orden([...this.docker, "rm", "-f", this.contenedor], 30_000);
  }
}

class Ssh implements Remoto {
  readonly tipo = "ssh";
  readonly nombre: string;
  readonly aviso: string;
  private readonly ssh: string[];

  constructor(private readonly destino: string) {
    // BatchMode: solo claves. Con contraseña falla al momento en vez de quedarse esperándola.
    const opciones = ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=15"];
    this.ssh = [...ejecutable("AQUILES_SSH", "ssh"), ...opciones, destino];
    this.nombre = `SSH (${destino})`;
    this.aviso = `[terminal por SSH en ${destino}: los comandos corren allí, pero leer, escribir y editar siguen trabajando con los ficheros de este equipo]`;
  }

  async preparar(): Promise<void> {
    // La conexión se comprueba al abrir el shell, que es cuando ssh dice por qué falla.
  }

  argsShell(): string[] {
    // ssh pasa el comando al shell de inicio remoto, que puede no ser bash.
    return [...this.ssh, `sh -c '${LANZADOR}'`];
  }

  async matar(objetivo: string): Promise<string | undefined> {
    return sinError(await orden([...this.ssh, `sh -c 'kill -9 ${objetivo}'`], 30_000));
  }

  error(detalle: string): ErrorHerramienta {
    return new ErrorHerramienta(
      `No se pudo conectar por SSH a ${this.destino}: ${detalle.replace(/\.$/, "")}. ` +
        `Solo se usan claves (BatchMode=yes): comprueba que «ssh ${this.destino}» entra sin pedir contraseña.`,
    );
  }

  async cerrar(): Promise<void> {
    // Lo remoto ya lo matan el shell y los procesos al cerrarse.
  }
}

// --- Órdenes cortas ---

interface Orden {
  codigo: number | null;
  salida: string;
  errores: string;
  /** Por qué no terminó sola: no arrancó, no contestó a tiempo o se canceló. */
  fallo?: string;
}

const CANCELADA = "cancelada";

/** Lanza una orden corta (docker ps/run/rm, un kill remoto) con límite de tiempo; nunca lanza excepciones. */
async function orden(cmd: string[], ms: number, o: { senal?: AbortSignal; alErrores?(texto: string): void } = {}): Promise<Orden> {
  const r: Orden = { codigo: null, salida: "", errores: "" };
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    // El entorno actual, no el del arranque: los ajustes cambian variables en caliente (DOCKER_HOST, claves…).
    proc = Bun.spawn({ cmd, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  } catch (e) {
    r.fallo = `no se pudo ejecutar «${cmd[0]}» (${e instanceof Error ? e.message : String(e)})`;
    return r;
  }
  let cortar = (_motivo: string) => {};
  const corte = new Promise<void>((listo) => {
    cortar = (motivo) => {
      r.fallo ??= motivo;
      proc.kill();
      listo();
    };
  });
  const reloj = setTimeout(() => cortar(`no contestó en ${ms / 1000} s`), ms);
  const alAbortar = () => cortar(CANCELADA);
  o.senal?.addEventListener("abort", alAbortar, { once: true });
  if (o.senal?.aborted) alAbortar();
  const lecturas = Promise.all([
    leer(proc.stdout, (t) => (r.salida += t)),
    leer(proc.stderr, (t) => {
      r.errores += t;
      o.alErrores?.(t);
    }),
  ]);
  // Si se corta, no se espera a los flujos: un hijo de ssh (ProxyCommand) podría tenerlos abiertos.
  await Promise.race([lecturas.then(() => proc.exited), corte]);
  clearTimeout(reloj);
  o.senal?.removeEventListener("abort", alAbortar);
  r.codigo = proc.exitCode;
  return r;
}

async function leer(flujo: ReadableStream<Uint8Array>, alTrozo: (t: string) => void): Promise<void> {
  const dec = new TextDecoder();
  try {
    for await (const t of flujo) alTrozo(dec.decode(t, { stream: true }));
  } catch {
    // El flujo se rompe si se mata la orden.
  }
}

/** Lo último que dijo la orden, para los mensajes de error. */
function detalle(r: Orden): string {
  const dicho = (r.errores.trim() || r.salida.trim()).slice(-500);
  return r.fallo ?? (dicho || `terminó con código ${r.codigo}`);
}

/** Resultado de un kill remoto: si el proceso ya no existía, también vale. */
function sinError(r: Orden): string | undefined {
  return r.codigo === 0 || /no such process/i.test(r.errores) ? undefined : detalle(r);
}
