import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claveRuta } from "../src/herramientas/ficheros";
import { ErrorHerramienta } from "../src/herramientas/herramienta";
import { leer } from "../src/herramientas/leer";
import { carpetaTemporal, contextoPrueba } from "./contexto-prueba";

let dir = "";
let borrar = async () => {};
const ctx = () => contextoPrueba(dir);

beforeAll(async () => {
  ({ dir, borrar } = await carpetaTemporal("leer"));
  await writeFile(join(dir, "a.txt"), "uno\r\ndos\ntres\n");
  await writeFile(join(dir, "largo.txt"), Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n"));
  await writeFile(join(dir, "bin.dat"), new Uint8Array([1, 0, 2]));
});
afterAll(() => borrar());

test("numera las líneas y normaliza CRLF", async () => {
  expect(await leer.ejecutar({ ruta: "a.txt" }, ctx())).toBe("1\tuno\n2\tdos\n3\ttres");
});

test("lee un rango y dice cómo seguir", async () => {
  const r = await leer.ejecutar({ ruta: "largo.txt", desde: 5, lineas: 3 }, ctx());
  expect(r).toBe("5\tl5\n6\tl6\n7\tl7\n[líneas 5-7 de 30; sigue con desde=8]");
});

test("registra la huella del fichero leído", async () => {
  const c = ctx();
  await leer.ejecutar({ ruta: "largo.txt", desde: 2, lineas: 1 }, c);
  const huella = c.lecturas.get(claveRuta(join(dir, "largo.txt")));
  expect(huella?.tamano).toBeGreaterThan(0);
  expect(huella?.hash).toMatch(/^[0-9a-f]+$/);
  if (process.platform === "win32") expect(c.lecturas.has(claveRuta(join(dir, "LARGO.TXT")))).toBe(true);
});

test("errores esperables son ErrorHerramienta", async () => {
  await expect(leer.ejecutar({ ruta: "no-existe.txt" }, ctx())).rejects.toBeInstanceOf(ErrorHerramienta);
  await expect(leer.ejecutar({ ruta: "bin.dat" }, ctx())).rejects.toThrow("binario");
  await expect(leer.ejecutar({ ruta: "." }, ctx())).rejects.toThrow("carpeta");
  await expect(leer.ejecutar({ ruta: "a.txt", desde: 10 }, ctx())).rejects.toThrow("se pasa");
});

test("el esquema rechaza argumentos malos", () => {
  expect(leer.parametros.safeParse({ ruta: "" }).success).toBe(false);
  expect(leer.parametros.safeParse({ ruta: "a", desde: 0 }).success).toBe(false);
});

test("resumen y rutas", () => {
  expect(leer.resumen?.({ ruta: "a.txt" })).toBe("a.txt");
  expect(leer.resumen?.({ ruta: "a.txt", desde: 3, lineas: 2 })).toBe("a.txt:3-4");
  expect(leer.rutas?.({ ruta: "a.txt" }, dir)).toEqual([join(dir, "a.txt")]);
});
