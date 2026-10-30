import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editar } from "../src/herramientas/editar";
import { contarCambios, escribir } from "../src/herramientas/escribir";
import { rutaAbsoluta, rutaVisible } from "../src/herramientas/ficheros";
import { ErrorHerramienta } from "../src/herramientas/herramienta";
import { leer } from "../src/herramientas/leer";
import { carpetaTemporal, contextoPrueba } from "./contexto-prueba";

let dir = "";
let borrar = async () => {};
beforeAll(async () => {
  ({ dir, borrar } = await carpetaTemporal("ficheros"));
});
afterAll(() => borrar());

const contenido = (r: string) => readFile(join(dir, r), "utf8");

describe("escribir", () => {
  test("crea carpetas y cuenta líneas", async () => {
    const ctx = contextoPrueba(dir);
    expect(await escribir.ejecutar({ ruta: "nueva/sub/a.txt", contenido: "uno\ndos\n" }, ctx)).toBe("Escrito nueva/sub/a.txt (2 líneas)");
    expect(await contenido("nueva/sub/a.txt")).toBe("uno\ndos\n");
  });

  test("no sobrescribe un fichero sin leerlo", async () => {
    await writeFile(join(dir, "existe.txt"), "hola\n");
    const ctx = contextoPrueba(dir);
    const e = escribir.ejecutar({ ruta: "existe.txt", contenido: "adiós\n" }, ctx);
    await expect(e).rejects.toBeInstanceOf(ErrorHerramienta);
    await expect(escribir.ejecutar({ ruta: "existe.txt", contenido: "x" }, ctx)).rejects.toThrow("léelo antes de sobrescribirlo");
    expect(await contenido("existe.txt")).toBe("hola\n");
  });

  test("sobrescribe tras leer y da +añadidas/-quitadas", async () => {
    await writeFile(join(dir, "s.txt"), "a\nb\nc\n");
    const ctx = contextoPrueba(dir);
    await leer.ejecutar({ ruta: "s.txt" }, ctx);
    expect(await escribir.ejecutar({ ruta: "s.txt", contenido: "a\nB\nc\nd\n" }, ctx)).toBe("Escrito s.txt (4 líneas, +2 -1)");
    // Lo escrito cuenta como leído: se puede volver a escribir.
    expect(await escribir.ejecutar({ ruta: "s.txt", contenido: "z\n" }, ctx)).toBe("Escrito s.txt (1 línea, +1 -4)");
  });

  test("detecta que cambió desde que se leyó", async () => {
    await writeFile(join(dir, "c.txt"), "v1\n");
    const ctx = contextoPrueba(dir);
    await leer.ejecutar({ ruta: "c.txt" }, ctx);
    await writeFile(join(dir, "c.txt"), "v2 de otro\n");
    await expect(escribir.ejecutar({ ruta: "c.txt", contenido: "v3\n" }, ctx)).rejects.toThrow("ha cambiado desde que lo leíste");
  });

  test("respeta CRLF y BOM al sobrescribir", async () => {
    await writeFile(join(dir, "w.txt"), "\uFEFFuno\r\ndos\r\n");
    const ctx = contextoPrueba(dir);
    await leer.ejecutar({ ruta: "w.txt" }, ctx);
    await escribir.ejecutar({ ruta: "w.txt", contenido: "uno\ntres\n" }, ctx);
    expect(await contenido("w.txt")).toBe("\uFEFFuno\r\ntres\r\n");
  });

  test("contarCambios", () => {
    expect(contarCambios(["a", "b", "c"], ["a", "c"])).toEqual({ anadidas: 0, quitadas: 1 });
    expect(contarCambios(["a"], ["x", "a", "y"])).toEqual({ anadidas: 2, quitadas: 0 });
    expect(contarCambios(["a", "b", "c", "d"], ["d", "c", "b", "a"])).toEqual({ anadidas: 3, quitadas: 3 });
  });
});

describe("editar", () => {
  const preparar = async (nombre: string, texto: string, leerlo = true) => {
    await writeFile(join(dir, nombre), texto);
    const ctx = contextoPrueba(dir);
    if (leerlo) await leer.ejecutar({ ruta: nombre }, ctx);
    return ctx;
  };

  test("exige haber leído el fichero", async () => {
    const ctx = await preparar("e1.txt", "hola\n", false);
    await expect(editar.ejecutar({ ruta: "e1.txt", buscar: "hola", reemplazar: "adiós" }, ctx)).rejects.toThrow("léelo antes de editarlo");
  });

  test("pide releer si cambió", async () => {
    const ctx = await preparar("e2.txt", "hola\n");
    await writeFile(join(dir, "e2.txt"), "hola mundo\n");
    await expect(editar.ejecutar({ ruta: "e2.txt", buscar: "hola", reemplazar: "adiós" }, ctx)).rejects.toThrow("vuelve a leerlo");
  });

  test("no existe → sugiere escribir", async () => {
    const ctx = contextoPrueba(dir);
    await expect(editar.ejecutar({ ruta: "nada.txt", buscar: "a", reemplazar: "b" }, ctx)).rejects.toThrow("usa escribir");
  });

  test("sustituye una aparición y devuelve el fragmento con números", async () => {
    const texto = Array.from({ length: 10 }, (_, i) => `linea ${i + 1}`).join("\n") + "\n";
    const ctx = await preparar("e3.txt", texto);
    const r = await editar.ejecutar({ ruta: "e3.txt", buscar: "linea 5\n", reemplazar: "cinco\nCINCO\n" }, ctx);
    expect(r).toBe("Editado e3.txt (1 cambio):\n3\tlinea 3\n4\tlinea 4\n5\tcinco\n6\tCINCO\n7\tlinea 6\n8\tlinea 7");
    expect(await contenido("e3.txt")).toContain("linea 4\ncinco\nCINCO\nlinea 6");
    // La huella se actualiza: se puede seguir editando sin releer.
    await editar.ejecutar({ ruta: "e3.txt", buscar: "CINCO", reemplazar: "5" }, ctx);
    expect(await contenido("e3.txt")).toContain("cinco\n5\nlinea 6");
  });

  test("0 coincidencias: pista sobre espacios y tabulaciones", async () => {
    const ctx = await preparar("e4.ts", "function f() {\n\treturn 1;\n}\n");
    const e = editar.ejecutar({ ruta: "e4.ts", buscar: "function f() {\n    return 1;", reemplazar: "x" }, ctx);
    await expect(e).rejects.toThrow(/ignoran espacios y tabulaciones \(línea 1\).*tabulaciones/);
  });

  test("0 coincidencias: líneas parecidas y números de leer", async () => {
    const ctx = await preparar("e5.ts", "const total = calcularTotal(items);\nconsole.log(total);\n");
    await expect(editar.ejecutar({ ruta: "e5.ts", buscar: "const total = calcularTotales(items);", reemplazar: "x" }, ctx)).rejects.toThrow(
      /Líneas parecidas[\s\S]*1: const total = calcularTotal\(items\);/,
    );
    await expect(editar.ejecutar({ ruta: "e5.ts", buscar: "2\tconsole.log(total);", reemplazar: "x" }, ctx)).rejects.toThrow(
      "números de línea",
    );
    await expect(editar.ejecutar({ ruta: "e5.ts", buscar: "console.log(total);\nnada", reemplazar: "x" }, ctx)).rejects.toThrow(
      "está en la línea 2",
    );
  });

  test(">1 coincidencias: error con número y líneas; todas las cambia", async () => {
    const ctx = await preparar("e6.txt", "x = 1\ny = 2\nx = 1\nz = 3\nx = 1\n");
    await expect(editar.ejecutar({ ruta: "e6.txt", buscar: "x = 1", reemplazar: "x = 9" }, ctx)).rejects.toThrow(
      "aparece 3 veces en e6.txt (líneas 1, 3, 5)",
    );
    const r = await editar.ejecutar({ ruta: "e6.txt", buscar: "x = 1", reemplazar: "x = 9", todas: true }, ctx);
    expect(r.startsWith("Editado e6.txt (3 cambios):")).toBe(true);
    expect(await contenido("e6.txt")).toBe("x = 9\ny = 2\nx = 9\nz = 3\nx = 9\n");
  });

  test("respeta CRLF y BOM", async () => {
    const ctx = await preparar("e7.txt", "\uFEFFuno\r\ndos\r\ntres\r\n");
    await editar.ejecutar({ ruta: "e7.txt", buscar: "uno\ndos", reemplazar: "UNO\nmedio\nDOS" }, ctx);
    expect(await contenido("e7.txt")).toBe("\uFEFFUNO\r\nmedio\r\nDOS\r\ntres\r\n");
    await editar.ejecutar({ ruta: "e7.txt", buscar: "medio\r\n", reemplazar: "" }, ctx);
    expect(await contenido("e7.txt")).toBe("\uFEFFUNO\r\nDOS\r\ntres\r\n");
  });

  test("$ en el reemplazo es literal", async () => {
    const ctx = await preparar("e8.txt", "precio\n");
    await editar.ejecutar({ ruta: "e8.txt", buscar: "precio", reemplazar: "$& $1 $$" }, ctx);
    expect(await contenido("e8.txt")).toBe("$& $1 $$\n");
  });

  test("buscar igual que reemplazar es un error", async () => {
    const ctx = await preparar("e9.txt", "a\n");
    await expect(editar.ejecutar({ ruta: "e9.txt", buscar: "a", reemplazar: "a" }, ctx)).rejects.toThrow("iguales");
  });
});

test("rutas: relativas, estilo Git Bash y visibles", () => {
  expect(rutaAbsoluta("a/b.txt", dir)).toBe(join(dir, "a", "b.txt"));
  expect(rutaVisible(join(dir, "a", "b.txt"), dir)).toBe("a/b.txt");
  if (process.platform === "win32") {
    expect(rutaAbsoluta("/c/Users/x", dir)).toBe("C:\\Users\\x");
    expect(rutaVisible("D:\\otro\\f.txt", dir)).toBe("D:\\otro\\f.txt");
  }
});
