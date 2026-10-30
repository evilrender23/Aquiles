import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buscarFicheros, conMenciones, ficherosMencionados } from "../src/menciones";

let cwd = "";

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "aquiles-menciones-"));
  await mkdir(join(cwd, "src", "partes"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "x"), { recursive: true });
  await mkdir(join(cwd, "con espacio"), { recursive: true });
  for (const f of ["leeme.md", "src/servidor.ts", "src/partes/servidor-viejo.ts", "src/cliente.ts", "node_modules/x/servidor.js", "generado.log", "con espacio/nota.txt"])
    await writeFile(join(cwd, f), "x");
  await writeFile(join(cwd, ".gitignore"), "*.log\n");
});
afterAll(() => rm(cwd, { recursive: true, force: true }));

test("buscar: prefijo del nombre antes que contenerlo, menos profundos primero, sin node_modules ni lo ignorado", async () => {
  expect(await buscarFicheros(cwd, "servidor")).toEqual(["src/servidor.ts", "src/partes/servidor-viejo.ts"]);
  expect(await buscarFicheros(cwd, "src/cli")).toEqual(["src/cliente.ts"]);
  const todos = await buscarFicheros(cwd, "");
  expect(todos.slice(0, 2)).toEqual(["leeme.md", ".gitignore"]);
  expect(todos).not.toContain("generado.log");
  expect(todos.some((f) => f.startsWith("node_modules"))).toBe(false);
  expect(await buscarFicheros(cwd, "", 2)).toHaveLength(2);
});

test("menciones: rutas relativas, entre comillas y con puntuación detrás; ni correos ni lo que no existe", async () => {
  const texto = 'Mira @src/servidor.ts, compáralo con @"con espacio/nota.txt" y @leeme.md. Escribe a ana@correo.com sobre @no-existe.ts y @src';
  expect(await ficherosMencionados(texto, cwd)).toEqual([join(cwd, "src", "servidor.ts"), join(cwd, "con espacio", "nota.txt"), join(cwd, "leeme.md")]);
  expect(await ficherosMencionados("@src/servidor.ts y otra vez @src/servidor.ts", cwd)).toHaveLength(1);
});

test("conMenciones: se suman a los adjuntos sin repetir los que ya van", async () => {
  const ya = { nombre: "servidor.ts", ruta: join(cwd, "src", "servidor.ts") };
  expect(await conMenciones("@src/servidor.ts y @leeme.md", cwd, [ya])).toEqual([ya, { nombre: "leeme.md", ruta: join(cwd, "leeme.md") }]);
  expect(await conMenciones("sin menciones", cwd, [])).toEqual([]);
});
