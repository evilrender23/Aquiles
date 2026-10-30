/**
 * Kanban multiagente: tarjetas en columnas que se pueden encargar a un agente. Cada encargo es una sesión nueva
 * (origen «kanban») con su propio turno, así que varias tarjetas trabajan a la vez sin pisarse.
 *
 * El agente trabaja sin nadie delante: lo que pida permiso se deniega (como en las tareas programadas). Para que
 * escriba y ejecute sin preguntar, el modo de aprobación de los ajustes tiene que ser `libre-proyecto`.
 *
 * Datos en <dir>/kanban.json (lista de tarjetas). Con `dir` null, solo en memoria.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COLUMNAS_KANBAN, type ColumnaKanban, type Evento, type Params, type TarjetaKanban } from "@aquiles/protocolo";
import type { ResultadoTurno } from "./bucle";
import type { Motor, PeticionTurno } from "./motor";

/** Error de datos del cliente (tarjeta que no existe, título vacío…); el servidor lo devuelve como parámetros no válidos. */
export class ErrorKanban extends Error {}


/** Encargo en marcha de una tarjeta. */
interface Encargo {
  /** Se conoce con el primer evento del turno o al terminar. */
  sesionId?: string;
  /** Se borró la tarjeta antes de saber su sesión: se para en cuanto se sepa. */
  parar?: boolean;
}

export class Kanban {
  private tarjetas: TarjetaKanban[];
  private encargos = new Map<string, Encargo>();
  private readonly ruta: string | null;

  constructor(private o: { dir: string | null; motor: Motor; cwdPorDefecto: string }) {
    this.ruta = o.dir ? join(o.dir, "kanban.json") : null;
    this.tarjetas = this.leer();
    // Un agente que trabajaba cuando se cerró el núcleo ya no sigue: que se vea en la tarjeta.
    let cortadas = false;
    for (const t of this.tarjetas) {
      if (t.agente !== "trabajando") continue;
      t.agente = "error";
      t.error = "El núcleo se cerró mientras el agente trabajaba";
      cortadas = true;
    }
    if (cortadas) this.guardar();
  }

  /** Por columna (en el orden del tablero) y, dentro de cada una, por `orden`. */
  listar(): TarjetaKanban[] {
    return structuredClone(
      [...this.tarjetas].sort((a, b) => COLUMNAS_KANBAN.indexOf(a.columna) - COLUMNAS_KANBAN.indexOf(b.columna) || a.orden - b.orden),
    );
  }

  crear(p: Params<"kanban.crear">): TarjetaKanban {
    const titulo = p.titulo.trim();
    if (!titulo) throw new ErrorKanban("El título no puede estar vacío");
    const ahora = new Date().toISOString();
    const columna = p.columna ?? "pendiente";
    const t: TarjetaKanban = {
      id: crypto.randomUUID(), titulo, descripcion: p.descripcion ?? "", columna, orden: this.siguienteOrden(columna),
      cwd: p.cwd ?? this.o.cwdPorDefecto, creada: ahora, actualizada: ahora,
    };
    this.tarjetas.push(t);
    this.cambiado();
    return structuredClone(t);
  }

  editar(p: Params<"kanban.editar">): TarjetaKanban {
    const t = this.obtener(p.id);
    if (p.titulo !== undefined) {
      const titulo = p.titulo.trim();
      if (!titulo) throw new ErrorKanban("El título no puede estar vacío");
      t.titulo = titulo;
    }
    if (p.descripcion !== undefined) t.descripcion = p.descripcion;
    // Al cambiar de columna sin orden, va al final de la nueva.
    if (p.columna !== undefined && p.columna !== t.columna) {
      t.columna = p.columna;
      if (p.orden === undefined) t.orden = this.siguienteOrden(p.columna, t.id);
    }
    if (p.orden !== undefined) t.orden = p.orden;
    t.actualizada = new Date().toISOString();
    this.cambiado();
    return structuredClone(t);
  }

  borrar(id: string): void {
    this.obtener(id);
    const e = this.encargos.get(id);
    if (e) {
      if (e.sesionId) this.o.motor.parar(e.sesionId);
      else e.parar = true;
    }
    this.tarjetas = this.tarjetas.filter((t) => t.id !== id);
    this.cambiado();
  }

  /** Encarga la tarjeta a un agente en una sesión nueva; el turno sigue en segundo plano. */
  ejecutar(id: string): TarjetaKanban {
    const t = this.obtener(id);
    if (this.encargos.has(id)) throw new ErrorKanban("Esta tarjeta ya tiene un agente trabajando");
    const encargo: Encargo = {};
    this.encargos.set(id, encargo);
    if (t.columna !== "en-curso") {
      t.columna = "en-curso";
      t.orden = this.siguienteOrden("en-curso", t.id);
    }
    t.agente = "trabajando";
    delete t.sesionId;
    delete t.error;
    t.actualizada = new Date().toISOString();
    this.cambiado();
    void this.trabajar(t.id, encargo, {
      nueva: {
        cwd: t.cwd, titulo: `Kanban · ${t.titulo}`,
        origen: { tipo: "kanban", tarjetaId: t.id },
      },
      texto: textoEncargo(t),
      alEvento: (e) => this.alEvento(t.id, encargo, e),
    });
    return structuredClone(t);
  }

  private async trabajar(id: string, encargo: Encargo, peticion: PeticionTurno): Promise<void> {
    let resultado: ResultadoTurno;
    try {
      const r = await this.o.motor.turno(peticion);
      this.conocerSesion(id, encargo, r.sesionId);
      resultado = r.resultado;
    } catch (e) {
      resultado = { motivo: "error", texto: "", uso: { entrada: 0, salida: 0 }, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.encargos.delete(id);
    }
    const t = this.tarjetas.find((x) => x.id === id);
    if (!t) return; // se borró mientras trabajaba
    this.o.motor.log(`kanban «${t.titulo}»: ${resultado.motivo}${resultado.error ? ` (${resultado.error})` : ""}`);
    if (resultado.motivo === "fin") {
      t.agente = "terminado";
      // Si mientras trabajaba alguien la dio por hecha, se respeta.
      if (t.columna !== "revision" && t.columna !== "hecha") {
        t.columna = "revision";
        t.orden = this.siguienteOrden("revision", t.id);
      }
    } else if (resultado.motivo === "parado") {
      delete t.agente;
    } else {
      t.agente = "error";
      t.error = resultado.motivo === "limite" ? "Llegó al límite de pasos sin terminar" : (resultado.error ?? "Error desconocido");
    }
    t.actualizada = new Date().toISOString();
    this.cambiado();
  }

  /** La sesión del encargo llega con el primer evento del turno. */
  private alEvento(id: string, encargo: Encargo, e: Evento): void {
    if (encargo.sesionId) return;
    const sesionId = e.tipo === "sesion.actualizada" ? e.sesion.sesionId : "sesionId" in e ? e.sesionId : undefined;
    if (sesionId) this.conocerSesion(id, encargo, sesionId);
  }

  private conocerSesion(id: string, encargo: Encargo, sesionId: string): void {
    if (encargo.sesionId) return;
    encargo.sesionId = sesionId;
    if (encargo.parar) this.o.motor.parar(sesionId);
    const t = this.tarjetas.find((x) => x.id === id);
    if (!t) return;
    t.sesionId = sesionId;
    this.cambiado();
  }

  private obtener(id: string): TarjetaKanban {
    const t = this.tarjetas.find((x) => x.id === id);
    if (!t) throw new ErrorKanban(`No existe la tarjeta ${id}`);
    return t;
  }

  private siguienteOrden(columna: ColumnaKanban, salvo?: string): number {
    const ordenes = this.tarjetas.filter((t) => t.columna === columna && t.id !== salvo).map((t) => t.orden);
    return ordenes.length ? Math.max(...ordenes) + 1 : 0;
  }

  private cambiado(): void {
    this.guardar();
    this.o.motor.emitir({ tipo: "kanban.actualizado" });
  }

  private leer(): TarjetaKanban[] {
    if (!this.ruta || !existsSync(this.ruta)) return [];
    try {
      const datos = JSON.parse(readFileSync(this.ruta, "utf8"));
      if (!Array.isArray(datos)) throw new Error("no es una lista");
      return datos.flatMap((x) => normalizar(x, this.o.cwdPorDefecto) ?? []);
    } catch (e) {
      // Se aparta en vez de perderlo al guardar encima.
      const aparte = `${this.ruta}.corrupto-${Date.now()}`;
      try {
        renameSync(this.ruta, aparte);
      } catch {}
      this.o.motor.log(`kanban: ${this.ruta} no se pudo leer (${e instanceof Error ? e.message : e}); apartado en ${aparte}`);
      return [];
    }
  }

  private guardar(): void {
    if (!this.ruta) return;
    mkdirSync(this.o.dir!, { recursive: true });
    const texto = `${JSON.stringify(this.tarjetas, null, 2)}\n`;
    const temporal = `${this.ruta}.${process.pid}.tmp`;
    writeFileSync(temporal, texto);
    try {
      renameSync(temporal, this.ruta);
    } catch {
      rmSync(temporal, { force: true });
      writeFileSync(this.ruta, texto);
    }
  }
}

/** Lo que recibe el agente: la tarjeta y que resuma al acabar, porque ese resumen es lo que se revisa. */
export function textoEncargo(t: Pick<TarjetaKanban, "titulo" | "descripcion">): string {
  return [
    `Tarea del tablero kanban: ${t.titulo}`,
    ...(t.descripcion.trim() ? ["", t.descripcion.trim()] : []),
    "",
    "Trabaja en ella hasta terminarla, sin esperar a que nadie te responda: no hay nadie delante.",
    "Al acabar, resume en pocas líneas lo que hiciste, qué ficheros cambiaste y lo que quede pendiente o haya que revisar.",
  ].join("\n");
}

/** Tarjeta leída del disco con lo que falte rellenado; sin id o título no es una tarjeta. */
function normalizar(x: unknown, cwd: string): TarjetaKanban | undefined {
  const t = x as Partial<TarjetaKanban> | null;
  if (typeof t !== "object" || t === null || typeof t.id !== "string" || typeof t.titulo !== "string") return undefined;
  const ahora = new Date().toISOString();
  return {
    ...t,
    id: t.id,
    titulo: t.titulo,
    descripcion: typeof t.descripcion === "string" ? t.descripcion : "",
    columna: COLUMNAS_KANBAN.includes(t.columna as ColumnaKanban) ? t.columna! : "pendiente",
    orden: typeof t.orden === "number" ? t.orden : 0,
    cwd: typeof t.cwd === "string" ? t.cwd : cwd,
    creada: typeof t.creada === "string" ? t.creada : ahora,
    actualizada: typeof t.actualizada === "string" ? t.actualizada : ahora,
  };
}
