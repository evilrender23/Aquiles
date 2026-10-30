/**
 * Sesiones: estado en memoria + un JSONL por sesión en `<perfil>/sesiones/<id>.jsonl`.
 * Líneas: {"tipo":"inicio",…}, {"tipo":"mensaje","mensaje":…} y {"tipo":"compactacion","mensajes":[…]}
 * (esta última sustituye el historial entero). Una última línea cortada se ignora al cargar.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InfoSesion, MensajeHistorial, ModoAprobacion } from "@aquiles/protocolo";
import type { Huella } from "./herramientas/herramienta";
import type { Mensaje } from "./tipos";

export interface Sesion {
  id: string;
  cwd: string;
  /** Se fija al crear la sesión y no cambia, para que la caché de prompt del proveedor sirva. */
  sistema: string;
  mensajes: Mensaje[];
  creada: string;
  actualizada: string;
  modoAprobacion: ModoAprobacion;
  /** Claves de "permitir siempre" concedidas en esta sesión. */
  permitidos: Set<string>;
  lecturas: Map<string, Huella>;
  estado: Map<string, unknown>;
  /** Mensajes escritos por el usuario mientras el turno trabaja; entran en el siguiente paso. */
  steer: string[];
  turno?: AbortController;
}

export function sistemaBase(cwd: string, fecha = new Date()): string {
  return [
    "Eres Aquiles, un agente personal que trabaja en el ordenador del usuario.",
    `Carpeta de trabajo: ${cwd}`,
    `Fecha: ${fecha.toISOString().slice(0, 10)}`,
    "Responde en el idioma del usuario, de forma directa.",
    "Comprueba con las herramientas en vez de suponer el contenido de los ficheros.",
    "Lee un fichero antes de editarlo; usa editar para cambios concretos y escribir para ficheros nuevos.",
    "Ejecuta los tests o comandos que demuestren que el cambio funciona antes de darlo por terminado.",
    "En trabajos de varios pasos, lleva la lista con la herramienta tareas.",
  ].join("\n");
}

type Linea =
  | { tipo: "inicio"; id: string; cwd: string; sistema: string; creada: string; modoAprobacion: ModoAprobacion }
  | { tipo: "mensaje"; mensaje: Mensaje }
  | { tipo: "compactacion"; mensajes: Mensaje[] };

export class AlmacenSesiones {
  private enMemoria = new Map<string, Sesion>();

  /** `directorio` null: solo en memoria (tests). */
  constructor(private directorio: string | null) {
    if (directorio) mkdirSync(directorio, { recursive: true });
  }

  crear(cwd: string, modoAprobacion: ModoAprobacion = "preguntar-ejecutar"): Sesion {
    const ahora = new Date().toISOString();
    const s = nueva(crypto.randomUUID(), cwd, sistemaBase(cwd), ahora, modoAprobacion);
    this.enMemoria.set(s.id, s);
    this.escribir(s, { tipo: "inicio", id: s.id, cwd, sistema: s.sistema, creada: ahora, modoAprobacion }, true);
    return s;
  }

  /** Busca en memoria y, si no está, la carga del disco. */
  obtener(id: string): Sesion | undefined {
    const s = this.enMemoria.get(id);
    if (s) return s;
    if (!this.directorio || !/^[\w-]+$/.test(id)) return undefined;
    const ruta = join(this.directorio, `${id}.jsonl`);
    if (!existsSync(ruta)) return undefined;
    const cargada = cargar(ruta);
    if (cargada) this.enMemoria.set(id, cargada);
    return cargada;
  }

  anotar(s: Sesion, m: Mensaje): void {
    this.escribir(s, { tipo: "mensaje", mensaje: m });
  }

  anotarCompactacion(s: Sesion): void {
    this.escribir(s, { tipo: "compactacion", mensajes: s.mensajes });
  }

  listar(): InfoSesion[] {
    const vistas = new Map<string, InfoSesion>();
    if (this.directorio) {
      for (const f of readdirSync(this.directorio)) {
        if (!f.endsWith(".jsonl")) continue;
        const id = f.slice(0, -6);
        if (this.enMemoria.has(id)) continue;
        const s = cargar(join(this.directorio, f));
        if (s) vistas.set(id, info(s));
      }
    }
    for (const s of this.enMemoria.values()) vistas.set(s.id, info(s));
    return [...vistas.values()].sort((a, b) => b.actualizada.localeCompare(a.actualizada));
  }

  enCurso(): Sesion[] {
    return [...this.enMemoria.values()];
  }

  private escribir(s: Sesion, linea: Linea, crear = false): void {
    s.actualizada = new Date().toISOString();
    if (!this.directorio) return;
    const ruta = join(this.directorio, `${s.id}.jsonl`);
    const texto = `${JSON.stringify(linea)}\n`;
    if (crear) writeFileSync(ruta, texto);
    else appendFileSync(ruta, texto);
  }
}

function nueva(id: string, cwd: string, sistema: string, creada: string, modoAprobacion: ModoAprobacion): Sesion {
  return {
    id, cwd, sistema, mensajes: [], creada, actualizada: creada, modoAprobacion,
    permitidos: new Set(), lecturas: new Map(), estado: new Map(), steer: [],
  };
}

function cargar(ruta: string): Sesion | undefined {
  let s: Sesion | undefined;
  for (const bruto of readFileSync(ruta, "utf8").split("\n")) {
    if (!bruto.trim()) continue;
    let l: Linea;
    try {
      l = JSON.parse(bruto);
    } catch {
      continue; // última línea a medio escribir
    }
    if (l.tipo === "inicio") s = nueva(l.id, l.cwd, l.sistema, l.creada, l.modoAprobacion ?? "preguntar-ejecutar");
    else if (s && l.tipo === "mensaje") s.mensajes.push(l.mensaje);
    else if (s && l.tipo === "compactacion") s.mensajes = l.mensajes;
  }
  if (s) s.actualizada = statSync(ruta).mtime.toISOString();
  return s;
}

export function titulo(s: Sesion): string | undefined {
  const primero = s.mensajes.find((m) => m.rol === "usuario");
  if (primero?.rol !== "usuario") return undefined;
  const t = primero.texto.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

export function info(s: Sesion): InfoSesion {
  return {
    sesionId: s.id, cwd: s.cwd, titulo: titulo(s), creada: s.creada, actualizada: s.actualizada,
    mensajes: s.mensajes.length, modoAprobacion: s.modoAprobacion,
  };
}

export function historial(s: Sesion): MensajeHistorial[] {
  return s.mensajes.map((m) =>
    m.rol === "herramienta"
      ? { rol: "herramienta", nombre: m.nombre, resultado: m.resultado.slice(0, 2000), error: m.error }
      : { rol: m.rol, texto: m.texto },
  );
}
