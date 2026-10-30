/**
 * Cliente MCP: conecta con los servidores de `<perfil>/mcp.json` y ofrece sus herramientas al agente
 * como mcp__<servidor>__<herramienta>. Un programa local va por stdio; una URL, por Streamable HTTP.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InfoServidorMcp } from "@aquiles/protocolo";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CallToolResult, type ContentBlock, type Tool, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import paquete from "../package.json";
import { WINDOWS } from "./herramientas/ficheros";
import { ErrorHerramienta, type Herramienta } from "./herramientas/herramienta";
import { esperarHasta } from "./herramientas/shell";

/** Lo que se guarda de cada servidor en mcp.json; `env` lleva los valores (es configuración del usuario). */
interface ConfigServidor {
  comando?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  activo: boolean;
}

interface Conexion {
  cliente: Client;
  transporte: StdioClientTransport | StreamableHTTPClientTransport;
  definiciones: Tool[];
  herramientas: Herramienta<any>[];
  /** Lo cerramos nosotros: su `onclose` no es una caída. */
  cerrando: boolean;
}

interface Servidor {
  nombre: string;
  config: ConfigServidor;
  estado: InfoServidorMcp["estado"];
  error?: string;
  conexion?: Conexion;
}

const NOMBRE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// npx o uvx descargan el paquete la primera vez antes de responder.
const TIEMPO_CONEXION = 120_000;
// Se reinicia con cada aviso de progreso del servidor.
const TIEMPO_LLAMADA = 600_000;
const TASKKILL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");

const ConfigEnDisco = z.object({
  comando: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
  activo: z.boolean().default(true),
});

/** mcp__<servidor>__<herramienta> con solo [a-zA-Z0-9_-] y 64 caracteres como mucho (lo que aceptan las API de modelos). */
export function nombreHerramientaMcp(servidor: string, herramienta: string): string {
  return `mcp__${servidor}__${herramienta}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** El texto de los bloques `text`; imágenes, audio y recursos, en una línea cada uno. */
export function textoResultadoMcp(r: { content?: ContentBlock[]; structuredContent?: unknown }): string {
  const partes = (r.content ?? []).map((b) => {
    switch (b.type) {
      case "text":
        return b.text;
      case "image":
        return `[imagen ${b.mimeType}, ${tamano(b.data)}]`;
      case "audio":
        return `[audio ${b.mimeType}, ${tamano(b.data)}]`;
      case "resource_link":
        return `[recurso ${b.name}: ${b.uri}]`;
      case "resource":
        return `[recurso ${b.resource.uri}${b.resource.mimeType ? ` (${b.resource.mimeType})` : ""}]`;
      default:
        return "";
    }
  });
  const texto = partes.filter(Boolean).join("\n");
  if (texto) return texto;
  return r.structuredContent !== undefined ? JSON.stringify(r.structuredContent, null, 2) : "(sin resultado)";
}

function tamano(base64: string): string {
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ClienteMcp {
  private servidores = new Map<string, Servidor>();
  /** Las operaciones sobre un mismo servidor van en orden: guardar, reconectar o un aviso del servidor no se pisan. */
  private colas = new Map<string, Promise<unknown>>();
  private log: (m: string) => void;

  constructor(private o: { ruta: string | null; alCambiar?: () => void; log?: (m: string) => void }) {
    this.log = o.log ?? (() => {});
    for (const [nombre, config] of Object.entries(this.leerDisco())) {
      this.servidores.set(nombre, { nombre, config, estado: "desconectado" });
    }
  }

  /** Conecta los servidores activos en paralelo; el que falla queda en estado "error" sin parar a los demás. */
  async iniciar(): Promise<void> {
    await Promise.all(
      [...this.servidores.values()].filter((s) => s.config.activo).map((s) => this.enCola(s.nombre, () => this.conectar(s))),
    );
  }

  async detener(): Promise<void> {
    await Promise.all([...this.servidores.values()].map((s) => this.enCola(s.nombre, () => this.desconectar(s))));
  }

  listar(): InfoServidorMcp[] {
    return [...this.servidores.values()].sort((a, b) => a.nombre.localeCompare(b.nombre)).map((s) => info(s));
  }

  /**
   * Crea o cambia un servidor y lo (re)conecta si está activo.
   * Sin `comando` ni `url` conserva el transporte que tenía; `env` se mezcla con el guardado y un valor vacío borra la variable
   * (la interfaz solo conoce los nombres).
   */
  async guardar(p: {
    nombre: string;
    comando?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    activo?: boolean;
  }): Promise<InfoServidorMcp> {
    if (!NOMBRE.test(p.nombre)) throw new Error(`Nombre de servidor MCP no válido: «${p.nombre}» (minúsculas, números, - y _).`);
    if (p.comando && p.url) throw new Error("Un servidor MCP lleva «comando» (programa local) o «url» (HTTP), no los dos.");
    const base = this.servidores.get(p.nombre)?.config;
    const activo = p.activo ?? base?.activo ?? true;
    let config: ConfigServidor;
    if (p.url) config = { url: urlValida(p.url), activo };
    else if (p.comando) config = { comando: p.comando, args: p.args ?? base?.args ?? [], activo };
    else if (base?.url) config = { url: base.url, activo };
    else if (base?.comando) config = { comando: base.comando, args: p.args ?? base.args ?? [], activo };
    else throw new Error("Falta «comando» (programa local, por stdio) o «url» (Streamable HTTP).");
    if (config.comando) {
      const env = { ...base?.env };
      for (const [k, v] of Object.entries(p.env ?? {})) {
        if (v === "") delete env[k];
        else env[k] = v;
      }
      if (Object.keys(env).length) config.env = env;
    }

    const s: Servidor = this.servidores.get(p.nombre) ?? { nombre: p.nombre, config, estado: "desconectado" };
    s.config = config;
    this.servidores.set(p.nombre, s);
    this.escribirDisco();
    await this.enCola(s.nombre, () => (config.activo ? this.conectar(s) : this.desconectar(s)));
    this.avisar();
    return info(s);
  }

  async borrar(nombre: string): Promise<void> {
    const s = this.buscar(nombre);
    await this.enCola(nombre, () => this.desconectar(s));
    this.servidores.delete(nombre);
    this.colas.delete(nombre);
    this.escribirDisco();
    this.avisar();
  }

  async reconectar(nombre: string): Promise<InfoServidorMcp> {
    const s = this.buscar(nombre);
    if (!s.config.activo) throw new Error(`El servidor MCP «${nombre}» está desactivado: actívalo para conectarlo.`);
    await this.enCola(nombre, () => this.conectar(s));
    return info(s);
  }

  herramientas(): Herramienta<any>[] {
    return [...this.servidores.values()].flatMap((s) => s.conexion?.herramientas ?? []);
  }

  private buscar(nombre: string): Servidor {
    const s = this.servidores.get(nombre);
    if (!s) throw new Error(`No hay ningún servidor MCP llamado «${nombre}».`);
    return s;
  }

  private enCola<T>(nombre: string, f: () => Promise<T>): Promise<T> {
    const r = (this.colas.get(nombre) ?? Promise.resolve()).then(f, f);
    this.colas.set(nombre, r.catch(() => {}));
    return r;
  }

  private avisar(): void {
    try {
      this.o.alCambiar?.();
    } catch (e) {
      this.log(`mcp: fallo al avisar del cambio: ${mensaje(e)}`);
    }
  }

  private async conectar(s: Servidor): Promise<void> {
    await this.desconectar(s);
    const stderr: string[] = [];
    const conStderr = (m: string) => (stderr.length ? `${m} (stderr: ${stderr.slice(-3).join(" | ")})` : m);
    let c: Conexion;
    try {
      c = await this.abrir(s, stderr, conStderr);
    } catch (e) {
      s.estado = "error";
      s.error = conStderr(mensaje(e));
      this.log(`mcp ${s.nombre}: no conecta: ${s.error}`);
      this.avisar();
      return;
    }
    s.conexion = c;
    s.estado = "conectado";
    delete s.error;
    this.log(`mcp ${s.nombre}: conectado, ${c.definiciones.length} herramientas`);
    this.avisar();
  }

  private async abrir(s: Servidor, stderr: string[], conStderr: (m: string) => string): Promise<Conexion> {
    const c: Conexion = {
      cliente: new Client({ name: "aquiles", version: paquete.version }, { capabilities: {} }),
      transporte: this.transporte(s, stderr),
      definiciones: [],
      herramientas: [],
      cerrando: false,
    };
    c.cliente.onclose = () => {
      if (c.cerrando || s.conexion !== c) return;
      s.conexion = undefined;
      s.estado = "error";
      s.error = conStderr("El servidor se cerró");
      this.log(`mcp ${s.nombre}: ${s.error}`);
      this.avisar();
    };
    c.cliente.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.enCola(s.nombre, () => this.refrescar(s, c));
    });
    try {
      await c.cliente.connect(c.transporte, { timeout: TIEMPO_CONEXION });
      c.definiciones = await listarHerramientas(c.cliente);
    } catch (e) {
      await cerrarConexion(c);
      throw e;
    }
    c.herramientas = this.envolver(s.nombre, c.definiciones);
    return c;
  }

  private async desconectar(s: Servidor): Promise<void> {
    const c = s.conexion;
    s.conexion = undefined;
    const cambia = s.estado !== "desconectado";
    s.estado = "desconectado";
    delete s.error;
    if (c) await cerrarConexion(c);
    if (cambia) this.avisar();
  }

  private async refrescar(s: Servidor, c: Conexion): Promise<void> {
    if (s.conexion !== c) return;
    try {
      c.definiciones = await listarHerramientas(c.cliente);
      c.herramientas = this.envolver(s.nombre, c.definiciones);
      this.avisar();
    } catch (e) {
      this.log(`mcp ${s.nombre}: no se pudo releer la lista de herramientas: ${mensaje(e)}`);
    }
  }

  private transporte(s: Servidor, stderr: string[]): Conexion["transporte"] {
    const c = s.config;
    if (c.url) return new StreamableHTTPClientTransport(new URL(c.url));
    // En Windows npx y uvx son .cmd: con la ruta completa, el SDK sabe lanzarlos a través de cmd.
    const ejecutable = c.comando ? Bun.which(c.comando) : null;
    if (!ejecutable) throw new Error(`No se encuentra «${c.comando}»: instálalo o pon la ruta completa.`);
    const t = new StdioClientTransport({ command: ejecutable, args: c.args ?? [], env: c.env, stderr: "pipe" });
    t.stderr?.on("data", (trozo: Buffer) => {
      for (const linea of trozo.toString("utf8").split(/\r?\n/)) {
        if (!linea.trim()) continue;
        stderr.push(linea.trim());
        if (stderr.length > 20) stderr.shift();
        this.log(`mcp ${s.nombre}: ${linea.trim()}`);
      }
    });
    return t;
  }

  private envolver(servidor: string, definiciones: Tool[]): Herramienta<any>[] {
    const usados = new Set<string>();
    return definiciones.map((t) => {
      const base = nombreHerramientaMcp(servidor, t.name);
      let nombre = base;
      // Recortar a 64 puede hacer que dos nombres largos coincidan.
      for (let n = 2; usados.has(nombre); n++) nombre = `${base.slice(0, 63 - String(n).length)}_${n}`;
      usados.add(nombre);
      return this.herramienta(servidor, t, nombre);
    });
  }

  private herramienta(servidor: string, t: Tool, nombre: string): Herramienta<Record<string, unknown>> {
    return {
      nombre,
      descripcion: t.description?.trim() || t.title || `Herramienta «${t.name}» del servidor MCP «${servidor}».`,
      nivel: "ejecucion",
      parametros: z.record(z.string(), z.unknown()),
      esquema: t.inputSchema as Record<string, unknown>,
      clavePermiso: () => `mcp:${servidor}:${t.name}`,
      resumen: (args) => {
        const texto = Object.keys(args).length ? JSON.stringify(args) : "";
        return texto.length > 160 ? `${texto.slice(0, 159)}…` : texto;
      },
      ejecutar: async (args, ctx) => {
        // Se busca la conexión al llamar: tras reconectar, la herramienta que ya tenía el turno sigue valiendo.
        const c = this.servidores.get(servidor)?.conexion;
        if (!c) throw new ErrorHerramienta(`El servidor MCP «${servidor}» no está conectado.`);
        let r: CallToolResult;
        try {
          r = (await c.cliente.callTool({ name: t.name, arguments: args }, undefined, {
            signal: ctx.senal,
            timeout: TIEMPO_LLAMADA,
            resetTimeoutOnProgress: true,
            onprogress: (p) => ctx.progreso(`${p.message ?? `${p.progress}${p.total ? `/${p.total}` : ""}`}\n`),
          })) as CallToolResult;
        } catch (e) {
          if (ctx.senal.aborted) throw new ErrorHerramienta("Cancelado.");
          throw new ErrorHerramienta(`El servidor MCP «${servidor}» falló: ${mensaje(e)}`);
        }
        const texto = textoResultadoMcp(r);
        if (r.isError) throw new ErrorHerramienta(texto);
        return texto;
      },
    };
  }

  private leerDisco(): Record<string, ConfigServidor> {
    if (!this.o.ruta || !existsSync(this.o.ruta)) return {};
    let datos: unknown;
    try {
      datos = JSON.parse(readFileSync(this.o.ruta, "utf8"));
    } catch (e) {
      this.log(`mcp: ${this.o.ruta} no es JSON válido: ${mensaje(e)}`);
      return {};
    }
    const r: Record<string, ConfigServidor> = {};
    const servidores = (datos as { servidores?: unknown })?.servidores;
    for (const [nombre, valor] of Object.entries(typeof servidores === "object" && servidores ? servidores : {})) {
      const c = ConfigEnDisco.safeParse(valor);
      if (!NOMBRE.test(nombre) || !c.success || !c.data.comando === !c.data.url) {
        this.log(`mcp: se ignora «${nombre}» en ${this.o.ruta}: necesita un nombre válido y «comando» o «url» (solo uno)`);
        continue;
      }
      r[nombre] = c.data;
    }
    return r;
  }

  private escribirDisco(): void {
    if (!this.o.ruta) return;
    const servidores = Object.fromEntries([...this.servidores.values()].map((s) => [s.nombre, s.config]));
    mkdirSync(dirname(this.o.ruta), { recursive: true });
    const temporal = `${this.o.ruta}.tmp`;
    writeFileSync(temporal, `${JSON.stringify({ servidores }, null, 2)}\n`);
    renameSync(temporal, this.o.ruta);
  }
}

function info(s: Servidor): InfoServidorMcp {
  const c = s.config;
  return {
    nombre: s.nombre,
    tipo: c.url ? "http" : "stdio",
    ...(c.comando ? { comando: c.comando, args: c.args ?? [] } : {}),
    ...(c.env ? { env: Object.keys(c.env) } : {}),
    ...(c.url ? { url: c.url } : {}),
    activo: c.activo,
    estado: s.estado,
    ...(s.error ? { error: s.error } : {}),
    herramientas: (s.conexion?.definiciones ?? []).map((t) => ({ nombre: t.name, descripcion: t.description ?? "" })),
  };
}

function urlValida(texto: string): string {
  let u: URL;
  try {
    u = new URL(texto);
  } catch {
    throw new Error(`URL no válida: ${texto}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("La URL de un servidor MCP tiene que ser http o https.");
  return u.href;
}

async function listarHerramientas(cliente: Client): Promise<Tool[]> {
  if (!cliente.getServerCapabilities()?.tools) return [];
  const definiciones: Tool[] = [];
  let cursor: string | undefined;
  // El tope evita un bucle infinito con un servidor que repite el cursor.
  for (let pagina = 0; pagina < 50; pagina++) {
    const r = await cliente.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
    definiciones.push(...r.tools);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return definiciones;
}

/**
 * Cierra con educación (fin de stdin, o DELETE de la sesión HTTP) y, si un programa stdio sigue vivo,
 * mata su árbol: el SDK solo mata el proceso directo, y con un .cmd ese es cmd.exe, no el servidor.
 */
async function cerrarConexion(c: Conexion): Promise<void> {
  c.cerrando = true;
  const t = c.transporte;
  if (t instanceof StreamableHTTPClientTransport) await esperarHasta(t.terminateSession().catch(() => {}), 2000);
  const pid = t instanceof StdioClientTransport ? t.pid : null;
  const cerrado = c.cliente.close().catch(() => {});
  await esperarHasta(cerrado, 1500);
  if (pid !== null && sigueVivo(pid)) {
    await matarArbolPid(pid);
    await esperarHasta(cerrado, 2000);
  }
}

function sigueVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function matarArbolPid(pid: number): Promise<void> {
  if (!WINDOWS) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    return;
  }
  const exe = existsSync(TASKKILL) ? TASKKILL : "taskkill";
  await Bun.spawn([exe, "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true }).exited;
}
