import { expect, test } from "bun:test";
import { comparar, esSospechosa, porTarea, resumir, type ResultadoTarea } from "./analisis";

const r = (id: string, ok: boolean, o: Partial<ResultadoTarea> = {}): ResultadoTarea => ({
  id, ok, fin: "fin", segundos: 10, llamadas: 5, tokens: { entrada: 900, salida: 100, razonamiento: 0, total: 1000 }, ...o,
});

test("sospechosa: termina en fin sin ninguna llamada a herramientas", () => {
  expect(esSospechosa(r("a", false, { llamadas: 0 }))).toBe(true);
  expect(esSospechosa(r("a", false, { llamadas: 0, fin: "error" }))).toBe(false);
  expect(esSospechosa(r("a", true))).toBe(false);
});

test("porTarea y resumir: repeticiones juntas, media y dispersión, coste por aprobada", () => {
  const rs = [
    r("01", true, { repeticion: 1, segundos: 10 }),
    r("02", false, { repeticion: 1 }),
    r("01", true, { repeticion: 2, segundos: 20 }),
    r("02", true, { repeticion: 2 }),
  ];
  expect(porTarea(rs)).toEqual([
    { id: "01", repeticiones: 2, aprobadas: 2, tasa: 1, tokensMedia: 1000, segundosMedia: 15, segundosDesv: 5, sospechosas: 0 },
    { id: "02", repeticiones: 2, aprobadas: 1, tasa: 0.5, tokensMedia: 1000, segundosMedia: 10, segundosDesv: 0, sospechosas: 0 },
  ]);
  expect(resumir(rs)).toEqual({ aprobadasMedia: 1.5, aprobadasDesv: 0.5, tareas: 2, repeticiones: 2, sospechosas: 0, probablementeRota: false, tokensPorAprobada: 1333 });
});

test("más de la mitad sin herramientas: la ejecución probablemente está rota (los JSON antiguos, sin repetición, también valen)", () => {
  const rota = [r("01", false, { llamadas: 0 }), r("02", false, { llamadas: 0 }), r("03", true)];
  expect(resumir(rota)).toMatchObject({ sospechosas: 2, probablementeRota: true, repeticiones: 1, tokensPorAprobada: 3000 });
  expect(resumir([r("01", false)]).tokensPorAprobada).toBeNull();
});

test("comparar: mejora, empeora, igual, nueva y quitada", () => {
  const a = [r("01", false), r("02", true), r("03", true), r("04", true)];
  const b = [r("01", true, { tokens: { entrada: 0, salida: 0, razonamiento: 0, total: 1500 } }), r("02", false), r("03", true), r("05", true)];
  expect(comparar(a, b).map((c) => [c.id, c.cambio])).toEqual([
    ["01", "mejora"],
    ["02", "empeora"],
    ["03", "igual"],
    ["04", "quitada"],
    ["05", "nueva"],
  ]);
  expect(comparar(a, b)[0]).toMatchObject({ a: 0, b: 1, tokensA: 1000, tokensB: 1500 });
});
