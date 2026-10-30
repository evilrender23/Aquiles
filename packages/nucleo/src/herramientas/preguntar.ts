import { z } from "zod";
import { definir } from "./herramienta";

export const preguntar = definir({
  nombre: "preguntar",
  descripcion:
    "Hace una pregunta al usuario y espera su respuesta. Úsala solo cuando necesites una decisión o un dato que no puedes averiguar " +
    "con las demás herramientas; no la uses para pedir permiso (eso ya lo gestiona el sistema). " +
    "Con 'opciones' (2–6) el usuario elige una; con multiple: true puede elegir varias (llegan separadas por comas).",
  nivel: "lectura",
  parametros: z.object({
    pregunta: z.string().min(1).describe("Pregunta breve y concreta"),
    opciones: z.array(z.string().min(1)).min(2).max(6).optional().describe("Respuestas posibles"),
    multiple: z.boolean().optional().describe("Permite elegir varias opciones"),
  }),
  resumen: ({ pregunta }) => pregunta,
  async ejecutar({ pregunta, opciones, multiple }, ctx) {
    const respuesta = await ctx.preguntar({
      texto: pregunta,
      ...(opciones ? { opciones } : {}),
      ...(opciones && multiple ? { multiple: true } : {}),
    });
    return respuesta.trim() ? `El usuario respondió: ${respuesta.trim()}` : "El usuario no respondió nada.";
  },
});
