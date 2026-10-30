/**
 * Comandos con «/» de la caja de texto. Llegan por prompt.enviar con el texto empezando por `/nombre`:
 *   - los de Aquiles: `/aprender [fuente]`, `/objetivo <texto>` y `/compactar`;
 *   - uno por skill activa, `/<skill> [texto]`: un turno que le pide al modelo cargar esa skill y seguirla.
 * Si un nombre es a la vez de Aquiles y de una skill, gana el de Aquiles. Un `/nombre` que no es ningún comando
 * (una ruta, una errata) va al modelo como texto normal.
 *
 * Los que no necesitan al modelo (`/aprender` sin fuente, `/objetivo` sin texto, `/compactar`) se contestan como un
 * turno: el mensaje del usuario y la respuesta quedan en la conversación, y acaban con `turno.fin`.
 */
import type { Evento, InfoComando } from "@aquiles/protocolo";
import { borrarAdjuntos } from "./adjuntos";
import { type Aprendizaje, instruccionAprender, type ResultadoRevision } from "./aprendizaje";
import { compactarSiHaceFalta, puntoDeCorte } from "./contexto";
import type { Objetivos } from "./objetivos";
import type { AlmacenSesiones, Sesion } from "./sesiones";
import type { AlmacenSkills } from "./skills";
import { type AdjuntoGuardado, ErrorAbortado, type Mensaje, type Proveedor } from "./tipos";

const MAX_DESCRIPCION_SKILL = 200;

export interface OrdenComando {
  nombre: string;
  /** Lo que va detrás del nombre, sin espacios a los lados; "" si no hay nada. */
  argumentos: string;
}

/** `/nombre resto` → {nombre, argumentos}. Una ruta como `/usr/bin` no es un comando. */
export function analizarComando(texto: string): OrdenComando | undefined {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(texto.trim());
  return m ? { nombre: m[1]!, argumentos: (m[2] ?? "").trim() } : undefined;
}

/** Empieza por el comando tal cual: es lo que sale como título de la sesión y al reabrirla. */
export function instruccionSkill(nombre: string, texto: string): string {
  return texto
    ? `/${nombre} ${texto}\n\nUsa la skill «${nombre}» para esto: cárgala con ver_skill y sigue sus instrucciones.`
    : `/${nombre}\n\nUsa la skill «${nombre}»: cárgala con ver_skill y sigue sus instrucciones. Si te falta algo para empezar, pregúntamelo.`;
}

export function instruccionObjetivo(objetivo: string): string {
  return [
    `Objetivo: ${objetivo}`,
    "",
    "Trabaja hasta cumplirlo. Al acabar cada turno, un juez revisará la conversación para comprobarlo, así que deja pruebas",
    "de que está hecho (resultados de comandos, tests que pasan, ficheros escritos).",
  ].join("\n");
}

/** Lo que el núcleo pone a disposición de los comandos. */
export interface EntornoComandos {
  skills: AlmacenSkills;
  objetivos: Objetivos;
  aprendizaje: Aprendizaje;
  sesiones: AlmacenSesiones;
  proveedorDe: (s: Sesion) => Proveedor;
  /** Lanza un turno normal del agente con este texto; lanza un error si no puede empezar (sesión ocupada…). */
  turno: (s: Sesion, texto: string, adjuntos?: AdjuntoGuardado[]) => void;
  emitir: (e: Evento) => void;
  /** Avisa a la interfaz de que la sesión cambió (trabajando, objetivo…). */
  avisar: (s: Sesion) => void;
  /** Carpeta de las sesiones nuevas: sus skills son las que se ofrecen cuando aún no hay sesión. */
  carpetaPorDefecto: () => string;
}

interface Comando {
  info: Omit<InfoComando, "nombre" | "origen">;
  /** Solo se ofrece si se cumple (p. ej. compactar, con sesión y con un modelo cuyo historial lleva Aquiles). */
  disponible?: (s: Sesion | undefined) => boolean;
  ejecutar: (s: Sesion, orden: OrdenComando, texto: string, adjuntos: AdjuntoGuardado[]) => void;
}

export class Comandos {
  private readonly propios: Record<string, Comando>;

  constructor(private readonly e: EntornoComandos) {
    this.propios = {
      aprender: {
        info: { argumentos: "[fuente]", descripcion: "Aprende de una carpeta, un fichero o una URL; sin nada, repasa esta conversación y guarda lo que valga" },
        ejecutar: (s, { argumentos }, texto, adjuntos) => {
          if (!argumentos && !adjuntos.length) {
            this.responder(s, texto, async () => textoRevision(await e.aprendizaje.revisar(s, { completa: true })));
            return;
          }
          e.aprendizaje.aprendiendo.add(s.id);
          try {
            // Con adjuntos y sin más, la fuente son los adjuntos.
            e.turno(s, instruccionAprender(argumentos || "los ficheros adjuntos a este mensaje"), adjuntos);
          } catch (err) {
            e.aprendizaje.aprendiendo.delete(s.id);
            throw err;
          }
        },
      },
      compactar: {
        info: { descripcion: "Resume la parte antigua de la conversación para liberar contexto" },
        disponible: (s) => !!s && this.compactable(s),
        ejecutar: (s, _orden, texto, adjuntos) => {
          void borrarAdjuntos(adjuntos);
          this.responder(s, texto, (senal) => this.compactar(s, senal));
        },
      },
      objetivo: {
        info: { argumentos: "<texto>", descripcion: "Fija un objetivo y trabaja hasta cumplirlo; un juez lo comprueba tras cada turno. Sin texto, lo quita" },
        ejecutar: (s, { argumentos }, texto, adjuntos) => {
          if (!argumentos) {
            void borrarAdjuntos(adjuntos);
            const antes = e.objetivos.de(s.id);
            e.objetivos.fijar(s, null);
            this.responder(s, texto, async () =>
              antes ? `He quitado el objetivo: ${antes.texto}` : "Esta sesión no tiene objetivo. Para fijar uno, escribe /objetivo y lo que hay que conseguir.",
            );
            return;
          }
          e.turno(s, instruccionObjetivo(argumentos), adjuntos);
          // El turno ya ha empezado (si no, habría lanzado): el juez lo mirará al acabar.
          e.objetivos.fijar(s, argumentos);
          e.avisar(s);
        },
      },
    };
  }

  /** Los de Aquiles y uno por skill activa (las de la carpeta de la sesión o, sin sesión, la de las sesiones nuevas). */
  listar(s?: Sesion): InfoComando[] {
    const propios = Object.entries(this.propios)
      .filter(([, c]) => c.disponible?.(s) ?? true)
      .map(([nombre, c]): InfoComando => ({ nombre, ...c.info, origen: "aquiles" }));
    const skills = this.skillsActivas(s?.cwd ?? this.e.carpetaPorDefecto()).map(
      (k): InfoComando => ({ nombre: k.nombre, argumentos: "[texto]", descripcion: recortar(k.descripcion.replace(/\s+/g, " ").trim(), MAX_DESCRIPCION_SKILL), origen: "skill" }),
    );
    return [...propios, ...skills];
  }

  /** Ejecuta el comando con que empieza el texto. false = no es ningún comando: va al modelo como texto normal. */
  ejecutar(s: Sesion, texto: string, adjuntos: AdjuntoGuardado[] = []): boolean {
    const orden = analizarComando(texto);
    if (!orden) return false;
    const propio = Object.hasOwn(this.propios, orden.nombre) ? this.propios[orden.nombre] : undefined;
    if (propio) {
      propio.ejecutar(s, orden, texto, adjuntos);
      return true;
    }
    if (!this.skillsActivas(s.cwd).some((k) => k.nombre === orden.nombre)) return false;
    this.e.turno(s, instruccionSkill(orden.nombre, orden.argumentos), adjuntos);
    return true;
  }

  private skillsActivas(cwd: string) {
    return this.e.skills.listar(cwd).filter((k) => k.activa && !Object.hasOwn(this.propios, k.nombre));
  }

  /** Los modelos que guardan su propia conversación (agy, claude) no dejan que Aquiles la compacte. */
  private compactable(s: Sesion): boolean {
    try {
      return !this.e.proveedorDe(s).conversacionPropia;
    } catch {
      return false;
    }
  }

  private async compactar(s: Sesion, senal: AbortSignal): Promise<string> {
    const proveedor = this.e.proveedorDe(s);
    if (proveedor.conversacionPropia) return `${proveedor.nombre} lleva su propia conversación: Aquiles no puede compactarla.`;
    if (puntoDeCorte(s.mensajes) === 0) return "La conversación aún es corta: no hay nada que compactar.";
    const c = await compactarSiHaceFalta({ proveedor, sistema: s.sistema, mensajes: s.mensajes, senal, sesionId: s.id, forzar: true });
    if (!c) return "No había nada que compactar.";
    s.mensajes.splice(0, s.mensajes.length, ...c.mensajes);
    this.e.sesiones.anotarCompactacion(s);
    // El medidor de contexto de la interfaz se queda con la cifra de antes hasta la próxima llamada al modelo.
    this.e.emitir({ tipo: "contexto.uso", sesionId: s.id, tokens: c.despues, ...(proveedor.ventanaContexto ? { ventana: proveedor.ventanaContexto } : {}) });
    return `He compactado la conversación (${c.metodo}): unos ${miles(c.antes)} → ${miles(c.despues)} tokens.`;
  }

  /**
   * Contesta sin el modelo, como si fuera un turno: anota el mensaje, deja la sesión ocupada mientras `trabajo`
   * corre (se puede parar con prompt.parar) y acaba con su respuesta y `turno.fin`.
   */
  private responder(s: Sesion, texto: string, trabajo: (senal: AbortSignal) => Promise<string>): void {
    if (s.turno) throw new Error("La sesión ya está trabajando");
    const usuario: Mensaje = { rol: "usuario", texto };
    s.mensajes.push(usuario);
    this.e.sesiones.anotar(s, usuario);
    const control = new AbortController();
    s.turno = control;
    this.e.avisar(s);
    const uso = { entrada: 0, salida: 0 };
    const terminar = (fin: Evento) => {
      if (s.turno === control) s.turno = undefined;
      this.e.emitir(fin);
      this.e.avisar(s);
    };
    trabajo(control.signal).then(
      (respuesta) => {
        if (control.signal.aborted) return terminar({ tipo: "turno.fin", sesionId: s.id, motivo: "parado", texto: "", uso });
        this.e.emitir({ tipo: "mensaje.delta", sesionId: s.id, texto: respuesta });
        const asistente: Mensaje = { rol: "asistente", texto: respuesta, llamadas: [] };
        s.mensajes.push(asistente);
        this.e.sesiones.anotar(s, asistente);
        terminar({ tipo: "turno.fin", sesionId: s.id, motivo: "fin", texto: respuesta, uso });
      },
      (err) => {
        if (err instanceof ErrorAbortado || control.signal.aborted) return terminar({ tipo: "turno.fin", sesionId: s.id, motivo: "parado", texto: "", uso });
        terminar({ tipo: "turno.fin", sesionId: s.id, motivo: "error", texto: "", uso, error: err instanceof Error ? err.message : String(err) });
      },
    );
  }
}

/** La respuesta de `/aprender` sin fuente. */
function textoRevision(r: ResultadoRevision): string {
  if (r.estado === "omitida") return `No he revisado nada: ${r.motivo}.`;
  if (r.estado === "error") return `La revisión falló: ${r.error}`;
  return [
    r.aplicadas ? `He guardado ${r.aplicadas} ${r.aplicadas === 1 ? "cambio" : "cambios"}.` : "",
    r.propuestas ? `Hay ${r.propuestas} ${r.propuestas === 1 ? "propuesta" : "propuestas"} esperando en Memoria → Propuestas.` : "",
    r.texto.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function miles(n: number): string {
  return Math.round(n).toLocaleString("es-ES", { useGrouping: "always" });
}

function recortar(texto: string, max: number): string {
  return texto.length > max ? `${texto.slice(0, max - 1).trimEnd()}…` : texto;
}
