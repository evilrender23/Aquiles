/**
 * Objetivos con juez: una sesión puede tener un objetivo y, al acabar cada turno, un modelo auxiliar sin herramientas
 * mira el final de la conversación y decide si se cumplió. Si no, Aquiles sigue solo con un turno nuevo que le dice
 * qué falta, hasta `maxIntentos` veredictos negativos.
 *
 * Esos turnos de seguimiento se lanzan con el motor sin `aprobar`: lo que pida permiso se deniega aunque el usuario
 * esté delante. Para que avance sin preguntar, la sesión tiene que estar en `libre-proyecto`.
 *
 * Los objetivos viven en memoria del proceso; `exportar`/`cargar` sirven para guardarlos con la sesión.
 */
import type { Evento, MotivoFin, ObjetivoSesion } from "@aquiles/protocolo";
import { transcripcionRevision } from "./aprendizaje";
import type { Motor } from "./motor";
import type { Mensaje, Proveedor } from "./tipos";

export const MAX_INTENTOS_POR_DEFECTO = 5;
/** El juez ve solo el final: los últimos mensajes y, de ellos, como mucho estos caracteres. */
const MENSAJES_JUEZ = 40;
const MAX_TRANSCRIPCION_JUEZ = 24_000;
const ESPERA_JUEZ_MS = 120_000;

const PROMPT_JUEZ = [
  "Eres el juez de objetivos de Aquiles, un agente que trabaja en el ordenador del usuario.",
  "Te llega un objetivo y el final de la conversación en la que Aquiles trabaja para cumplirlo. Decide si ya se cumplió.",
  "- cumplido: lo que pide el objetivo está hecho y hay pruebas en la conversación (resultados de herramientas, tests que",
  "  pasan, ficheros escritos), no solo que Aquiles diga que lo hizo.",
  "- no cumplido: falta algo, hay errores sin resolver o no hay pruebas. En el motivo di en una frase qué falta.",
  "Responde solo con JSON en una línea: {\"cumplido\":true|false,\"motivo\":\"…\"}",
].join("\n");

export interface VeredictoJuez {
  cumplido: boolean;
  motivo: string;
}

export interface OpcionesObjetivos {
  motor: Motor;
  /** Modelo del juez para una sesión (el auxiliar de los ajustes o el de la propia sesión). */
  proveedorJuez: (sesionId: string) => Proveedor;
  emitir: (e: Evento) => void;
  log?: (m: string) => void;
}

export class Objetivos {
  private objetivos = new Map<string, ObjetivoSesion>();
  /** Turnos terminados por sesión: un veredicto que llega tarde (ya acabó otro turno) se descarta. */
  private turnos = new Map<string, number>();

  constructor(private o: OpcionesObjetivos) {}

  /** Fija o cambia el objetivo (empieza de cero); null o texto vacío lo quita. */
  fijar(s: { id: string }, objetivo: string | null, maxIntentos = MAX_INTENTOS_POR_DEFECTO): ObjetivoSesion | undefined {
    const texto = objetivo?.trim();
    if (!texto) {
      this.objetivos.delete(s.id);
      return undefined;
    }
    const nuevo: ObjetivoSesion = { texto, estado: "activo", intentos: 0, maxIntentos };
    this.objetivos.set(s.id, nuevo);
    return { ...nuevo };
  }

  de(sesionId: string): ObjetivoSesion | undefined {
    const ob = this.objetivos.get(sesionId);
    return ob ? { ...ob } : undefined;
  }

  /**
   * Lo llama el servidor al acabar cada turno de la sesión (también los que lanza él mismo), cuando la sesión ya no
   * está trabajando. Con `fin` o `limite` pregunta al juez; `parado` y `error` no cuentan como intento.
   */
  async alTerminarTurno(s: { id: string; cwd: string; mensajes: readonly Mensaje[] }, r: { motivo: MotivoFin; texto: string }): Promise<void> {
    const ob = this.objetivos.get(s.id);
    if (ob?.estado !== "activo" || (r.motivo !== "fin" && r.motivo !== "limite")) return;
    const turno = (this.turnos.get(s.id) ?? 0) + 1;
    this.turnos.set(s.id, turno);
    let veredicto: VeredictoJuez;
    try {
      veredicto = await consultarJuez({ proveedor: this.o.proveedorJuez(s.id), objetivo: ob.texto, cwd: s.cwd, mensajes: s.mensajes, ultimo: r.texto });
    } catch (e) {
      if (!this.vigente(s.id, ob, turno)) return;
      ob.motivo = `El juez falló: ${e instanceof Error ? e.message : String(e)}`;
      this.o.log?.(`objetivo de ${s.id}: ${ob.motivo}`);
      this.avisar(s.id, ob);
      return;
    }
    if (!this.vigente(s.id, ob, turno)) return;
    ob.motivo = veredicto.motivo;
    if (veredicto.cumplido) {
      ob.estado = "cumplido";
    } else {
      ob.intentos += 1;
      if (ob.intentos >= ob.maxIntentos) ob.estado = "agotado";
    }
    this.o.log?.(`objetivo de ${s.id}: ${ob.estado} (${ob.intentos}/${ob.maxIntentos}) ${ob.motivo}`);
    this.avisar(s.id, ob);
    if (ob.estado === "activo") this.seguir(s.id, ob);
  }

  /** Objetivos de todas las sesiones, para guardarlos. */
  exportar(): Record<string, ObjetivoSesion> {
    return Object.fromEntries([...this.objetivos].map(([id, ob]) => [id, { ...ob }]));
  }

  /** Añade (o sustituye) objetivos guardados; lo que no tenga forma de objetivo se ignora. */
  cargar(objetivos: Record<string, unknown>): void {
    for (const [id, x] of Object.entries(objetivos)) {
      const ob = x as Partial<ObjetivoSesion> | null;
      if (typeof ob?.texto !== "string" || !["activo", "cumplido", "agotado"].includes(ob.estado as string)) continue;
      const maxIntentos = typeof ob.maxIntentos === "number" && ob.maxIntentos >= 1 ? ob.maxIntentos : MAX_INTENTOS_POR_DEFECTO;
      this.objetivos.set(id, {
        texto: ob.texto, estado: ob.estado!, intentos: typeof ob.intentos === "number" ? ob.intentos : 0, maxIntentos,
        ...(typeof ob.motivo === "string" ? { motivo: ob.motivo } : {}),
      });
    }
  }

  /** El objetivo sigue siendo el mismo y no ha acabado otro turno mientras el juez pensaba. */
  private vigente(sesionId: string, ob: ObjetivoSesion, turno: number): boolean {
    return this.objetivos.get(sesionId) === ob && this.turnos.get(sesionId) === turno;
  }

  private avisar(sesionId: string, ob: ObjetivoSesion): void {
    this.o.emitir({ tipo: "objetivo.evaluado", sesionId, objetivo: { ...ob } });
  }

  /** Turno de seguimiento en segundo plano; si el usuario ya escribió otra cosa, su turno se juzgará igual. */
  private seguir(sesionId: string, ob: ObjetivoSesion): void {
    if (this.o.motor.trabajando(sesionId)) return;
    const texto = `El objetivo aún no se cumple: ${(ob.motivo ?? "").replace(/[.\s]+$/, "")}. Sigue trabajando hasta cumplirlo: ${ob.texto}`;
    this.o.motor.turno({ sesionId, texto }).catch((e) => this.o.log?.(`objetivo de ${sesionId}: no se pudo seguir (${e instanceof Error ? e.message : e})`));
  }
}

/** Pregunta al juez; lanza si el modelo falla o no responde con el JSON pedido. */
export async function consultarJuez(o: {
  proveedor: Proveedor;
  objetivo: string;
  cwd: string;
  mensajes: readonly Mensaje[];
  /** Respuesta final del turno que se juzga. */
  ultimo: string;
  senal?: AbortSignal;
}): Promise<VeredictoJuez> {
  let conversacion = transcripcionRevision(o.mensajes.slice(-MENSAJES_JUEZ));
  if (conversacion.length > MAX_TRANSCRIPCION_JUEZ) conversacion = `(… principio omitido …)\n${conversacion.slice(-MAX_TRANSCRIPCION_JUEZ)}`;
  const sesionId = `juez-${crypto.randomUUID()}`;
  const tiempo = AbortSignal.timeout(ESPERA_JUEZ_MS);
  try {
    const r = await o.proveedor.responder(
      {
        sesionId,
        sistema: PROMPT_JUEZ,
        mensajes: [
          {
            rol: "usuario",
            texto: `Objetivo:\n${o.objetivo}\n\nCarpeta de trabajo: ${o.cwd}\n\nFinal de la conversación:\n\n${conversacion}\n\nÚltima respuesta de Aquiles:\n${o.ultimo.slice(0, 4000) || "(vacía)"}`,
          },
        ],
        herramientas: [],
        cwd: o.cwd,
        senal: o.senal ? AbortSignal.any([o.senal, tiempo]) : tiempo,
        maxTokensSalida: 300,
      },
      () => {},
    );
    return interpretarVeredicto(r.texto);
  } finally {
    await o.proveedor.cerrar?.(sesionId);
  }
}

export function interpretarVeredicto(texto: string): VeredictoJuez {
  const json = /\{[\s\S]*\}/.exec(texto)?.[0];
  let d: Partial<{ cumplido: unknown; motivo: unknown }>;
  try {
    d = JSON.parse(json ?? "");
  } catch {
    throw new Error(`respuesta del juez no válida: ${texto.slice(0, 200)}`);
  }
  if (typeof d.cumplido !== "boolean") throw new Error(`respuesta del juez sin «cumplido»: ${texto.slice(0, 200)}`);
  return { cumplido: d.cumplido, motivo: String(d.motivo ?? "").trim().slice(0, 500) || (d.cumplido ? "Cumplido" : "Sin motivo") };
}
