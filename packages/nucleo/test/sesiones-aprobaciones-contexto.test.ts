import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidir, dentroDe } from "../src/aprobaciones";
import { estimarTokens, podar, puntoDeCorte } from "../src/contexto";
import { definir } from "../src/herramientas/herramienta";
import { AlmacenSesiones, historial, info } from "../src/sesiones";
import type { Mensaje } from "../src/tipos";
import { z } from "zod";

describe("sesiones en disco", () => {
  test("guardar, recargar en otro almacén, compactar y listar", () => {
    const dir = mkdtempSync(join(tmpdir(), "aquiles-ses-"));
    const a = new AlmacenSesiones(dir);
    const s = a.crear("C:/proyecto", "preguntar-siempre");
    const m1: Mensaje = { rol: "usuario", texto: "Arregla el test de fechas por favor" };
    const m2: Mensaje = { rol: "asistente", texto: "", llamadas: [{ id: "h1", nombre: "leer", argumentos: { ruta: "a.ts" } }] };
    s.mensajes.push(m1, m2);
    a.anotar(s, m1);
    a.anotar(s, m2);

    const b = new AlmacenSesiones(dir);
    const r = b.obtener(s.id)!;
    expect(r.mensajes).toEqual([m1, m2]);
    expect(r.modoAprobacion).toBe("preguntar-siempre");
    expect(r.sistema).toBe(s.sistema);
    expect(info(r).titulo).toBe("Arregla el test de fechas por favor");

    r.mensajes = [{ rol: "resumen", texto: "se miró a.ts" }];
    b.anotarCompactacion(r);
    appendFileSync(join(dir, `${s.id}.jsonl`), '{"tipo":"mensaje","mens'); // escritura cortada
    expect(new AlmacenSesiones(dir).obtener(s.id)!.mensajes).toEqual([{ rol: "resumen", texto: "se miró a.ts" }]);
    expect(new AlmacenSesiones(dir).listar().map((x) => x.sesionId)).toEqual([s.id]);
  });

  test("ids raros no salen de la carpeta y el historial recorta resultados", () => {
    const a = new AlmacenSesiones(mkdtempSync(join(tmpdir(), "aquiles-ses-")));
    expect(a.obtener("../../etc")).toBeUndefined();
    const s = a.crear("C:/p");
    s.mensajes.push({ rol: "herramienta", id: "x", nombre: "leer", resultado: "z".repeat(5000), error: false });
    expect(historial(s)[0]).toMatchObject({ rol: "herramienta", nombre: "leer" });
    expect((historial(s)[0] as { resultado: string }).resultado.length).toBe(2000);
  });
});

describe("aprobaciones", () => {
  const escribirFalso = definir({
    nombre: "escribir",
    descripcion: "",
    nivel: "escritura" as const,
    parametros: z.object({ ruta: z.string() }),
    rutas: (a: { ruta: string }, cwd: string) => [join(cwd, a.ruta)],
    ejecutar: async () => "",
  });
  const base = { cwd: "C:\\proyecto", permitidos: new Set<string>() };

  test("por modo", () => {
    expect(decidir(escribirFalso, { ruta: "a.txt" }, { ...base, modo: "preguntar-ejecutar" }).tipo).toBe("permitir");
    expect(decidir(escribirFalso, { ruta: "a.txt" }, { ...base, modo: "preguntar-siempre" }).tipo).toBe("preguntar");
  });

  test("fuera de la carpeta pregunta siempre, incluso en libre-proyecto o con permiso", () => {
    const d = decidir(escribirFalso, { ruta: "..\\otro\\a.txt" }, { cwd: base.cwd, modo: "libre-proyecto", permitidos: new Set(["escribir:*"]) });
    expect(d).toMatchObject({ tipo: "preguntar" });
  });

  test("dentroDe", () => {
    expect(dentroDe("C:\\p\\a\\b.txt", "C:\\p")).toBe(true);
    expect(dentroDe("C:\\p", "C:\\p")).toBe(true);
    expect(dentroDe("C:\\pp\\x", "C:\\p")).toBe(false);
    expect(dentroDe("D:\\p\\x", "C:\\p")).toBe(false);
  });
});

describe("contexto", () => {
  const res = (n: number): Mensaje => ({ rol: "herramienta", id: `h${n}`, nombre: "leer", resultado: "línea\n".repeat(200), error: false });

  test("podar respeta los 6 resultados más recientes", () => {
    const mensajes = Array.from({ length: 10 }, (_, i) => res(i));
    const podados = podar(mensajes);
    expect(podados.slice(0, 4).every((m) => m.rol === "herramienta" && m.resultado.startsWith("[resultado antiguo podado"))).toBe(true);
    expect(podados.slice(4)).toEqual(mensajes.slice(4));
    expect(estimarTokens("", podados)).toBeLessThan(estimarTokens("", mensajes));
  });

  test("el corte nunca separa una llamada de su resultado", () => {
    const m: Mensaje[] = [
      { rol: "usuario", texto: "a" },
      { rol: "asistente", texto: "", llamadas: [{ id: "1", nombre: "leer", argumentos: {} }] },
      res(1),
      res(2),
      { rol: "asistente", texto: "fin", llamadas: [] },
    ];
    expect(puntoDeCorte(m, 2)).toBe(1);
  });
});
