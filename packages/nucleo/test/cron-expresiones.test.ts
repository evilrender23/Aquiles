import { expect, test } from "bun:test";
import { ErrorCron, interpretar, proximas } from "../src/cron-expresiones";

/** Jueves 29 de octubre de 2026, 10:00 (hora local). */
const AHORA = new Date(2026, 9, 29, 10, 0);
const local = (a: number, mes: number, dia: number, h = 0, m = 0) => new Date(a, mes - 1, dia, h, m);

function siguiente(cuando: string, ahora = AHORA): Date | undefined {
  return interpretar(cuando, ahora).siguiente(ahora);
}

test("una vez, relativas: en 30m, 2h, 1d, 45 minutos, 2 horas", () => {
  expect(siguiente("en 30m")).toEqual(local(2026, 10, 29, 10, 30));
  expect(siguiente("en 2h")).toEqual(local(2026, 10, 29, 12, 0));
  expect(siguiente("en 1d")).toEqual(local(2026, 10, 30, 10, 0));
  expect(siguiente("en 45 minutos")).toEqual(local(2026, 10, 29, 10, 45));
  expect(siguiente("En 2 Horas")).toEqual(local(2026, 10, 29, 12, 0));
  const e = interpretar("en 30m", AHORA);
  expect(e.repite).toBe(false);
  expect(e.descripcion).toBe("una vez, el 29 de octubre a las 10:30");
  // Ya ejecutada: no hay siguiente.
  expect(e.siguiente(local(2026, 10, 29, 10, 30))).toBeUndefined();
});

test("una vez, con hora: hoy, mañana (con y sin tilde), fecha completa", () => {
  expect(siguiente("hoy 18:00")).toEqual(local(2026, 10, 29, 18, 0));
  expect(siguiente("hoy a las 18")).toEqual(local(2026, 10, 29, 18, 0));
  expect(siguiente("mañana 9:00")).toEqual(local(2026, 10, 30, 9, 0));
  expect(siguiente("MANANA A LAS 9")).toEqual(local(2026, 10, 30, 9, 0));
  expect(siguiente("pasado mañana a las 7:15")).toEqual(local(2026, 10, 31, 7, 15));
  expect(siguiente("2026-11-02 10:00")).toEqual(local(2026, 11, 2, 10, 0));
  expect(interpretar("2027-01-05 08:30", AHORA).descripcion).toBe("una vez, el 5 de enero de 2027 a las 8:30");
});

test("una vez: cambio de mes y de año", () => {
  const nochevieja = local(2026, 12, 31, 23, 50);
  expect(siguiente("en 30m", nochevieja)).toEqual(local(2027, 1, 1, 0, 20));
  expect(siguiente("mañana 9:00", nochevieja)).toEqual(local(2027, 1, 1, 9, 0));
  expect(siguiente("mañana a la 1", local(2026, 10, 31, 12))).toEqual(local(2026, 11, 1, 1, 0));
});

test("una vez ya pasada o fecha que no existe: error claro", () => {
  expect(() => interpretar("hoy 9:00", AHORA)).toThrow("ya ha pasado");
  expect(() => interpretar("2025-01-01 10:00", AHORA)).toThrow("ya ha pasado");
  expect(() => interpretar("2026-02-30 10:00", AHORA)).toThrow("no existe");
  expect(() => interpretar("mañana 25:00", AHORA)).toThrow("La hora 25:00 no existe");
});

test("intervalos: cada 15m, cada 2h, cada hora", () => {
  const cada15 = interpretar("cada 15m", AHORA);
  expect(cada15.repite).toBe(true);
  expect(cada15.descripcion).toBe("cada 15 minutos");
  expect(cada15.siguiente(AHORA)).toEqual(local(2026, 10, 29, 10, 15));
  expect(interpretar("cada 2h", AHORA).descripcion).toBe("cada 2 horas");
  expect(interpretar("cada 2 horas", AHORA).siguiente(AHORA)).toEqual(local(2026, 10, 29, 12, 0));
  const hora = interpretar("cada hora", AHORA);
  expect(hora.descripcion).toBe("cada hora");
  expect(proximas(hora, AHORA, 3)).toEqual([local(2026, 10, 29, 11), local(2026, 10, 29, 12), local(2026, 10, 29, 13)]);
  expect(() => interpretar("cada 0m", AHORA)).toThrow(ErrorCron);
});

test("cada día y todos los días", () => {
  const e = interpretar("cada día 9:00", AHORA);
  expect(e.descripcion).toBe("cada día a las 9:00");
  expect(e.siguiente(AHORA)).toEqual(local(2026, 10, 30, 9, 0));
  expect(interpretar("todos los dias a las 9:00", AHORA).siguiente(AHORA)).toEqual(local(2026, 10, 30, 9, 0));
  expect(interpretar("CADA DÍA 18:30", AHORA).siguiente(AHORA)).toEqual(local(2026, 10, 29, 18, 30));
  // Fin de mes y de año.
  expect(interpretar("cada día 9:00", AHORA).siguiente(local(2026, 12, 31, 10))).toEqual(local(2027, 1, 1, 9, 0));
});

test("días de la semana: uno, dos y varios, con y sin tildes", () => {
  const lunes = interpretar("cada lunes 9:00", AHORA);
  expect(lunes.descripcion).toBe("cada lunes a las 9:00");
  expect(lunes.siguiente(AHORA)).toEqual(local(2026, 11, 2, 9, 0));
  const dos = interpretar("cada lunes y jueves 18:30", AHORA);
  expect(dos.descripcion).toBe("cada lunes y jueves a las 18:30");
  // Hoy es jueves y aún no son las 18:30.
  expect(proximas(dos, AHORA, 3)).toEqual([local(2026, 10, 29, 18, 30), local(2026, 11, 2, 18, 30), local(2026, 11, 5, 18, 30)]);
  expect(interpretar("todos los miércoles a las 7", AHORA).siguiente(AHORA)).toEqual(local(2026, 11, 4, 7, 0));
  expect(interpretar("los sabados y domingos 10:00", AHORA).descripcion).toBe("fines de semana a las 10:00");
  expect(interpretar("cada lunes, miércoles y viernes 9:00", AHORA).descripcion).toBe("cada lunes, miércoles y viernes a las 9:00");
  // Cambio de año: el primer lunes de 2027 es el día 4.
  expect(lunes.siguiente(local(2026, 12, 29))).toEqual(local(2027, 1, 4, 9, 0));
});

test("días laborables", () => {
  const e = interpretar("días laborables 8:00", AHORA);
  expect(e.descripcion).toBe("días laborables a las 8:00");
  // Viernes 30 y luego salta el fin de semana.
  expect(proximas(e, AHORA, 2)).toEqual([local(2026, 10, 30, 8), local(2026, 11, 2, 8)]);
  expect(interpretar("cada día laborable 8:00", AHORA).siguiente(AHORA)).toEqual(local(2026, 10, 30, 8));
});

test("cada mes el día N", () => {
  const e = interpretar("cada mes el día 1 10:00", AHORA);
  expect(e.descripcion).toBe("el día 1 de cada mes a las 10:00");
  expect(e.siguiente(AHORA)).toEqual(local(2026, 11, 1, 10));
  expect(e.siguiente(local(2026, 12, 15))).toEqual(local(2027, 1, 1, 10));
  // El 31 se salta los meses que no lo tienen.
  expect(interpretar("cada mes el dia 31 a las 9", AHORA).siguiente(local(2026, 11, 1))).toEqual(local(2026, 12, 31, 9));
  expect(() => interpretar("cada mes el día 32 10:00", AHORA)).toThrow("no existe");
});

test("cron de 5 campos: *, listas, rangos y pasos", () => {
  expect(interpretar("0 9 * * 1-5", AHORA).descripcion).toBe("días laborables a las 9:00");
  expect(interpretar("0 9 * * 1-5", AHORA).siguiente(AHORA)).toEqual(local(2026, 10, 30, 9));
  const cuarto = interpretar("*/15 * * * *", AHORA);
  expect(cuarto.descripcion).toBe("cron «*/15 * * * *»");
  expect(proximas(cuarto, local(2026, 10, 29, 10, 7), 2)).toEqual([local(2026, 10, 29, 10, 15), local(2026, 10, 29, 10, 30)]);
  expect(proximas(interpretar("30 8,20 * * *", AHORA), AHORA, 2)).toEqual([local(2026, 10, 29, 20, 30), local(2026, 10, 30, 8, 30)]);
  expect(interpretar("0 0 1 1 *", AHORA).siguiente(AHORA)).toEqual(local(2027, 1, 1));
  expect(interpretar("0 12 * 2 0", AHORA).siguiente(AHORA)).toEqual(local(2027, 2, 7, 12)); // primer domingo de febrero
  expect(interpretar("0 12 * * 7", AHORA).siguiente(AHORA)).toEqual(local(2026, 11, 1, 12)); // 7 también es domingo
  expect(interpretar("0-30/10 14 * * *", AHORA).siguiente(local(2026, 10, 29, 14, 5))).toEqual(local(2026, 10, 29, 14, 10));
  // Día del mes y de la semana restringidos: vale cualquiera de los dos (como en cron).
  expect(proximas(interpretar("0 9 13 * 5", AHORA), AHORA, 2)).toEqual([local(2026, 10, 30, 9), local(2026, 11, 6, 9)]);
  expect(interpretar("0 9 13 * 1", AHORA).siguiente(local(2026, 11, 10))).toEqual(local(2026, 11, 13, 9));
  // 29 de febrero: el siguiente es en 2028.
  expect(interpretar("0 0 29 2 *", AHORA).siguiente(AHORA)).toEqual(local(2028, 2, 29));
});

test("cron mal escrito o imposible", () => {
  expect(() => interpretar("60 * * * *", AHORA)).toThrow("se sale de 0–59");
  expect(() => interpretar("0 9 * * 8", AHORA)).toThrow("día de la semana");
  expect(() => interpretar("0 9 5-1 * *", AHORA)).toThrow(ErrorCron);
  expect(() => interpretar("0 0 31 2 *", AHORA)).toThrow("no se cumple nunca");
});

test("lo que no se entiende explica los formatos que valen", () => {
  let error: unknown;
  try {
    interpretar("el viernes que viene", AHORA);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ErrorCron);
  const texto = (error as Error).message;
  expect(texto).toContain("No entiendo «el viernes que viene»");
  for (const ejemplo of ["en 30m", "mañana a las 9", "cada lunes y jueves 18:30", "días laborables 8:00", "0 9 * * 1-5"]) {
    expect(texto).toContain(ejemplo);
  }
});
