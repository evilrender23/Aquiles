import type { Proveedor } from "../tipos";
import { ProveedorAgy } from "./agy";
import { ProveedorAnthropic } from "./anthropic";
import { presetsOpenAI, proveedorDePreset, type NombrePresetOpenAI } from "./openai-compatible";
import { guionDemo, ProveedorSimulado } from "./simulado";

export interface OpcionesProveedor {
  modelo?: string;
}

export const PROVEEDORES = ["agy", "anthropic", ...(Object.keys(presetsOpenAI) as NombrePresetOpenAI[]), "simulado"] as const;

/** Crea un proveedor por nombre (CLI, servidor y banco de tareas). */
export function crearProveedor(nombre: string, opciones: OpcionesProveedor = {}): Proveedor {
  if (nombre === "agy") return new ProveedorAgy({ modelo: opciones.modelo });
  if (nombre === "anthropic") return new ProveedorAnthropic({ modelo: opciones.modelo });
  if (nombre === "simulado") return new ProveedorSimulado(guionDemo(), 15);
  if (nombre in presetsOpenAI) {
    if (!opciones.modelo) throw new Error(`Con ${nombre} hay que indicar el modelo (--modelo)`);
    return proveedorDePreset(nombre as NombrePresetOpenAI, { modelo: opciones.modelo });
  }
  throw new Error(`Proveedor desconocido: ${nombre} (disponibles: ${PROVEEDORES.join(", ")})`);
}
