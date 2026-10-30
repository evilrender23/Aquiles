/**
 * Proveedor de pruebas: responde con un guion fijo, sin red ni coste.
 * Cada paso recibe la petición y devuelve la respuesta; el texto se emite en trozos.
 */
import { ErrorAbortado, type PeticionModelo, type Proveedor, type RespuestaModelo } from "../tipos";

export type PasoSimulado = (p: PeticionModelo) => RespuestaModelo;

export class ProveedorSimulado implements Proveedor {
  readonly nombre = "simulado";
  readonly peticiones: PeticionModelo[] = [];
  private i = 0;

  constructor(private pasos: PasoSimulado[], private retardoMs = 0) {}

  async responder(p: PeticionModelo, alDelta: (texto: string) => void): Promise<RespuestaModelo> {
    this.peticiones.push({ ...p, mensajes: [...p.mensajes] });
    const paso = this.pasos[Math.min(this.i, this.pasos.length - 1)];
    this.i += 1;
    if (!paso) throw new Error("guion vacío");
    const r = paso(p);
    for (const trozo of r.texto.match(/.{1,8}/gs) ?? []) {
      if (p.senal.aborted) throw new ErrorAbortado();
      if (this.retardoMs) await Bun.sleep(this.retardoMs);
      alDelta(trozo);
    }
    if (p.senal.aborted) throw new ErrorAbortado();
    return r;
  }
}

/** Guion de demostración: pide leer el fichero que mencione el usuario y luego lo resume. */
export function guionDemo(): PasoSimulado[] {
  return [
    (p) => {
      const ultimo = [...p.mensajes].reverse().find((m) => m.rol === "usuario");
      const ruta = ultimo?.rol === "usuario" ? (ultimo.texto.match(/[\w./\\-]+\.\w+/)?.[0] ?? "README.md") : "README.md";
      return { texto: `Voy a leer ${ruta}.`, llamadas: [{ id: "sim-1", nombre: "leer", argumentos: { ruta } }] };
    },
    (p) => {
      const r = [...p.mensajes].reverse().find((m) => m.rol === "herramienta");
      const lineas = r?.rol === "herramienta" ? r.resultado.split("\n").length : 0;
      return { texto: `He leído el fichero: tiene ${lineas} líneas.`, llamadas: [] };
    },
  ];
}
