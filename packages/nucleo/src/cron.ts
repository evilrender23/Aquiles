/**
 * Tareas programadas. Cada ejecución abre una sesión nueva con el prompt de la tarea y entrega la respuesta final en
 * los canales elegidos, con reintentos. No hay nadie delante: lo que pida permiso se deniega.
 *
 * Datos en <dir>/: tareas.json y ejecuciones.jsonl (una línea por cambio de estado; al leer gana la última de cada id).
 * Un solo temporizador apunta a la próxima ejecución más cercana y se vuelve a armar tras cada cambio.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EjecucionCron, Params, TareaProgramada } from "@aquiles/protocolo";
import type { ResultadoTurno } from "./bucle";
import { ErrorCron, interpretar } from "./cron-expresiones";
import type { Motor } from "./motor";
import type { Pasarela } from "./pasarela";

/** setTimeout no admite esperas mayores (unos 24,8 días): si la próxima está más lejos, se vuelve a armar al vencer. */
const MAX_ESPERA_MS = 2 ** 31 - 1;
const MAX_EJECUCIONES = 1000;
const MAX_RESUMEN = 2000;
/** Fecha antigua con la que reinterpretar `cuando`: así una tarea de una sola vez ya pasada no da error. */
const EPOCA = new Date(0);

type Entrega = EjecucionCron["entregas"][number];

export interface OpcionesProgramador {
  /** Carpeta de datos; null = solo en memoria. */
  dir: string | null;
  motor: Motor;
  pasarela: Pick<Pasarela, "entregar">;
  cwdPorDefecto: string;
  reloj?: { ahora(): Date };
  /** Esperas entre intentos de entrega (hay un intento más que esperas). */
  esperasReintento?: number[];
}

export class Programador {
  private tareas = new Map<string, TareaProgramada>();
  /** Ejecuciones por id en orden de inicio; cada una con su último estado. */
  private historial = new Map<string, EjecucionCron>();
  /** Tareas con una ejecución en marcha. */
  private enCurso = new Set<string>();
  private temporizador?: ReturnType<typeof setTimeout>;
  private activo = false;
  private reloj: { ahora(): Date };
  private esperas: number[];

  constructor(private o: OpcionesProgramador) {
    this.reloj = o.reloj ?? { ahora: () => new Date() };
    this.esperas = o.esperasReintento ?? [2000, 10_000];
    if (o.dir) {
      mkdirSync(o.dir, { recursive: true });
      this.cargar(o.dir);
    }
  }

  iniciar(): void {
    this.activo = true;
    this.armar();
  }

  detener(): void {
    this.activo = false;
    clearTimeout(this.temporizador);
    this.temporizador = undefined;
  }

  listar(): TareaProgramada[] {
    return [...this.tareas.values()].map((t) => this.vista(t));
  }

  crear(p: Params<"cron.crear">): TareaProgramada {
    const ahora = this.reloj.ahora();
    const expresion = interpretar(p.cuando, ahora);
    const proxima = expresion.siguiente(ahora);
    const ajustes = this.o.motor.ajustes();
    const t: TareaProgramada = {
      id: crypto.randomUUID(),
      nombre: p.nombre.trim(),
      prompt: p.prompt,
      cuando: p.cuando.trim(),
      descripcion: expresion.descripcion,
      ...(proxima ? { proxima: proxima.toISOString() } : {}),
      activa: true,
      cwd: p.cwd ?? (ajustes.carpeta || this.o.cwdPorDefecto),
      ...(p.proveedor ? { proveedor: p.proveedor } : {}),
      ...(p.modelo ? { modelo: p.modelo } : {}),
      modoAprobacion: p.modoAprobacion ?? ajustes.modoAprobacion,
      entrega: p.entrega ?? [{ canal: "escritorio" }],
      creada: ahora.toISOString(),
    };
    this.tareas.set(t.id, t);
    this.cambiado();
    return this.vista(t);
  }

  editar(p: Params<"cron.editar">): TareaProgramada {
    const t = this.obtener(p.id);
    const n: TareaProgramada = { ...t };
    if (p.nombre !== undefined) n.nombre = p.nombre.trim();
    if (p.prompt !== undefined) n.prompt = p.prompt;
    if (p.cwd !== undefined) n.cwd = p.cwd;
    if (p.modoAprobacion !== undefined) n.modoAprobacion = p.modoAprobacion;
    if (p.entrega !== undefined) n.entrega = p.entrega;
    if (p.activa !== undefined) n.activa = p.activa;
    // "" quita el proveedor o el modelo: la tarea usa entonces los del perfil.
    for (const k of ["proveedor", "modelo"] as const) {
      if (p[k] === undefined) continue;
      if (p[k]) n[k] = p[k];
      else delete n[k];
    }
    if (p.cuando !== undefined || (n.activa && !t.activa)) {
      const ahora = this.reloj.ahora();
      n.cuando = (p.cuando ?? t.cuando).trim();
      const expresion = interpretar(n.cuando, ahora);
      n.descripcion = expresion.descripcion;
      const proxima = expresion.siguiente(ahora);
      if (proxima) n.proxima = proxima.toISOString();
      else delete n.proxima;
    }
    if (!n.activa) delete n.proxima;
    this.tareas.set(n.id, n);
    this.cambiado();
    return this.vista(n);
  }

  borrar(id: string): void {
    this.obtener(id);
    this.tareas.delete(id);
    this.cambiado();
  }

  /** Ejecuta la tarea ahora, sin tocar su programación. */
  ejecutar(id: string): string {
    return this.lanzar(this.obtener(id)).id;
  }

  ejecuciones(id?: string, limite = 50): EjecucionCron[] {
    const todas = [...this.historial.values()].reverse();
    return (id ? todas.filter((e) => e.tareaId === id) : todas).slice(0, limite).map((e) => structuredClone(e));
  }

  private obtener(id: string): TareaProgramada {
    const t = this.tareas.get(id);
    if (!t) throw new ErrorCron(`No existe la tarea programada ${id}`);
    return t;
  }

  private vista(t: TareaProgramada): TareaProgramada {
    let ultima: EjecucionCron | undefined;
    for (const e of this.historial.values()) if (e.tareaId === t.id) ultima = e;
    return structuredClone({ ...t, ...(ultima ? { ultima } : {}) });
  }

  private cambiado(): void {
    if (this.o.dir) writeFileSync(join(this.o.dir, "tareas.json"), `${JSON.stringify([...this.tareas.values()], null, 2)}\n`);
    this.o.motor.emitir({ tipo: "cron.actualizado" });
    this.armar();
  }

  private armar(): void {
    clearTimeout(this.temporizador);
    this.temporizador = undefined;
    if (!this.activo) return;
    const proximas = [...this.tareas.values()].filter((t) => t.activa && t.proxima).map((t) => Date.parse(t.proxima!));
    if (!proximas.length) return;
    const espera = Math.min(Math.max(0, Math.min(...proximas) - this.reloj.ahora().getTime()), MAX_ESPERA_MS);
    this.temporizador = setTimeout(() => this.vencer(), espera);
    this.temporizador.unref?.();
  }

  /** Lanza las tareas a las que les toca (o se les pasó la hora) y calcula su siguiente ejecución desde ahora. */
  private vencer(): void {
    const ahora = this.reloj.ahora().getTime();
    const vencidas = [...this.tareas.values()].filter((t) => t.activa && t.proxima && Date.parse(t.proxima) <= ahora);
    for (const t of vencidas) {
      // Desde la hora prevista si el temporizador se adelantó un poco, para no repetirla.
      const siguiente = this.siguiente(t, new Date(Math.max(ahora, Date.parse(t.proxima!))));
      if (siguiente) t.proxima = siguiente.toISOString();
      else {
        delete t.proxima;
        t.activa = false;
      }
      this.lanzar(t);
    }
    if (vencidas.length) this.cambiado();
    else this.armar();
  }

  private siguiente(t: TareaProgramada, desde: Date): Date | undefined {
    try {
      const expresion = interpretar(t.cuando, EPOCA);
      return expresion.repite ? expresion.siguiente(desde) : undefined;
    } catch (e) {
      if (!(e instanceof ErrorCron)) throw e;
      this.o.motor.log(`cron: «${t.cuando}» de ${t.nombre} ya no se entiende (${e.message}); se desactiva`);
      return undefined;
    }
  }

  private lanzar(t: TareaProgramada): EjecucionCron {
    const inicio = this.reloj.ahora().toISOString();
    const base = { id: crypto.randomUUID(), tareaId: t.id, nombre: t.nombre, inicio, entregas: [] };
    if (this.enCurso.has(t.id)) {
      const saltada: EjecucionCron = { ...base, fin: inicio, estado: "error", error: "La ejecución anterior sigue en marcha; esta se ha saltado." };
      this.anotar(saltada);
      return saltada;
    }
    const e: EjecucionCron = { ...base, estado: "en-curso" };
    this.enCurso.add(t.id);
    this.anotar(e);
    void this.correr(structuredClone(t), e)
      .catch((error) => this.o.motor.log(`cron: ${t.nombre}: ${error instanceof Error ? error.stack : error}`))
      .finally(() => this.enCurso.delete(t.id));
    return e;
  }

  private async correr(t: TareaProgramada, e: EjecucionCron): Promise<void> {
    let sesionId: string | undefined;
    let texto = "";
    let fallo: string | undefined;
    try {
      const r = await this.o.motor.turno({
        nueva: {
          cwd: t.cwd,
          proveedor: t.proveedor,
          modelo: t.modelo,
          modoAprobacion: t.modoAprobacion,
          titulo: `Programada · ${t.nombre}`,
          origen: { tipo: "cron", tareaId: t.id },
        },
        texto: t.prompt,
      });
      sesionId = r.sesionId;
      texto = r.resultado.texto.trim();
      fallo = errorDe(r.resultado);
    } catch (error) {
      fallo = error instanceof Error ? error.message : String(error);
    }

    const mensaje = fallo ? `${t.nombre}\n\nNo se pudo completar: ${fallo}` : `${t.nombre}\n\n${texto || "(sin respuesta)"}`;
    const entregas = await Promise.all(t.entrega.map((d) => this.entregar(d, mensaje)));
    const fallidas = entregas.filter((x) => !x.ok).map((x) => `No se pudo entregar en ${x.canal}: ${x.error}`);
    const error = [...(fallo ? [`No se pudo completar: ${fallo}`] : []), ...fallidas].join("\n");
    this.anotar({
      ...e,
      fin: this.reloj.ahora().toISOString(),
      estado: error ? "error" : "ok",
      ...(sesionId ? { sesionId } : {}),
      ...(texto ? { resumen: texto.length > MAX_RESUMEN ? `${texto.slice(0, MAX_RESUMEN)}…` : texto } : {}),
      ...(error ? { error } : {}),
      entregas,
    });
    // Un fallo ya entregado como notificación de escritorio no se avisa dos veces.
    const yaAvisado = fallo && !fallidas.length && entregas.some((x) => x.canal === "escritorio");
    if (error && !yaAvisado) this.o.motor.notificar({ titulo: t.nombre, texto: error, ...(sesionId ? { sesionId } : {}) });
  }

  private async entregar(d: TareaProgramada["entrega"][number], texto: string): Promise<Entrega> {
    const destino = d.destino ? { destino: d.destino } : {};
    for (let intento = 1; ; intento++) {
      try {
        await this.o.pasarela.entregar(d.canal, d.destino, texto);
        return { canal: d.canal, ...destino, ok: true, intentos: intento };
      } catch (e) {
        const espera = this.esperas[intento - 1];
        if (espera === undefined) return { canal: d.canal, ...destino, ok: false, intentos: intento, error: e instanceof Error ? e.message : String(e) };
        await Bun.sleep(espera);
      }
    }
  }

  private anotar(e: EjecucionCron): void {
    this.historial.set(e.id, e);
    if (this.historial.size > MAX_EJECUCIONES) this.historial.delete(this.historial.keys().next().value!);
    if (this.o.dir) appendFileSync(join(this.o.dir, "ejecuciones.jsonl"), `${JSON.stringify(e)}\n`);
    this.o.motor.emitir({ tipo: "cron.ejecucion", ejecucion: structuredClone(e) });
  }

  private cargar(dir: string): void {
    try {
      const tareas = JSON.parse(readFileSync(join(dir, "tareas.json"), "utf8")) as TareaProgramada[];
      for (const t of tareas) this.tareas.set(t.id, t);
    } catch {}
    const ruta = join(dir, "ejecuciones.jsonl");
    if (!existsSync(ruta)) return;
    let lineas = 0;
    for (const l of readFileSync(ruta, "utf8").split("\n")) {
      if (!l.trim()) continue;
      lineas += 1;
      try {
        const e = JSON.parse(l) as EjecucionCron;
        this.historial.set(e.id, e);
      } catch {}
    }
    const conservadas = [...this.historial.values()].slice(-MAX_EJECUCIONES);
    this.historial = new Map(conservadas.map((e) => [e.id, e]));
    // Lo que quedó «en curso» se cortó al cerrarse Aquiles.
    const ahora = this.reloj.ahora().toISOString();
    let cortadas = 0;
    for (const e of this.historial.values()) {
      if (e.estado !== "en-curso") continue;
      this.historial.set(e.id, { ...e, estado: "error", fin: ahora, error: "Se cortó al cerrarse Aquiles." });
      cortadas += 1;
    }
    // Se reescribe con una línea por ejecución para que el fichero no crezca sin fin.
    if (cortadas || lineas > this.historial.size) {
      writeFileSync(ruta, [...this.historial.values()].map((e) => `${JSON.stringify(e)}\n`).join(""));
    }
  }
}

function errorDe(r: ResultadoTurno): string | undefined {
  switch (r.motivo) {
    case "fin":
      return undefined;
    case "error":
      return r.error ?? "error sin detalles";
    case "parado":
      return "se paró antes de terminar";
    case "limite":
      return "llegó al límite de pasos sin terminar";
  }
}
