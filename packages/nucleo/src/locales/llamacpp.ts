/**
 * llama.cpp (`llama-server`) ejecuta los modelos GGUF descargados de Hugging Face. Hay un servidor a la vez: elegir otro
 * modelo lo cambia, y se para solo tras un rato sin uso para devolver la memoria de la GPU. Escucha en 127.0.0.1 con una
 * clave aleatoria y sin su interfaz web. Con sus valores por defecto (`--fit on`, contexto del modelo, capas en GPU "auto")
 * se ajusta a la memoria del equipo; la ventana que se usa es la que ha cargado de verdad (`GET /props`).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { ProveedorOpenAICompatible } from "../proveedores/openai-compatible";
import { ErrorProveedor, type PeticionModelo, type Proveedor, type RespuestaModelo } from "../tipos";
import { directorioModelos, type ModeloLocal, modelosLocales } from "./huggingface";

export const ID_WINGET_LLAMA = "ggml.llamacpp";
const INACTIVIDAD_MS = 15 * 60_000;

/** `AQUILES_LLAMA_SERVER`, el PATH o lo que deja `winget install ggml.llamacpp` (el PATH de un proceso ya abierto no lo ve). */
export function rutaLlamaServer(): string | undefined {
  const propia = process.env.AQUILES_LLAMA_SERVER;
  if (propia && existsSync(propia)) return propia;
  const enPath = Bun.which("llama-server");
  if (enPath) return enPath;
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return undefined;
  const winget = join(process.env.LOCALAPPDATA, "Microsoft", "WinGet");
  const enlace = join(winget, "Links", "llama-server.exe");
  if (existsSync(enlace)) return enlace;
  const paquetes = join(winget, "Packages");
  const carpeta = existsSync(paquetes) ? readdirSync(paquetes).find((n) => n.startsWith(`${ID_WINGET_LLAMA}_`)) : undefined;
  const exe = carpeta ? join(paquetes, carpeta, "llama-server.exe") : undefined;
  return exe && existsSync(exe) ? exe : undefined;
}

/** Instala llama.cpp con winget (paquete portátil del usuario, sin permisos de administrador). Lo llama la app a petición. */
export async function instalarLlamaCpp(alSalida: (t: string) => void, senal?: AbortSignal): Promise<void> {
  if (process.platform !== "win32") throw new Error("La instalación automática de llama.cpp solo está en Windows");
  const p = Bun.spawn(
    ["winget", "install", "-e", "--id", ID_WINGET_LLAMA, "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
    { stdout: "pipe", stderr: "pipe", ...(senal ? { signal: senal } : {}) },
  );
  let salida = "";
  const leer = async (flujo: ReadableStream<Uint8Array>) => {
    const d = new TextDecoder();
    for await (const trozo of flujo) {
      const t = d.decode(trozo, { stream: true });
      salida += t;
      alSalida(t);
    }
  };
  await Promise.all([leer(p.stdout), leer(p.stderr)]);
  const codigo = await p.exited;
  if (codigo !== 0 && !rutaLlamaServer()) throw new Error(`winget no pudo instalar llama.cpp (código ${codigo}):\n${salida.slice(-1500)}`);
}

export interface EstadoLlama {
  modelo: string;
  baseURL: string;
  clave: string;
  /** Contexto cargado por el servidor (n_ctx). */
  ventana?: number;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function puertoLibre(): Promise<number> {
  return new Promise((ok, mal) => {
    const s = createServer();
    s.once("error", mal);
    s.listen(0, "127.0.0.1", () => {
      const direccion = s.address();
      s.close(() => (typeof direccion === "object" && direccion ? ok(direccion.port) : mal(new Error("sin puerto"))));
    });
  });
}

export class ServidorLlama {
  private actual?: { modelo: string; proceso: Subprocess; estado: Promise<EstadoLlama> };
  private temporizador?: ReturnType<typeof setTimeout>;

  constructor(
    private o: {
      ruta?: () => string | undefined;
      /** Lo que se espera a que cargue el modelo (un GGUF grande desde disco tarda minutos). */
      esperaMs?: number;
      inactividadMs?: number;
      fetch?: Fetch;
      /** Fichero con el PID del servidor, para pararlo si el núcleo murió sin hacerlo. */
      ficheroPid?: string;
    } = {},
  ) {
    this.pararHuerfano();
  }

  get modeloCargado(): string | undefined {
    return this.actual?.proceso.exitCode === null ? this.actual.modelo : undefined;
  }

  async asegurar(m: Pick<ModeloLocal, "id" | "ruta" | "proyector">): Promise<EstadoLlama> {
    this.reprogramar();
    if (this.actual?.modelo === m.id && this.actual.proceso.exitCode === null) return this.actual.estado;
    await this.parar();
    const exe = (this.o.ruta ?? rutaLlamaServer)();
    if (!exe) throw new ErrorProveedor("otro", "llama.cpp no está instalado. Instálalo desde Ajustes → Modelos locales.");
    const puerto = await puertoLibre();
    const clave = randomBytes(24).toString("hex");
    const proceso = Bun.spawn(
      [exe, "-m", m.ruta, ...(m.proyector ? ["--mmproj", m.proyector] : []), "--host", "127.0.0.1", "--port", String(puerto), "--api-key", clave, "--no-webui", "-a", "local"],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    this.guardarPid(proceso.pid);
    let cola = "";
    void (async () => {
      const d = new TextDecoder();
      for await (const t of proceso.stderr as ReadableStream<Uint8Array>) cola = (cola + d.decode(t, { stream: true })).slice(-4000);
    })().catch(() => {});
    const baseURL = `http://127.0.0.1:${puerto}`;
    const estado = this.esperar(m.id, baseURL, clave, proceso, () => cola);
    this.actual = { modelo: m.id, proceso, estado };
    estado.catch(() => {
      if (this.actual?.proceso === proceso) void this.parar();
    });
    return estado;
  }

  /** Se llama al terminar cada respuesta: el servidor se para tras `inactividadMs` sin usarse. */
  reprogramar(): void {
    clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => void this.parar(), this.o.inactividadMs ?? INACTIVIDAD_MS);
    this.temporizador.unref?.();
  }

  async parar(): Promise<void> {
    clearTimeout(this.temporizador);
    const a = this.actual;
    this.actual = undefined;
    if (!a) return;
    a.proceso.kill();
    await a.proceso.exited.catch(() => {});
    if (this.o.ficheroPid) await rm(this.o.ficheroPid, { force: true }).catch(() => {});
  }

  private async esperar(modelo: string, baseURL: string, clave: string, proceso: Subprocess, cola: () => string): Promise<EstadoLlama> {
    const pedir = this.o.fetch ?? fetch;
    const limite = Date.now() + (this.o.esperaMs ?? 10 * 60_000);
    const fallo = (motivo: string) => {
      const detalle = cola().trim().split("\n").slice(-12).join("\n");
      return new ErrorProveedor("otro", `llama.cpp ${motivo}${detalle ? `:\n${detalle}` : ""}`);
    };
    for (;;) {
      if (proceso.exitCode !== null) throw fallo(`se cerró al cargar el modelo (código ${proceso.exitCode})`);
      if (Date.now() > limite) throw fallo("tardó demasiado en cargar el modelo");
      const r = await pedir(`${baseURL}/health`).catch(() => undefined);
      if (r?.ok) break;
      await Bun.sleep(400);
    }
    const props = await pedir(`${baseURL}/props`, { headers: { authorization: `Bearer ${clave}` } })
      .then((r) => (r.ok ? (r.json() as Promise<{ default_generation_settings?: { n_ctx?: number } }>) : undefined))
      .catch(() => undefined);
    const ventana = props?.default_generation_settings?.n_ctx;
    return { modelo, baseURL: `${baseURL}/v1`, clave, ...(ventana ? { ventana } : {}) };
  }

  private guardarPid(pid: number): void {
    if (!this.o.ficheroPid) return;
    try {
      writeFileSync(this.o.ficheroPid, String(pid));
    } catch {}
  }

  /** Si el núcleo anterior murió (la app lo mata sin avisar), su llama-server seguiría ocupando la GPU. */
  private pararHuerfano(): void {
    if (!this.o.ficheroPid || !existsSync(this.o.ficheroPid)) return;
    try {
      const pid = Number(readFileSync(this.o.ficheroPid, "utf8"));
      if (pid > 0 && process.platform === "win32") {
        // Solo si ese PID sigue siendo un llama-server: los PID se reutilizan.
        const lista = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).stdout.toString();
        if (/llama-server/i.test(lista)) Bun.spawnSync(["taskkill", "/PID", String(pid), "/F"]);
      }
    } catch {}
  }
}

/** Proveedor de los modelos descargados: arranca llama-server con el modelo elegido y le habla por su API compatible con OpenAI. */
export class ProveedorLlamaCpp implements Proveedor {
  readonly nombre = "llamacpp";
  ventanaContexto?: number;

  constructor(
    readonly modelo: string | undefined,
    private o: { servidor: ServidorLlama; base?: string },
  ) {}

  async responder(p: PeticionModelo, alDelta: (texto: string) => void): Promise<RespuestaModelo> {
    const locales = await modelosLocales(this.o.base ?? directorioModelos());
    const local = this.modelo ? locales.find((m) => m.id === this.modelo) : locales[0];
    if (!local)
      throw new ErrorProveedor("peticion", this.modelo ? `El modelo ${this.modelo} no está descargado` : "No hay modelos descargados de Hugging Face");
    const e = await this.o.servidor.asegurar(local);
    if (e.ventana) this.ventanaContexto = e.ventana;
    const api = new ProveedorOpenAICompatible({ baseURL: e.baseURL, clave: e.clave, modelo: "local", nombre: "llamacpp", ...(e.ventana ? { ventanaContexto: e.ventana } : {}) });
    try {
      return await api.responder(p, alDelta);
    } finally {
      this.o.servidor.reprogramar();
    }
  }
}
