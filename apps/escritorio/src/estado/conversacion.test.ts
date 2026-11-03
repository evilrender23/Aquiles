import { expect, test } from "bun:test";
import { aplicarEvento, conversacionVacia, desdeHistorial, type EventoSesion } from "./conversacion";
import type { Conversacion } from "./tipos";

const S = "s1";
/** Aplica una serie de eventos a una conversación que está trabajando. */
function tras(eventos: EventoSesion[], inicio: Conversacion = { ...conversacionVacia(), trabajando: true }): Conversacion {
  return eventos.reduce((c, e, i) => aplicarEvento(c, e, 1000 + i * 100), inicio);
}
const tipos = (c: Conversacion) => c.elementos.map((e) => e.tipo);

test("el texto que llega en trozos va a la misma respuesta; una herramienta la cierra", () => {
  const c = tras([
    { tipo: "mensaje.delta", sesionId: S, texto: "Ho" },
    { tipo: "mensaje.delta", sesionId: S, texto: "la" },
    { tipo: "herramienta.inicio", sesionId: S, id: "h1", nombre: "leer", argumentos: { ruta: "a.ts" } },
    { tipo: "mensaje.delta", sesionId: S, texto: "Listo" },
  ]);
  expect(tipos(c)).toEqual(["asistente", "herramienta", "asistente"]);
  expect(c.elementos[0]).toMatchObject({ texto: "Hola", abierto: false });
  expect(c.elementos[1]).toMatchObject({ nombre: "leer", resumen: "a.ts", estado: "en-curso" });
});

test("herramienta: progreso, fin con su duración, y en curso al acabar el turno pasa a fallo", () => {
  const c = tras([
    { tipo: "herramienta.inicio", sesionId: S, id: "h1", nombre: "terminal", argumentos: { comando: "ls" } },
    { tipo: "herramienta.progreso", sesionId: S, id: "h1", texto: "a\n" },
    { tipo: "herramienta.fin", sesionId: S, id: "h1", nombre: "terminal", resultado: "a\n[código de salida 0]", error: false },
    { tipo: "herramienta.inicio", sesionId: S, id: "h2", nombre: "terminal", argumentos: { comando: "sleep 9" } },
    { tipo: "turno.fin", sesionId: S, motivo: "parado", texto: "" },
  ] as EventoSesion[]);
  expect(c.elementos[0]).toMatchObject({ estado: "ok", salida: "a\n[código de salida 0]", ms: 200 });
  expect(c.elementos[1]).toMatchObject({ estado: "fallo" });
  expect(c.elementos.at(-1)).toMatchObject({ tipo: "aviso", texto: "Detenido" });
  expect(c.trabajando).toBe(false);
});

test("límite de pasos y error dejan un aviso que se entiende", () => {
  expect(tras([{ tipo: "turno.fin", sesionId: S, motivo: "limite", texto: "" }]).elementos.at(-1)).toMatchObject({
    tipo: "aviso", texto: expect.stringContaining("Ajustes → General"),
  });
  expect(tras([{ tipo: "turno.fin", sesionId: S, motivo: "error", texto: "", error: "sin cuota" }]).elementos.at(-1)).toMatchObject({
    tipo: "aviso", nivel: "error", texto: "sin cuota",
  });
});

test("compactar: aviso con los tokens y, si se resumió, el resumen ya visible", () => {
  const c = tras([{ tipo: "contexto.compactado", sesionId: S, metodo: "resumen", antes: 120_000, despues: 30_000, resumen: "## Pendiente\n- tests" }]);
  expect(tipos(c)).toEqual(["aviso", "resumen"]);
  expect(c.elementos[0]).toMatchObject({ texto: "Contexto compactado (resumen): 120k → 30k tokens" });
  expect(c.elementos[1]).toMatchObject({ texto: "## Pendiente\n- tests" });
  expect(tipos(tras([{ tipo: "contexto.compactado", sesionId: S, metodo: "poda", antes: 90_000, despues: 60_000 }]))).toEqual(["aviso"]);
});

test("JSON mal escrito por el modelo: el resumen saca el comando, sin las comillas escapadas", () => {
  const c = tras([
    { tipo: "herramienta.inicio", sesionId: S, id: "h1", nombre: "terminal", argumentos: { __json_invalido: '{"comando":"cat << \'EOF\'\\nhola\\nEOF", "x": }' } },
  ]);
  expect(c.elementos[0]).toMatchObject({ resumen: "cat << 'EOF'\nhola\nEOF" });
});

test("desde el historial: herramientas, resumen, adjuntos y el pensamiento antes de su respuesta", () => {
  const e = desdeHistorial([
    { rol: "usuario", texto: "mira esto", adjuntos: [{ id: "a1", nombre: "foto.png", tipo: "image/png", bytes: 10, clase: "imagen" }] },
    { rol: "asistente", texto: "Veo una foto", llamadas: [], pensamiento: "Es un png" },
    { rol: "herramienta", id: "h1", nombre: "leer", resultado: "x", error: true, resumen: "b.ts" },
    { rol: "resumen", texto: "antes pasó algo" },
  ] as never);
  expect(e.map((x) => x.tipo)).toEqual(["usuario", "pensamiento", "asistente", "herramienta", "resumen"]);
  expect(e[0]).toMatchObject({ adjuntos: [{ nombre: "foto.png", clase: "imagen" }] });
  expect(e[3]).toMatchObject({ estado: "fallo", resumen: "b.ts" });
});
