/**
 * Un turno del agente: llamar al modelo, ejecutar las herramientas que pida (con permiso
 * cuando toca), devolverle los resultados y repetir hasta que responda sin pedir ninguna.
 * Entre pasos: mensajes de steer del usuario y compactación del contexto.
 */
import { relative } from "node:path";
import type { Diff, Evento, ModoAprobacion, MotivoFin, Uso } from "@aquiles/protocolo";
import { clavePermiso, decidir } from "./aprobaciones";
import { compactarSiHaceFalta } from "./contexto";
import { calcularDiff } from "./diff";
import {
  especDe,
  ErrorHerramienta,
  type ContextoHerramienta,
  type Herramienta,
  type Huella,
  type Pregunta,
} from "./herramientas/herramienta";
import { ErrorAbortado, ErrorProveedor, type LlamadaHerramienta, type Mensaje, type Proveedor, type RespuestaModelo } from "./tipos";

const MAX_RESULTADO_EVENTO = 4000;
/** Por encima de esto, el resultado completo se guarda aparte y el modelo recibe cabeza y cola. */
const MAX_RESULTADO_MODELO = 20_000;
const MAX_ESPERA_MS = 60_000;

export interface EntornoTurno {
  lecturas: Map<string, Huella>;
  estado: Map<string, unknown>;
  permitidos: Set<string>;
  modoAprobacion: ModoAprobacion;
  /** Cola de mensajes del usuario recibidos mientras el turno trabaja. */
  steer: string[];
}

export interface PeticionAprobacion {
  id: string;
  herramienta: string;
  nivel: string;
  resumen: string;
  argumentos: unknown;
  motivo: string;
}

export type RespuestaAprobacion = "permitir" | "siempre" | "denegar";

export interface OpcionesTurno {
  sesionId: string;
  cwd: string;
  sistema: string;
  /** Historial de la sesión; el turno le añade mensajes (y lo sustituye al compactar). */
  mensajes: Mensaje[];
  proveedor: Proveedor;
  herramientas: readonly Herramienta<any>[];
  emitir: (evento: Evento) => void;
  senal: AbortSignal;
  entorno: EntornoTurno;
  aprobar: (p: PeticionAprobacion) => Promise<RespuestaAprobacion>;
  preguntar: (p: Pregunta) => Promise<string>;
  alAnadir?: (m: Mensaje) => void;
  alCompactar?: (mensajes: Mensaje[]) => void;
  /** Guarda una salida larga y devuelve su ruta. */
  guardarSalida?: (id: string, texto: string) => Promise<string>;
  maxIteraciones?: number;
  reintentos?: number;
  esperaBaseMs?: number;
  proveedorReserva?: Proveedor;
}

export interface ResultadoTurno {
  motivo: MotivoFin;
  texto: string;
  uso: Uso;
  error?: string;
}

export async function ejecutarTurno(o: OpcionesTurno): Promise<ResultadoTurno> {
  const especs = o.herramientas.map((h) => especDe(h));
  const porNombre = new Map(o.herramientas.map((h) => [h.nombre, h]));
  const uso: Uso = { entrada: 0, salida: 0, razonamiento: 0 };
  let proveedor = o.proveedor;
  let tokensReales: number | undefined;
  let texto = "";

  const emitir = o.emitir;
  const anadir = (m: Mensaje) => {
    o.mensajes.push(m);
    o.alAnadir?.(m);
  };
  const fin = (motivo: MotivoFin, error?: string): ResultadoTurno => {
    emitir({ tipo: "turno.fin", sesionId: o.sesionId, motivo, texto, uso, ...(error ? { error } : {}) });
    return { motivo, texto, uso, ...(error ? { error } : {}) };
  };

  const compactar = async (forzar: boolean) => {
    const c = await compactarSiHaceFalta({
      proveedor, sistema: o.sistema, mensajes: o.mensajes, senal: o.senal, sesionId: o.sesionId, tokensReales, forzar,
    });
    if (!c) return;
    o.mensajes.splice(0, o.mensajes.length, ...c.mensajes);
    o.alCompactar?.(o.mensajes);
    tokensReales = undefined;
    emitir({ tipo: "contexto.compactado", sesionId: o.sesionId, metodo: c.metodo, antes: c.antes, despues: c.despues });
  };

  /** Razonamiento de la llamada en curso: se emite según llega y se guarda con la respuesta. */
  let pensamiento = "";
  const llamar = async (): Promise<RespuestaModelo> => {
    pensamiento = "";
    let compactadoPorError = false;
    let reservaUsada = proveedor === o.proveedorReserva;
    for (let intento = 0; ; intento++) {
      try {
        return await proveedor.responder(
          {
            sesionId: o.sesionId, sistema: o.sistema, mensajes: o.mensajes, herramientas: especs, cwd: o.cwd, senal: o.senal,
            alPensamiento: (t) => {
              pensamiento += t;
              emitir({ tipo: "pensamiento.delta", sesionId: o.sesionId, texto: t });
            },
          },
          (delta) => emitir({ tipo: "mensaje.delta", sesionId: o.sesionId, texto: delta }),
        );
      } catch (e) {
        if (e instanceof ErrorAbortado || o.senal.aborted || !(e instanceof ErrorProveedor)) throw e;
        if (e.tipo === "contexto" && !compactadoPorError) {
          compactadoPorError = true;
          await compactar(true);
          continue;
        }
        if (e.reintentable && intento < (o.reintentos ?? 3)) {
          const espera = Math.min(e.detalles.reintentarEnMs ?? (o.esperaBaseMs ?? 1000) * 2 ** intento, MAX_ESPERA_MS);
          emitir({ tipo: "turno.reintento", sesionId: o.sesionId, intento: intento + 1, esperaMs: espera, motivo: e.message });
          await dormir(espera, o.senal);
          continue;
        }
        if (o.proveedorReserva && !reservaUsada) {
          reservaUsada = true;
          proveedor = o.proveedorReserva;
          intento = -1;
          emitir({ tipo: "turno.reintento", sesionId: o.sesionId, intento: 0, esperaMs: 0, motivo: `cambio a ${proveedor.nombre}: ${e.message}` });
          continue;
        }
        throw e;
      }
    }
  };

  for (let i = 0; i < (o.maxIteraciones ?? 25); i++) {
    if (o.senal.aborted) return fin("parado");
    while (o.entorno.steer.length) {
      anadir({ rol: "usuario", texto: `[Mensaje del usuario mientras trabajabas]\n${o.entorno.steer.shift()}` });
    }
    let respuesta: RespuestaModelo;
    try {
      await compactar(false);
      respuesta = await llamar();
    } catch (e) {
      if (e instanceof ErrorAbortado || o.senal.aborted) return fin("parado");
      return fin("error", e instanceof Error ? e.message : String(e));
    }
    if (respuesta.uso) {
      uso.entrada += respuesta.uso.entrada;
      uso.salida += respuesta.uso.salida;
      uso.razonamiento = (uso.razonamiento ?? 0) + (respuesta.uso.razonamiento ?? 0);
      tokensReales = respuesta.uso.entrada;
      emitir({ tipo: "contexto.uso", sesionId: o.sesionId, tokens: tokensReales, ...(proveedor.ventanaContexto ? { ventana: proveedor.ventanaContexto } : {}) });
    }
    texto = respuesta.texto;
    anadir({
      rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, ...(respuesta.opaco ? { opaco: respuesta.opaco } : {}),
      ...(pensamiento.trim() ? { pensamiento: pensamiento.trim() } : {}),
    });
    if (respuesta.llamadas.length === 0) return fin("fin");

    const soloLectura = respuesta.llamadas.every((l) => porNombre.get(l.nombre)?.nivel === "lectura");
    const resultados = soloLectura
      ? await Promise.all(respuesta.llamadas.map((l) => ejecutarLlamada(l, porNombre, o)))
      : await enSerie(respuesta.llamadas, (l) => ejecutarLlamada(l, porNombre, o));
    for (const r of resultados) anadir(r);
  }
  return fin("limite");
}

async function ejecutarLlamada(
  llamada: LlamadaHerramienta,
  porNombre: Map<string, Herramienta<any>>,
  o: OpcionesTurno,
): Promise<Mensaje & { rol: "herramienta" }> {
  const h = porNombre.get(llamada.nombre);
  const args = h?.parametros.safeParse(llamada.argumentos);
  const resumen = h && args?.success ? (h.resumen?.(args.data) ?? "") : "";
  o.emitir({
    tipo: "herramienta.inicio", sesionId: o.sesionId, id: llamada.id, nombre: llamada.nombre, argumentos: llamada.argumentos,
    ...(resumen ? { resumen } : {}),
  });
  const responder = (resultado: string, error: boolean, diffs?: Diff[]) => {
    const conDiffs = diffs?.length ? { diffs } : {};
    o.emitir({
      tipo: "herramienta.fin",
      sesionId: o.sesionId,
      id: llamada.id,
      nombre: llamada.nombre,
      resultado: resultado.length > MAX_RESULTADO_EVENTO ? `${resultado.slice(0, MAX_RESULTADO_EVENTO)}…` : resultado,
      error,
      ...conDiffs,
    });
    return { rol: "herramienta" as const, id: llamada.id, nombre: llamada.nombre, resultado, error, ...(resumen ? { resumen } : {}), ...conDiffs };
  };

  if (!h || !args) return responder(`Herramienta desconocida: ${llamada.nombre}. Disponibles: ${[...porNombre.keys()].join(", ")}`, true);
  if (!args.success) {
    const problemas = args.error.issues.map((p) => `${p.path.join(".") || "(raíz)"}: ${p.message}`).join("; ");
    return responder(`Argumentos no válidos para ${h.nombre}: ${problemas}`, true);
  }

  const decision = decidir(h, args.data, { cwd: o.cwd, modo: o.entorno.modoAprobacion, permitidos: o.entorno.permitidos });
  if (decision.tipo === "preguntar") {
    const r = await o
      .aprobar({ id: llamada.id, herramienta: h.nombre, nivel: h.nivel, resumen, argumentos: args.data, motivo: decision.motivo })
      .catch(() => "denegar" as const);
    if (o.senal.aborted) return responder("Turno parado antes de ejecutar.", true);
    if (r === "denegar") return responder("El usuario no ha permitido esta acción. No la repitas igual: pregúntale o busca otra forma.", true);
    if (r === "siempre") o.entorno.permitidos.add(clavePermiso(h, args.data));
  }

  const ctx: ContextoHerramienta = {
    cwd: o.cwd,
    senal: o.senal,
    sesionId: o.sesionId,
    lecturas: o.entorno.lecturas,
    estado: o.entorno.estado,
    preguntar: o.preguntar,
    notificar: (n) => o.emitir({ tipo: "tareas", sesionId: o.sesionId, tareas: n.tareas }),
    progreso: (t) => o.emitir({ tipo: "herramienta.progreso", sesionId: o.sesionId, id: llamada.id, texto: t }),
  };
  // Foto de los ficheros que va a tocar una herramienta de escritura, para enseñar el diff.
  const rutas = h.nivel === "escritura" ? (h.rutas?.(args.data, o.cwd) ?? []) : [];
  const antes = new Map(await Promise.all(rutas.map(async (r) => [r, await leerTexto(r)] as const)));
  try {
    let resultado = await h.ejecutar(args.data, ctx);
    if (resultado.length > MAX_RESULTADO_MODELO && o.guardarSalida) {
      const ruta = await o.guardarSalida(llamada.id, resultado);
      const omitidos = resultado.length - 12_000;
      resultado = `${resultado.slice(0, 8000)}\n…[${omitidos} caracteres omitidos; salida completa en ${ruta}: léela con leer usando desde/lineas]…\n${resultado.slice(-4000)}`;
    }
    const diffs: Diff[] = [];
    for (const [r, previo] of antes) {
      const despues = await leerTexto(r);
      if (despues !== undefined && despues !== previo) diffs.push(calcularDiff(relative(o.cwd, r) || r, previo, despues));
    }
    return responder(resultado, false, diffs);
  } catch (e) {
    if (e instanceof ErrorHerramienta) return responder(e.message, true);
    if (e instanceof ErrorAbortado || o.senal.aborted) return responder("Turno parado durante la ejecución.", true);
    return responder(`Error interno de ${h.nombre}: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

/** Contenido de texto de un fichero, o undefined si no existe, es grande o binario. */
async function leerTexto(ruta: string): Promise<string | undefined> {
  try {
    const f = Bun.file(ruta);
    if (!(await f.exists()) || f.size > 1024 * 1024) return undefined;
    const bytes = await f.bytes();
    if (bytes.subarray(0, 8192).includes(0)) return undefined;
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

async function enSerie<T, R>(elementos: readonly T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const salida: R[] = [];
  for (const x of elementos) salida.push(await f(x));
  return salida;
}

function dormir(ms: number, senal: AbortSignal): Promise<void> {
  return new Promise((ok, mal) => {
    if (senal.aborted) return mal(new ErrorAbortado());
    const t = setTimeout(ok, ms);
    senal.addEventListener("abort", () => (clearTimeout(t), mal(new ErrorAbortado())), { once: true });
  });
}
