import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorHerramienta } from "../src/herramientas/herramienta";
import { leer } from "../src/herramientas/leer";

let dir = "";
const ctx = () => ({ cwd: dir, senal: new AbortController().signal });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "aquiles-leer-"));
  await writeFile(join(dir, "a.txt"), "uno\r\ndos\ntres\n");
  await writeFile(join(dir, "largo.txt"), Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n"));
  await writeFile(join(dir, "bin.dat"), new Uint8Array([1, 0, 2]));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("numera las líneas y normaliza CRLF", async () => {
  expect(await leer.ejecutar({ ruta: "a.txt" }, ctx())).toBe("1\tuno\n2\tdos\n3\ttres");
});

test("lee un rango y dice cómo seguir", async () => {
  const r = await leer.ejecutar({ ruta: "largo.txt", desde: 5, lineas: 3 }, ctx());
  expect(r).toBe("5\tl5\n6\tl6\n7\tl7\n[líneas 5-7 de 30; sigue con desde=8]");
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
