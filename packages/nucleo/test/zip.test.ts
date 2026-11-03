import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { casa, comprimirCarpeta, descomprimir, ErrorZip, escribirZip, miembrosZip } from "../src/zip";

const texto = (s: string) => () => new TextEncoder().encode(s);

test("ida y vuelta: comprime lo que mengua, guarda lo que no y respeta nombres UTF-8", () => {
  const dir = mkdtempSync(join(tmpdir(), "aquiles-zip-"));
  const ruido = new Uint8Array(4096).map(() => Math.floor(Math.random() * 256));
  escribirZip(join(dir, "a.zip"), [
    { nombre: "word/document.xml", datos: texto("<w:t>hola</w:t>".repeat(500)) },
    { nombre: "año/ruido.bin", datos: () => ruido },
  ]);
  const m = miembrosZip(readFileSync(join(dir, "a.zip")));
  expect(m.map((x) => x.nombre)).toEqual(["word/document.xml", "año/ruido.bin"]);
  expect(new TextDecoder().decode(m[0]!.leer())).toBe("<w:t>hola</w:t>".repeat(500));
  expect(m[1]!.leer()).toEqual(ruido);
  // Un miembro que se infla de más no se descomprime entero.
  expect(() => m[0]!.leer(100)).toThrow(ErrorZip);
  expect(() => miembrosZip(new TextEncoder().encode("no soy un zip"))).toThrow("No es un zip");
});

test("carpetas: excluye, descomprime y no deja salir de la carpeta", () => {
  const dir = mkdtempSync(join(tmpdir(), "aquiles-zip-"));
  mkdirSync(join(dir, "origen", "memoria"), { recursive: true });
  writeFileSync(join(dir, "origen", "memoria", "USER.md"), "hola\n");
  writeFileSync(join(dir, "origen", "busqueda.db"), "índice");
  comprimirCarpeta(join(dir, "origen"), join(dir, "c.zip"), (r) => r === "busqueda.db");
  descomprimir(join(dir, "c.zip"), join(dir, "destino"));
  expect(readFileSync(join(dir, "destino", "memoria", "USER.md"), "utf8")).toBe("hola\n");
  expect(existsSync(join(dir, "destino", "busqueda.db"))).toBe(false);

  // Las copias que hizo el tar llevaban «./» delante: se quita.
  escribirZip(join(dir, "tar.zip"), [{ nombre: "./notas.md", datos: texto("x") }]);
  expect(miembrosZip(readFileSync(join(dir, "tar.zip")))[0]!.nombre).toBe("notas.md");

  escribirZip(join(dir, "malo.zip"), [{ nombre: "../fuera.txt", datos: texto("x") }]);
  expect(() => descomprimir(join(dir, "malo.zip"), join(dir, "d2"))).toThrow("Nombre no válido");
  expect(existsSync(join(dir, "fuera.txt"))).toBe(false);
});

test("patrones de miembros", () => {
  expect(casa("ppt/slides/slide12.xml", "ppt/slides/slide*.xml")).toBe(true);
  expect(casa("ppt/slides/_rels/slide1.xml.rels", "ppt/slides/slide*.xml")).toBe(false);
  expect(casa("content.xml", "content.xml")).toBe(true);
});
