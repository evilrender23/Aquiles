import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buscarFicheros } from "../src/herramientas/buscar-ficheros";
import { buscarTexto } from "../src/herramientas/buscar-texto";
import { ErrorHerramienta } from "../src/herramientas/herramienta";
import { carpetaTemporal, contextoPrueba } from "./contexto-prueba";

let dir = "";
let borrar = async () => {};
const ctx = () => contextoPrueba(dir);

const ficheros: Record<string, string | Uint8Array> = {
  ".gitignore": "# comentario\nignorado/\n*.log\n!importante.log\n/raiz-solo.txt\n",
  "src/a.ts": "export function hola() {}\nconst x = 1;\nconst y = 2;\n",
  "src/sub/b.ts": "hola mundo\r\nHOLA\r\n",
  "src/c.js": "// hola\n",
  "node_modules/pkg/index.js": "hola\n",
  ".git/config": "hola\n",
  "dist/out.js": "hola\n",
  "target/x.rs": "hola\n",
  ".venv/x.py": "hola\n",
  "__pycache__/x.pyc": "hola\n",
  "ignorado/x.ts": "hola\n",
  "debug.log": "hola\n",
  "importante.log": "hola\n",
  "raiz-solo.txt": "hola\n",
  "otra/raiz-solo.txt": "hola\n",
  "bin.dat": new Uint8Array([104, 111, 108, 97, 0, 1]),
};

beforeAll(async () => {
  ({ dir, borrar } = await carpetaTemporal("buscar"));
  for (const [ruta, datos] of Object.entries(ficheros)) {
    await mkdir(dirname(join(dir, ruta)), { recursive: true });
    await writeFile(join(dir, ruta), datos);
  }
  await writeFile(join(dir, "grande.txt"), `hola\n${"x".repeat(2 * 1024 * 1024)}`);
  await utimes(join(dir, "src/a.ts"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  await utimes(join(dir, "src/sub/b.ts"), new Date(2024, 0, 1), new Date(2024, 0, 1));
});
afterAll(() => borrar());

describe("buscar_texto", () => {
  test("respeta exclusiones, .gitignore, binarios y ficheros grandes", async () => {
    const r = await buscarTexto.ejecutar({ patron: "hola" }, ctx());
    expect(r.split("\n").sort()).toEqual(
      [
        "importante.log:1: hola",
        "otra/raiz-solo.txt:1: hola",
        "src/a.ts:1: export function hola() {}",
        "src/c.js:1: // hola",
        "src/sub/b.ts:1: hola mundo",
      ].sort(),
    );
  });

  test("ignorar_mayusculas y (?i)", async () => {
    expect(await buscarTexto.ejecutar({ patron: "^HOLA$", ignorar_mayusculas: true, glob: "*.ts" }, ctx())).toBe("src/sub/b.ts:2: HOLA");
    expect(await buscarTexto.ejecutar({ patron: "(?i)^hola$", glob: "src/**" }, ctx())).toBe("src/sub/b.ts:2: HOLA");
  });

  test("glob por nombre y por ruta", async () => {
    const porNombre = await buscarTexto.ejecutar({ patron: "hola", glob: "*.ts" }, ctx());
    expect(porNombre).toBe("src/a.ts:1: export function hola() {}\nsrc/sub/b.ts:1: hola mundo");
    expect(await buscarTexto.ejecutar({ patron: "hola", glob: "src/sub/*" }, ctx())).toBe("src/sub/b.ts:1: hola mundo");
  });

  test("contexto", async () => {
    const r = await buscarTexto.ejecutar({ patron: "const x", contexto: 1 }, ctx());
    expect(r).toBe("src/a.ts-1- export function hola() {}\nsrc/a.ts:2: const x = 1;\nsrc/a.ts-3- const y = 2;");
  });

  test("trunca con aviso", async () => {
    const r = await buscarTexto.ejecutar({ patron: "hola", max_resultados: 2 }, ctx());
    const lineas = r.split("\n");
    expect(lineas).toHaveLength(3);
    expect(lineas[2]).toContain("truncados en 2");
  });

  test("ruta a un fichero y dentro de una carpeta excluida", async () => {
    expect(await buscarTexto.ejecutar({ patron: "y =", ruta: "src/a.ts" }, ctx())).toBe("src/a.ts:3: const y = 2;");
    expect(await buscarTexto.ejecutar({ patron: "hola", ruta: "node_modules" }, ctx())).toBe("node_modules/pkg/index.js:1: hola");
  });

  test("sin coincidencias y errores", async () => {
    expect(await buscarTexto.ejecutar({ patron: "no-esta-en-ningun-sitio" }, ctx())).toMatch(/^Sin coincidencias/);
    await expect(buscarTexto.ejecutar({ patron: "(" }, ctx())).rejects.toBeInstanceOf(ErrorHerramienta);
    await expect(buscarTexto.ejecutar({ patron: "a", ruta: "no-existe" }, ctx())).rejects.toThrow("No existe");
  });
});

describe("buscar_ficheros", () => {
  test("por nombre, más recientes primero, con exclusiones", async () => {
    expect(await buscarFicheros.ejecutar({ patron: "*.ts" }, ctx())).toBe("src/sub/b.ts\nsrc/a.ts");
    expect(await buscarFicheros.ejecutar({ patron: "src/**/*.ts" }, ctx())).toBe("src/sub/b.ts\nsrc/a.ts");
    expect(await buscarFicheros.ejecutar({ patron: "*.log" }, ctx())).toBe("importante.log");
    expect(await buscarFicheros.ejecutar({ patron: "raiz-solo.txt" }, ctx())).toBe("otra/raiz-solo.txt");
  });

  test("dentro de una carpeta excluida si se pide", async () => {
    expect(await buscarFicheros.ejecutar({ patron: "*.js", ruta: "node_modules" }, ctx())).toBe("node_modules/pkg/index.js");
  });

  test("sin resultados y errores", async () => {
    expect(await buscarFicheros.ejecutar({ patron: "*.nada" }, ctx())).toMatch(/^Ningún fichero/);
    await expect(buscarFicheros.ejecutar({ patron: "*", ruta: "src/a.ts" }, ctx())).rejects.toThrow("no es una carpeta");
  });

  test("máximo 200 con aviso", async () => {
    await mkdir(join(dir, "muchos"));
    await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(join(dir, "muchos", `f${i}.md`), "")));
    const r = (await buscarFicheros.ejecutar({ patron: "*.md", ruta: "muchos" }, ctx())).split("\n");
    expect(r).toHaveLength(201);
    expect(r[200]).toContain("205 ficheros");
  });
});
