/**
 * Ejecución sin interfaz: un único turno que aprueba todas las herramientas y responde
 * a las preguntas con "decide tú". Para el banco de tareas y, más adelante, las automatizaciones.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evento, MotivoFin, Uso } from "@aquiles/protocolo";
import { ejecutarTurno, type EntornoTurno } from "./bucle";
import type { Herramienta } from "./herramientas/herramienta";
import { cerrarEstadoSesion, herramientasPorDefecto } from "./herramientas/index";
import { sistemaBase } from "./sesiones";
import type { Mensaje, Proveedor } from "./tipos";

export interface OpcionesTarea {
  proveedor: Proveedor;
  cwd: string;
  prompt: string;
  maxIteraciones?: number;
  /** Por defecto, todas las herramientas del núcleo. */
  herramientas?: readonly Herramienta<any>[];
  alEvento?: (e: Evento) => void;
  senal?: AbortSignal;
}

export interface ResultadoTarea {
  motivo: MotivoFin;
  texto: string;
  uso: Uso;
  error?: string;
  /** Llamadas a herramientas hechas durante el turno. */
  llamadas: number;
  mensajes: Mensaje[];
}

export async function ejecutarTarea(o: OpcionesTarea): Promise<ResultadoTarea> {
  const mensajes: Mensaje[] = [{ rol: "usuario", texto: o.prompt }];
  const sesionId = `tarea-${crypto.randomUUID()}`;
  const entorno: EntornoTurno = {
    lecturas: new Map(), estado: new Map(), permitidos: new Set(), modoAprobacion: "libre-proyecto", steer: [],
  };
  const salidas = join(tmpdir(), "aquiles-salidas", sesionId);
  let llamadas = 0;
  try {
    const r = await ejecutarTurno({
      sesionId,
      cwd: o.cwd,
      sistema: sistemaBase(o.cwd),
      mensajes,
      proveedor: o.proveedor,
      herramientas: o.herramientas ?? herramientasPorDefecto(),
      senal: o.senal ?? new AbortController().signal,
      maxIteraciones: o.maxIteraciones,
      entorno,
      aprobar: async () => "permitir",
      preguntar: async () => "No hay nadie para responder: decide tú con tu mejor criterio y sigue.",
      async guardarSalida(id, texto) {
        await mkdir(salidas, { recursive: true });
        const ruta = join(salidas, `${id.replace(/[^\w-]/g, "_")}.txt`);
        await writeFile(ruta, texto);
        return ruta;
      },
      emitir(e) {
        if (e.tipo === "herramienta.inicio") llamadas += 1;
        o.alEvento?.(e);
      },
    });
    return { ...r, llamadas, mensajes };
  } finally {
    await cerrarEstadoSesion(entorno.estado);
    await o.proveedor.cerrar?.(sesionId);
  }
}
