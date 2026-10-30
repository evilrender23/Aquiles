import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntradaAprendizaje } from "@aquiles/protocolo";
import { calcularEstadisticas } from "../src/estadisticas";

const hoy = new Date();
/** Fecha ISO de hace `n` días a la hora local `h` (así el test no depende de la zona horaria). */
const haceDias = (n: number, h = 12) => new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - n, h).toISOString();
const dia = (n: number) => {
  const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const json = (x: unknown) => JSON.stringify(x);

function sesiones(ficheros: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "aquiles-estadisticas-"));
  for (const [id, lineas] of Object.entries(ficheros)) writeFileSync(join(dir, `${id}.jsonl`), `${lineas.join("\n")}\n`);
  return dir;
}

const inicio = (n: number, proveedor?: string) =>
  json({ tipo: "inicio", id: "x", cwd: "C:\\p", sistema: "s", creada: haceDias(n, 9), modoAprobacion: "preguntar-ejecutar", ...(proveedor ? { proveedor } : {}) });
const usuario = (n: number, texto = "hola") => json({ tipo: "mensaje", mensaje: { rol: "usuario", texto }, fecha: haceDias(n, 10) });
const asistente = (n: number, ...herramientas: string[]) =>
  json({
    tipo: "mensaje",
    mensaje: { rol: "asistente", texto: "", llamadas: herramientas.map((nombre, i) => ({ id: `l${i}`, nombre, argumentos: {} })) },
    fecha: haceDias(n, 10),
  });
const resultado = (n: number) => json({ tipo: "mensaje", mensaje: { rol: "herramienta", id: "l0", nombre: "leer", resultado: "x", error: false }, fecha: haceDias(n, 10) });
const uso = (n: number, entrada: number, salida: number) => json({ tipo: "uso", uso: { entrada, salida }, motivo: "fin", fecha: haceDias(n, 11) });

test("agrega por día en hora local, con los días vacíos y los rankings", () => {
  const dir = sesiones({
    a: [inicio(0, "claude"), json({ tipo: "turno", fecha: haceDias(0, 10) }), usuario(0), asistente(0, "leer", "leer"), resultado(0), resultado(0), asistente(0), uso(0, 1000, 50)],
    b: [inicio(2, "agy"), usuario(2), asistente(2, "terminal", "leer"), resultado(2), asistente(2), uso(2, 300, 20), usuario(0), asistente(0, "terminal"), uso(0, 10, 1)],
    c: [inicio(2, "agy"), usuario(2)],
    // Creada antes del periodo: su actividad de ayer cuenta, la sesión no.
    vieja: [inicio(40, "agy"), usuario(40), asistente(40, "escribir"), usuario(1), asistente(1, "editar")],
  });
  const historial: EntradaAprendizaje[] = [
    { id: "h1", fecha: haceDias(0, 8), origen: { tipo: "revision", sesionId: "a" }, tipo: "memoria", resumen: "Prefiere tabs" },
    { id: "h2", fecha: haceDias(3), origen: { tipo: "sesion" }, tipo: "skill", resumen: "Skill nueva «tests»" },
    { id: "h3", fecha: haceDias(20), origen: { tipo: "manual" }, tipo: "memoria", resumen: "fuera del periodo" },
  ];
  const e = calcularEstadisticas({
    dirSesiones: dir, historial, dias: 7, ahora: hoy,
    registroSkills: { tests: { usos: 4 }, git: { usos: 9 }, nunca: { usos: 0 }, rara: {} },
  });

  expect(e.dias).toBe(7);
  expect(e.porDia.map((d) => d.dia)).toEqual([6, 5, 4, 3, 2, 1, 0].map(dia));
  const de = (n: number) => e.porDia.find((d) => d.dia === dia(n))!;
  expect(de(0)).toEqual({ dia: dia(0), sesiones: 1, mensajes: 5, herramientas: 3, tokensEntrada: 1010, tokensSalida: 51, aprendido: 1 });
  expect(de(1)).toMatchObject({ sesiones: 0, mensajes: 2, herramientas: 1 });
  expect(de(2)).toEqual({ dia: dia(2), sesiones: 2, mensajes: 4, herramientas: 2, tokensEntrada: 300, tokensSalida: 20, aprendido: 0 });
  expect(de(3)).toMatchObject({ aprendido: 1, mensajes: 0 });
  expect(de(6)).toEqual({ dia: dia(6), sesiones: 0, mensajes: 0, herramientas: 0, tokensEntrada: 0, tokensSalida: 0, aprendido: 0 });

  expect(e.herramientas).toEqual([
    { nombre: "leer", usos: 3 },
    { nombre: "terminal", usos: 2 },
    { nombre: "editar", usos: 1 },
  ]);
  expect(e.proveedores).toEqual([
    { proveedor: "agy", sesiones: 2 },
    { proveedor: "claude", sesiones: 1 },
  ]);
  expect(e.skills).toEqual([
    { nombre: "git", usos: 9 },
    { nombre: "tests", usos: 4 },
  ]);
  expect(e.aprendido.map((x) => x.id)).toEqual(["h1", "h2"]);
});

test("aguanta líneas rotas, sesiones antiguas sin fecha y carpetas que no existen", () => {
  const dir = sesiones({
    rota: [inicio(1), "{ esto no es json", "null", "[1,2]", json({ tipo: "mensaje" }), json({ tipo: "mensaje", mensaje: { rol: "asistente", llamadas: [null, { nombre: 3 }, { nombre: "leer" }] }, fecha: "no es fecha" }), '{"tipo":"uso","uso":{"entrada":"mucho"}'],
    // Sin `fecha` en los mensajes ni proveedor (versiones antiguas): cuentan el día de creación.
    antigua: [inicio(3), json({ tipo: "mensaje", mensaje: { rol: "usuario", texto: "hola" } }), json({ tipo: "mensaje", mensaje: { rol: "asistente", texto: "", llamadas: [{ id: "1", nombre: "leer", argumentos: {} }] } })],
  });
  writeFileSync(join(dir, "notas.txt"), "no es una sesión");
  const e = calcularEstadisticas({ dirSesiones: dir, historial: [], dias: 5, ahora: hoy });
  const de = (n: number) => e.porDia.find((d) => d.dia === dia(n))!;
  expect(de(3)).toMatchObject({ sesiones: 1, mensajes: 2, herramientas: 1 });
  // El mensaje con fecha inválida no tiene día; la sesión rota sí cuenta.
  expect(de(1)).toMatchObject({ sesiones: 1, mensajes: 0, tokensEntrada: 0 });
  expect(e.proveedores).toEqual([{ proveedor: "desconocido", sesiones: 2 }]);
  expect(e.skills).toEqual([]);

  expect(calcularEstadisticas({ dirSesiones: join(dir, "no-existe"), historial: [] }).porDia).toHaveLength(30);
  expect(calcularEstadisticas({ dirSesiones: null, historial: [], dias: 1 }).porDia).toHaveLength(1);
});

test("no abre los ficheros que no se tocan desde antes del periodo", () => {
  const dir = sesiones({ quieta: [inicio(1), usuario(1)] });
  const hace60 = new Date(hoy.getTime() - 60 * 86_400_000);
  utimesSync(join(dir, "quieta.jsonl"), hace60, hace60);
  const e = calcularEstadisticas({ dirSesiones: dir, historial: [], dias: 7, ahora: hoy });
  expect(e.porDia.reduce((n, d) => n + d.mensajes + d.sesiones, 0)).toBe(0);
});
