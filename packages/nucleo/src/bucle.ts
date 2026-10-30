/**
 * Un turno del agente: llamar al modelo, ejecutar las herramientas que pida,
 * devolverle los resultados y repetir hasta que responda sin pedir ninguna.
 */
import type { Evento, MotivoFin, Uso } from "@aquiles/protocolo";
import { especDe, ErrorHerramienta, type Herramienta } from "./herramientas/herramienta";
import { ErrorAbortado, type LlamadaHerramienta, type Mensaje, type Proveedor } from "./tipos";

const MAX_RESULTADO_EVENTO = 4000;

export interface OpcionesTurno {
  sesionId: string;
  cwd: string;
  sistema: string;
  /** Historial de la sesión; el turno le añade sus mensajes. */
  mensajes: Mensaje[];
  proveedor: Proveedor;
  herramientas: readonly Herramienta<any>[];
  emitir: (evento: Evento) => void;
  senal: AbortSignal;
  maxIteraciones?: number;
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
  let texto = "";

  const fin = (motivo: MotivoFin, error?: string): ResultadoTurno => {
    o.emitir({ tipo: "turno.fin", sesionId: o.sesionId, motivo, texto, uso, ...(error ? { error } : {}) });
    return { motivo, texto, uso, ...(error ? { error } : {}) };
  };

  for (let i = 0; i < (o.maxIteraciones ?? 25); i++) {
    if (o.senal.aborted) return fin("parado");
    let respuesta;
    try {
      respuesta = await o.proveedor.responder(
        { sesionId: o.sesionId, sistema: o.sistema, mensajes: o.mensajes, herramientas: especs, cwd: o.cwd, senal: o.senal },
        (delta) => o.emitir({ tipo: "mensaje.delta", sesionId: o.sesionId, texto: delta }),
      );
    } catch (e) {
      if (e instanceof ErrorAbortado || o.senal.aborted) return fin("parado");
      return fin("error", e instanceof Error ? e.message : String(e));
    }
    if (respuesta.uso) {
      uso.entrada += respuesta.uso.entrada;
      uso.salida += respuesta.uso.salida;
      uso.razonamiento = (uso.razonamiento ?? 0) + (respuesta.uso.razonamiento ?? 0);
    }
    texto = respuesta.texto;
    o.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas });
    if (respuesta.llamadas.length === 0) return fin("fin");

    const soloLectura = respuesta.llamadas.every((l) => porNombre.get(l.nombre)?.nivel === "lectura");
    const resultados = soloLectura
      ? await Promise.all(respuesta.llamadas.map((l) => ejecutarLlamada(l, porNombre, o)))
      : await enSerie(respuesta.llamadas, (l) => ejecutarLlamada(l, porNombre, o));
    o.mensajes.push(...resultados);
  }
  return fin("limite");
}

async function ejecutarLlamada(
  llamada: LlamadaHerramienta,
  porNombre: Map<string, Herramienta<any>>,
  o: OpcionesTurno,
): Promise<Mensaje & { rol: "herramienta" }> {
  o.emitir({ tipo: "herramienta.inicio", sesionId: o.sesionId, id: llamada.id, nombre: llamada.nombre, argumentos: llamada.argumentos });
  const responder = (resultado: string, error: boolean) => {
    o.emitir({
      tipo: "herramienta.fin",
      sesionId: o.sesionId,
      id: llamada.id,
      nombre: llamada.nombre,
      resultado: resultado.length > MAX_RESULTADO_EVENTO ? `${resultado.slice(0, MAX_RESULTADO_EVENTO)}…` : resultado,
      error,
    });
    return { rol: "herramienta" as const, id: llamada.id, nombre: llamada.nombre, resultado, error };
  };

  const h = porNombre.get(llamada.nombre);
  if (!h) return responder(`Herramienta desconocida: ${llamada.nombre}. Disponibles: ${[...porNombre.keys()].join(", ")}`, true);
  const args = h.parametros.safeParse(llamada.argumentos);
  if (!args.success) {
    const problemas = args.error.issues.map((p) => `${p.path.join(".") || "(raíz)"}: ${p.message}`).join("; ");
    return responder(`Argumentos no válidos para ${h.nombre}: ${problemas}`, true);
  }
  try {
    return responder(await h.ejecutar(args.data, { cwd: o.cwd, senal: o.senal }), false);
  } catch (e) {
    if (e instanceof ErrorHerramienta) return responder(e.message, true);
    return responder(`Error interno de ${h.nombre}: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function enSerie<T, R>(elementos: readonly T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const salida: R[] = [];
  for (const x of elementos) salida.push(await f(x));
  return salida;
}
