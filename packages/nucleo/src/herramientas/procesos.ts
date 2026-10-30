import { z } from "zod";
import { definir, ErrorHerramienta } from "./herramienta";
import { estadoTerminal, type ProcesoFondo } from "./shell";

export const procesos = definir({
  nombre: "procesos",
  descripcion:
    "Gestiona los procesos que lanzó terminal con segundo_plano en esta sesión: " +
    "'listar' muestra id, estado y comando; 'salida' devuelve lo que ha escrito desde la última consulta; 'parar' lo mata con sus hijos.",
  nivel: "lectura",
  parametros: z.object({
    accion: z.enum(["listar", "salida", "parar"]),
    id: z.string().min(1).optional().describe("Id (p1, p2…) o nombre del proceso; obligatorio para 'salida' y 'parar'"),
  }),
  resumen: ({ accion, id }) => (id ? `${accion} ${id}` : accion),
  async ejecutar({ accion, id }, ctx) {
    const estado = estadoTerminal(ctx.estado);
    if (accion === "listar") {
      if (estado.procesos.size === 0) return "No hay procesos en segundo plano en esta sesión.";
      return [...estado.procesos.values()].map((p) => `${p.id}${p.nombre ? ` (${p.nombre})` : ""} [${situacion(p)}] ${p.comando}`).join("\n");
    }

    if (!id) throw new ErrorHerramienta(`Falta 'id' para ${accion}; usa accion "listar" para ver los procesos.`);
    const p = estado.buscar(id);
    if (!p) {
      const ids = [...estado.procesos.keys()];
      throw new ErrorHerramienta(`No hay ningún proceso "${id}" en esta sesión${ids.length ? ` (hay: ${ids.join(", ")})` : ""}.`);
    }

    if (accion === "salida") {
      const nueva = p.nueva().replace(/\n+$/, "");
      return `${nueva || "(sin salida nueva)"}\n[${p.id}: ${situacion(p)}]`;
    }

    if (!p.enMarcha) return `${p.id} ya había terminado (${situacion(p)}).`;
    await p.parar();
    const resto = p.nueva().replace(/\n+$/, "");
    return `${resto ? `${resto}\n` : ""}[${p.id} parado]`;
  },
});

function situacion(p: ProcesoFondo): string {
  const segundos = Math.round(((p.fin ?? Date.now()) - p.inicio) / 1000);
  if (p.enMarcha) return `en marcha desde hace ${segundos} s`;
  if (p.parado) return `parado tras ${segundos} s`;
  return `terminó con código ${p.codigo ?? "?"} tras ${segundos} s`;
}
