import { expect, test } from "bun:test";
import { preguntar } from "../src/herramientas/preguntar";
import { CLAVE_TAREAS, tareas } from "../src/herramientas/tareas";
import { contextoPrueba } from "./contexto-prueba";

test("tareas sustituye la lista, la guarda, notifica y la renderiza", async () => {
  const ctx = contextoPrueba(".");
  const lista = [
    { texto: "Leer el código", estado: "hecha" as const },
    { texto: "Cambiar editar", estado: "en-curso" as const },
    { texto: "Probar", estado: "pendiente" as const },
  ];
  expect(await tareas.ejecutar({ tareas: lista }, ctx)).toBe("[x] Leer el código\n[>] Cambiar editar\n[ ] Probar");
  expect(ctx.estado.get(CLAVE_TAREAS)).toEqual(lista);
  expect(ctx.notificaciones).toEqual([{ tipo: "tareas", tareas: lista }]);
  expect(tareas.resumen?.({ tareas: lista })).toBe("1/3 hechas");

  expect(await tareas.ejecutar({ tareas: [{ texto: "Probar", estado: "hecha" }] }, ctx)).toBe("[x] Probar");
  expect(ctx.estado.get(CLAVE_TAREAS)).toEqual([{ texto: "Probar", estado: "hecha" }]);
  expect(ctx.notificaciones).toHaveLength(2);
  expect(await tareas.ejecutar({ tareas: [] }, ctx)).toBe("Lista de tareas vacía.");
  expect(tareas.parametros.safeParse({ tareas: [{ texto: "x", estado: "otra" }] }).success).toBe(false);
});

test("preguntar pasa la pregunta y devuelve la respuesta", async () => {
  const ctx = contextoPrueba(".");
  ctx.respuestas.push("PostgreSQL", "a, b", "  ");
  expect(await preguntar.ejecutar({ pregunta: "¿Qué base de datos?" }, ctx)).toBe("El usuario respondió: PostgreSQL");
  expect(await preguntar.ejecutar({ pregunta: "¿Cuáles?", opciones: ["a", "b", "c"], multiple: true }, ctx)).toBe(
    "El usuario respondió: a, b",
  );
  expect(ctx.preguntas).toEqual([{ texto: "¿Qué base de datos?" }, { texto: "¿Cuáles?", opciones: ["a", "b", "c"], multiple: true }]);
  expect(await preguntar.ejecutar({ pregunta: "¿Y?" }, ctx)).toBe("El usuario no respondió nada.");
  expect(preguntar.parametros.safeParse({ pregunta: "x", opciones: ["solo una"] }).success).toBe(false);
  expect(preguntar.parametros.safeParse({ pregunta: "x", opciones: ["1", "2", "3", "4", "5", "6", "7"] }).success).toBe(false);
});
