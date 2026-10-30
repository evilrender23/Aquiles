/**
 * Aprendizaje: revisión en segundo plano de lo que pasó en una sesión, cola de propuestas y registro de lo aprendido.
 *
 * La revisión es un turno aparte con un modelo auxiliar que solo puede leer y tocar memoria y skills. Trabaja sobre
 * una copia de la memoria y las skills del perfil; al terminar, lo que cambió en la copia se convierte en propuestas
 * (o se aplica directamente si el ajuste lo pide). Así las herramientas son las mismas que en una sesión normal.
 *
 * Datos en <perfil>/aprendizaje/: propuestas.json, historial.jsonl y revisiones/<id>/ (copias temporales).
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { AjustesAprendizaje, DestinoMemoria, EntradaAprendizaje, Evento, OrigenAprendizaje, Propuesta } from "@aquiles/protocolo";
import { ejecutarTurno } from "./bucle";
import type { Herramienta } from "./herramientas/herramienta";
import { herramientaMemoria, Memoria } from "./memoria";
import { titulo as tituloSesion, type Sesion } from "./sesiones";
import { AlmacenSkills, herramientasSkills } from "./skills";
import type { Mensaje, Proveedor } from "./tipos";

export const AJUSTES_APRENDIZAJE: AjustesAprendizaje = { activo: true, cadaHerramientas: 10, cadaMensajes: 10, aplicarSinPreguntar: false };

const DESTINOS: DestinoMemoria[] = ["usuario", "agente", "proyecto"];
const MAX_TRANSCRIPCION = 60_000;
const MAX_RESULTADO = 800;
const MAX_REVISIONES_A_LA_VEZ = 2;

const PROMPT_REVISION = [
  "Eres el revisor de aprendizaje de Aquiles. No hablas con el usuario: lees un trozo de una conversación entre el usuario",
  "y Aquiles y decides qué merece recordarse para que la próxima vez Aquiles trabaje mejor sin que se lo tengan que repetir.",
  "",
  "Qué buscar, de más a menos valor:",
  "1. Correcciones del usuario: algo que Aquiles hizo mal y el usuario corrigió, o una forma de hacerlo que pidió. Es la señal más fuerte.",
  "2. Preferencias del usuario sobre cómo trabaja, cómo quiere las respuestas o qué herramientas usa.",
  "3. Datos estables del proyecto o del entorno que costó descubrir: comandos, rutas, convenciones.",
  "4. Procedimientos de varios pasos que funcionaron y que probablemente se repetirán.",
  "",
  "Dónde guardarlo:",
  "- Hechos y preferencias cortos → herramienta memoria. usuario = quién es y qué prefiere; proyecto = lo de la carpeta",
  "  de la conversación; agente = lo que vale en cualquier sitio.",
  "- Procedimientos repetibles por clase de tarea → gestionar_skill. Antes, mira el índice de skills y abre con ver_skill",
  "  las parecidas: mejor ampliar una que crear otra.",
  "",
  "Reglas:",
  "- Cada cosa en un solo sitio. Si ya está en la memoria o en una skill, no la repitas; si hay que corregirla, sustitúyela.",
  "- Lee antes de escribir. Puedes comprobar cosas del proyecto con leer, buscar_texto y buscar_ficheros.",
  "- No guardes fallos pasajeros del entorno (red caída, un proceso colgado), intentos que no funcionaron ni datos que",
  "  solo valían para esta tarea.",
  "- Nada de claves, contraseñas ni datos personales sensibles.",
  "- No guardar nada es un resultado válido y frecuente.",
  "",
  "Lo que guardes no se aplica todavía: se le propone al usuario, que lo acepta o lo descarta.",
  "Termina con una o dos líneas: qué propones y por qué, o «Nada que guardar».",
].join("\n");

/** Cola de propuestas y registro de lo aprendido. */
export class RegistroAprendizaje {
  private propuestasEnMemoria: Propuesta[] = [];
  private historialEnMemoria: EntradaAprendizaje[] = [];

  /** `dir` null: solo en memoria (tests). */
  constructor(private dir: string | null) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  propuestas(todas = false): Propuesta[] {
    const lista = this.leerPropuestas();
    return (todas ? lista : lista.filter((p) => p.estado === "pendiente")).sort((a, b) => b.fecha.localeCompare(a.fecha));
  }

  propuesta(id: string): Propuesta | undefined {
    return this.leerPropuestas().find((p) => p.id === id);
  }

  nuevaPropuesta(p: Omit<Propuesta, "id" | "fecha" | "estado">): Propuesta {
    const completa: Propuesta = { id: crypto.randomUUID(), fecha: new Date().toISOString(), estado: "pendiente", ...p };
    this.guardarPropuestas([...this.leerPropuestas(), completa]);
    return completa;
  }

  actualizarPropuesta(id: string, cambios: Partial<Propuesta>): Propuesta {
    const lista = this.leerPropuestas();
    const i = lista.findIndex((p) => p.id === id);
    if (i === -1) throw new Error(`No existe la propuesta ${id}`);
    const nueva = { ...lista[i]!, ...cambios };
    if (cambios.error === undefined && "error" in cambios) delete nueva.error;
    lista[i] = nueva;
    this.guardarPropuestas(lista);
    return nueva;
  }

  anotar(e: Omit<EntradaAprendizaje, "id" | "fecha">): EntradaAprendizaje {
    const entrada: EntradaAprendizaje = { id: crypto.randomUUID(), fecha: new Date().toISOString(), ...e };
    if (this.dir) appendFileSync(join(this.dir, "historial.jsonl"), `${JSON.stringify(entrada)}\n`);
    else this.historialEnMemoria.push(entrada);
    return entrada;
  }

  historial(limite = 200): EntradaAprendizaje[] {
    let todas = this.historialEnMemoria;
    if (this.dir && existsSync(join(this.dir, "historial.jsonl"))) {
      todas = [];
      for (const l of readFileSync(join(this.dir, "historial.jsonl"), "utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          todas.push(JSON.parse(l));
        } catch {}
      }
    }
    return todas.slice(-limite).reverse();
  }

  private leerPropuestas(): Propuesta[] {
    if (!this.dir) return structuredClone(this.propuestasEnMemoria);
    try {
      const datos = JSON.parse(readFileSync(join(this.dir, "propuestas.json"), "utf8"));
      return Array.isArray(datos) ? datos : [];
    } catch {
      return [];
    }
  }

  private guardarPropuestas(lista: Propuesta[]): void {
    if (!this.dir) {
      this.propuestasEnMemoria = structuredClone(lista);
      return;
    }
    writeFileSync(join(this.dir, "propuestas.json"), `${JSON.stringify(lista, null, 2)}\n`);
  }
}

/** Trozo de conversación como texto para el revisor; los resultados de herramientas van recortados. */
export function transcripcionRevision(mensajes: readonly Mensaje[]): string {
  const partes = mensajes.map((m) => {
    switch (m.rol) {
      case "usuario": {
        const adjuntos = m.adjuntos?.length ? `\n(Adjuntos: ${m.adjuntos.map((a) => `${a.nombre}, ${a.clase}`).join("; ")})` : "";
        return `[Usuario]\n${m.texto}${adjuntos}`;
      }
      case "resumen":
        return `[Resumen de lo anterior]\n${m.texto}`;
      case "asistente": {
        const llamadas = m.llamadas.map((l) => `→ ${l.nombre} ${JSON.stringify(l.argumentos).slice(0, 300)}`);
        return ["[Aquiles]", m.texto, ...llamadas].filter(Boolean).join("\n");
      }
      default: {
        const r = m.resultado.length > MAX_RESULTADO ? `${m.resultado.slice(0, MAX_RESULTADO)}… (recortado)` : m.resultado;
        return `[Resultado de ${m.nombre}${m.error ? ", error" : ""}]\n${r}`;
      }
    }
  });
  const texto = partes.join("\n\n");
  return texto.length > MAX_TRANSCRIPCION ? `(… principio omitido …)\n${texto.slice(-MAX_TRANSCRIPCION)}` : texto;
}

type Instantanea = { memoria: Map<DestinoMemoria, string[]>; skills: Map<string, Map<string, string>> };

function instantanea(memoria: Memoria, raizSkills: string, cwd: string): Instantanea {
  const m = new Map<DestinoMemoria, string[]>();
  for (const d of DESTINOS) m.set(d, memoria.leer(d, cwd).entradas);
  const s = new Map<string, Map<string, string>>();
  if (existsSync(raizSkills)) {
    for (const nombre of readdirSync(raizSkills)) {
      const dir = join(raizSkills, nombre);
      if (!statSync(dir).isDirectory()) continue;
      const ficheros = new Map<string, string>();
      const recorrer = (d: string) => {
        for (const f of readdirSync(d, { withFileTypes: true })) {
          const abs = join(d, f.name);
          if (f.isDirectory()) recorrer(abs);
          else ficheros.set(relative(dir, abs).replace(/\\/g, "/"), readFileSync(abs, "utf8"));
        }
      };
      recorrer(dir);
      s.set(nombre, ficheros);
    }
  }
  return { memoria: m, skills: s };
}

/** Diferencias entre dos instantáneas como propuestas (sin id, fecha ni estado). */
export function diferencias(antes: Instantanea, despues: Instantanea, cwd: string, origen: OrigenAprendizaje): Omit<Propuesta, "id" | "fecha" | "estado">[] {
  const salida: Omit<Propuesta, "id" | "fecha" | "estado">[] = [];
  for (const d of DESTINOS) {
    const a = antes.memoria.get(d) ?? [];
    const b = despues.memoria.get(d) ?? [];
    const anadidas = b.filter((e) => !a.includes(e));
    const quitadas = a.filter((e) => !b.includes(e));
    if (!anadidas.length && !quitadas.length) continue;
    const resumen = [
      ...anadidas.map((e) => `+ ${recortar(e)}`),
      ...quitadas.map((e) => `− ${recortar(e)}`),
    ].join("; ");
    salida.push({ origen, tipo: "memoria", resumen: `Memoria de ${d}: ${resumen}`, destino: d, ...(d === "proyecto" ? { cwd } : {}), anadidas, quitadas });
  }
  for (const [nombre, ficheros] of despues.skills) {
    const previos = antes.skills.get(nombre);
    const cambiados = [...ficheros].filter(([ruta, contenido]) => previos?.get(ruta) !== contenido);
    if (!cambiados.length) continue;
    const nueva = !previos;
    salida.push({
      origen,
      tipo: "skill",
      resumen: nueva ? `Skill nueva «${nombre}»` : `Cambios en la skill «${nombre}» (${cambiados.map(([r]) => r).join(", ")})`,
      nombre,
      nueva,
      ficheros: cambiados.map(([ruta, despues]) => ({ ruta, ...(previos?.has(ruta) ? { antes: previos.get(ruta)! } : {}), despues })),
    });
  }
  return salida;
}

function recortar(t: string, max = 80): string {
  const una = t.replace(/\s+/g, " ").trim();
  return una.length > max ? `${una.slice(0, max - 1)}…` : una;
}

export interface OpcionesRevision {
  perfil: string | null;
  incluidas: string | null;
  cwd: string;
  mensajes: readonly Mensaje[];
  origen: OrigenAprendizaje;
  proveedor: Proveedor;
  /** Herramientas de lectura que puede usar el revisor (leer, buscar_texto, buscar_ficheros). */
  lectura: readonly Herramienta<any>[];
  senal: AbortSignal;
}

/** Ejecuta una revisión sobre una copia del perfil y devuelve lo que cambiaría. */
export async function revisar(o: OpcionesRevision): Promise<{ propuestas: Omit<Propuesta, "id" | "fecha" | "estado">[]; texto: string; error?: string }> {
  const raiz = o.perfil ? join(o.perfil, "aprendizaje", "revisiones") : tmpdir();
  mkdirSync(raiz, { recursive: true });
  const copia = mkdtempSync(join(raiz, o.perfil ? "r-" : "aquiles-revision-"));
  try {
    if (o.perfil) {
      for (const parte of ["memoria", "skills", "skills.json", "SOUL.md"]) {
        const origen = join(o.perfil, parte);
        if (existsSync(origen)) cpSync(origen, join(copia, parte), { recursive: true });
      }
    }
    const memoria = new Memoria(copia);
    const skills = new AlmacenSkills({ perfil: copia, incluidas: o.incluidas });
    const antes = instantanea(memoria, join(copia, "skills"), o.cwd);
    const sistema = [PROMPT_REVISION, memoria.seccionPrompt(o.cwd), skills.seccionPrompt(o.cwd)].filter(Boolean).join("\n\n");
    const mensajes: Mensaje[] = [
      { rol: "usuario", texto: `Carpeta de la conversación: ${o.cwd}\n\nConversación a revisar:\n\n${transcripcionRevision(o.mensajes)}` },
    ];
    const sesionId = `revision-${crypto.randomUUID()}`;
    const r = await ejecutarTurno({
      sesionId,
      cwd: o.cwd,
      sistema,
      mensajes,
      proveedor: o.proveedor,
      herramientas: [...o.lectura, herramientaMemoria(memoria), ...herramientasSkills(skills)],
      emitir: () => {},
      senal: o.senal,
      entorno: { lecturas: new Map(), estado: new Map(), permitidos: new Set(), modoAprobacion: "libre-proyecto", steer: [] },
      // Solo lee y escribe en la copia: no hay nada que aprobar.
      aprobar: async () => "permitir",
      preguntar: async () => "No hay nadie a quien preguntar: decide tú.",
      maxIteraciones: 12,
    }).finally(() => o.proveedor.cerrar?.(sesionId));
    if (r.motivo !== "fin") return { propuestas: [], texto: r.texto, error: r.error ?? r.motivo };
    const despues = instantanea(memoria, join(copia, "skills"), o.cwd);
    return { propuestas: diferencias(antes, despues, o.cwd, o.origen), texto: r.texto };
  } finally {
    rmSync(copia, { recursive: true, force: true });
  }
}

export interface OpcionesAprendizaje {
  perfil: string | null;
  incluidas: string | null;
  memoria: Memoria;
  skills: AlmacenSkills;
  registro: RegistroAprendizaje;
  ajustes: () => AjustesAprendizaje;
  /** Proveedor de la revisión de una sesión (el auxiliar de los ajustes o el de la sesión). */
  proveedorDe: (s: Sesion, a: AjustesAprendizaje) => Proveedor;
  lectura: readonly Herramienta<any>[];
  emitir: (e: Evento) => void;
  log?: (m: string) => void;
}

export type ResultadoRevision =
  | { estado: "hecha"; propuestas: number; aplicadas: number; texto: string }
  | { estado: "omitida"; motivo: string }
  | { estado: "error"; error: string };

interface Contador {
  herramientas: number;
  mensajes: number;
  /** Mensajes de la sesión ya revisados. */
  desde: number;
}

/** Contadores por sesión, lanzamiento de revisiones y decisiones sobre propuestas. */
export class Aprendizaje {
  private contadores = new Map<string, Contador>();
  private enCurso = new Map<string, AbortController>();
  /** Sesiones con un `/aprender` en marcha: lo que guarden cuenta como origen "aprender". */
  readonly aprendiendo = new Set<string>();

  constructor(private o: OpcionesAprendizaje) {}

  private contador(s: Sesion): Contador {
    let c = this.contadores.get(s.id);
    if (!c) {
      c = { herramientas: 0, mensajes: 0, desde: 0 };
      this.contadores.set(s.id, c);
    }
    return c;
  }

  alMensajeUsuario(s: Sesion): void {
    this.contador(s).mensajes += 1;
  }

  alHerramienta(s: Sesion): void {
    this.contador(s).herramientas += 1;
  }

  /** Al terminar un turno: lanza la revisión si se pasó algún umbral. */
  alTerminarTurno(s: Sesion): void {
    const a = this.o.ajustes();
    const c = this.contador(s);
    if (!a.activo || (c.herramientas < a.cadaHerramientas && c.mensajes < a.cadaMensajes)) return;
    void this.revisar(s);
  }

  revisando(sesionId: string): boolean {
    return this.enCurso.has(sesionId);
  }

  /**
   * Revisa lo que haya pasado en la sesión desde la última revisión (o la conversación entera con `completa`).
   * Lanza el evento `aprendizaje.revision` al empezar y al acabar.
   */
  async revisar(s: Sesion, o: { completa?: boolean } = {}): Promise<ResultadoRevision> {
    if (this.enCurso.has(s.id)) return { estado: "omitida", motivo: "ya hay una revisión de esta sesión en marcha" };
    if (this.enCurso.size >= MAX_REVISIONES_A_LA_VEZ) return { estado: "omitida", motivo: "hay demasiadas revisiones en marcha" };
    const c = this.contador(s);
    const desde = o.completa ? 0 : Math.min(c.desde, s.mensajes.length);
    const trozo = s.mensajes.slice(desde);
    if (!trozo.some((m) => m.rol === "usuario")) return { estado: "omitida", motivo: "no hay nada nuevo que revisar" };
    const control = new AbortController();
    this.enCurso.set(s.id, control);
    c.herramientas = 0;
    c.mensajes = 0;
    c.desde = s.mensajes.length;
    const a = this.o.ajustes();
    const origen: OrigenAprendizaje = { tipo: "revision", sesionId: s.id, ...(tituloSesion(s) ? { titulo: tituloSesion(s) } : {}) };
    this.o.emitir({ tipo: "aprendizaje.revision", sesionId: s.id, estado: "inicio" });
    try {
      const r = await revisar({
        perfil: this.o.perfil, incluidas: this.o.incluidas, cwd: s.cwd, mensajes: trozo, origen,
        proveedor: this.o.proveedorDe(s, a), lectura: this.o.lectura, senal: control.signal,
      });
      if (r.error) throw new Error(r.error);
      let aplicadas = 0;
      for (const p of r.propuestas) {
        const nueva = this.o.registro.nuevaPropuesta(p);
        if (a.aplicarSinPreguntar && this.aceptar(nueva).estado === "aceptada") aplicadas += 1;
      }
      this.o.log?.(`revisión de ${s.id}: ${r.propuestas.length} propuestas, ${aplicadas} aplicadas`);
      this.o.emitir({ tipo: "aprendizaje.revision", sesionId: s.id, estado: "fin", propuestas: r.propuestas.length - aplicadas, aplicadas });
      if (r.propuestas.length) this.o.emitir({ tipo: "aprendizaje.actualizado" });
      return { estado: "hecha", propuestas: r.propuestas.length - aplicadas, aplicadas, texto: r.texto };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.o.log?.(`revisión de ${s.id} falló: ${error}`);
      this.o.emitir({ tipo: "aprendizaje.revision", sesionId: s.id, estado: "error", error });
      return { estado: "error", error };
    } finally {
      this.enCurso.delete(s.id);
    }
  }

  decidir(id: string, decision: "aceptar" | "descartar"): Propuesta {
    const p = this.o.registro.propuesta(id);
    if (!p) throw new Error(`No existe la propuesta ${id}`);
    if (p.estado !== "pendiente") return p;
    const r = decision === "descartar" ? this.o.registro.actualizarPropuesta(id, { estado: "descartada", error: undefined }) : this.aceptar(p);
    this.o.emitir({ tipo: "aprendizaje.actualizado" });
    return r;
  }

  /** Aplica una propuesta; si no se puede, la deja pendiente con el error. */
  private aceptar(p: Propuesta): Propuesta {
    try {
      if (p.tipo === "memoria") {
        const destino = p.destino!;
        const actuales = this.o.memoria.leer(destino, p.cwd).entradas;
        const quitadas = new Set(p.quitadas ?? []);
        const nuevas = [...actuales.filter((e) => !quitadas.has(e)), ...(p.anadidas ?? []).filter((e) => !actuales.includes(e))];
        this.o.memoria.guardar(destino, nuevas, p.cwd);
        this.o.emitir({ tipo: "memoria.actualizada", destino, ...(destino === "proyecto" && p.cwd ? { cwd: p.cwd } : {}) });
      } else {
        const nombre = p.nombre!;
        const actual = this.o.skills.leer(nombre);
        if (p.nueva && actual) throw new Error(`Ya existe una skill «${nombre}»; descarta la propuesta o revisa de nuevo.`);
        for (const f of p.ficheros ?? []) {
          if (f.antes === undefined || !actual) continue;
          const hoy = f.ruta === "SKILL.md" ? actual.contenido : this.o.skills.leerFichero(nombre, f.ruta);
          if (hoy !== undefined && hoy.replace(/\r\n/g, "\n") !== f.antes.replace(/\r\n/g, "\n")) {
            throw new Error(`${nombre}/${f.ruta} ha cambiado desde la propuesta; descártala o revisa de nuevo.`);
          }
        }
        this.o.skills.aplicarFicheros(nombre, (p.ficheros ?? []).map((f) => ({ ruta: f.ruta, contenido: f.despues })), { motivo: "propuesta" });
        this.o.emitir({ tipo: "skills.actualizadas" });
      }
    } catch (e) {
      return this.o.registro.actualizarPropuesta(p.id, { error: e instanceof Error ? e.message : String(e) });
    }
    this.o.registro.anotar({ origen: p.origen, tipo: p.tipo, resumen: p.resumen, propuestaId: p.id });
    this.o.emitir({ tipo: "aprendizaje.actualizado" });
    return this.o.registro.actualizarPropuesta(p.id, { estado: "aceptada", error: undefined });
  }

  /** Para las revisiones en marcha (al cerrar el núcleo). */
  cerrar(): void {
    for (const c of this.enCurso.values()) c.abort();
  }
}

/** Instrucción que sustituye a `/aprender <fuente>`. */
export function instruccionAprender(fuente: string): string {
  return [
    `Aprende de esta fuente: ${fuente}`,
    "",
    "Puede ser una carpeta, un fichero o una URL (léela con leer_web). Estúdiala con las herramientas de lectura y guarda lo que valga para el futuro:",
    "- procedimientos repetibles (cómo se hace algo: pasos, comandos, trampas y cómo comprobarlo) → skills con gestionar_skill.",
    "  Antes, mira el índice de skills y abre con ver_skill las parecidas: mejor ampliar una que crear otra;",
    "- hechos y preferencias cortos → memoria (proyecto si son de esta carpeta, agente si valen en cualquier sitio).",
    "No copies la documentación entera: quédate con lo que no es obvio. Al terminar, di en pocas líneas qué guardaste y dónde.",
  ].join("\n");
}
