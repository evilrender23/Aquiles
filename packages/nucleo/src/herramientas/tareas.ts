import { z } from "zod";
import { definir, type Tarea } from "./herramienta";

export const CLAVE_TAREAS = "tareas";

const MARCAS: Record<Tarea["estado"], string> = { hecha: "[x]", "en-curso": "[>]", pendiente: "[ ]" };

export const tareas = definir({
  nombre: "tareas",
  descripcion:
    "Muestra al usuario la lista de tareas de un trabajo de varios pasos. Envía siempre la lista entera (sustituye a la anterior) " +
    "y actualízala al empezar y al terminar cada paso, con una sola tarea en-curso. No hace falta en peticiones de un paso.",
  nivel: "lectura",
  parametros: z.object({
    tareas: z
      .array(
        z.object({
          texto: z.string().min(1).describe("Qué hay que hacer, en pocas palabras"),
          estado: z.enum(["pendiente", "en-curso", "hecha"]),
        }),
      )
      .describe("Lista completa de tareas"),
  }),
  resumen: ({ tareas: t }) => `${t.filter((x) => x.estado === "hecha").length}/${t.length} hechas`,
  async ejecutar({ tareas: lista }, ctx) {
    const copia: Tarea[] = lista.map((t) => ({ texto: t.texto, estado: t.estado }));
    ctx.estado.set(CLAVE_TAREAS, copia);
    ctx.notificar({ tipo: "tareas", tareas: copia });
    if (copia.length === 0) return "Lista de tareas vacía.";
    return copia.map((t) => `${MARCAS[t.estado]} ${t.texto}`).join("\n");
  },
});
