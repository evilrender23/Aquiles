/** Toda frase que pasa por t("…") en la app o en @aquiles/ui tiene su traducción al inglés. */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { traducido } from "@aquiles/ui";
import "./index";

const RAICES = [resolve(import.meta.dir, ".."), resolve(import.meta.dir, "../../../../packages/ui/src")];

function ficheros(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) return e.name === "i18n" ? [] : ficheros(ruta);
    // i18n.ts trae ejemplos de t() en sus comentarios.
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== "i18n.ts" ? [ruta] : [];
  });
}

/** Las frases literales de t("…") y t('…') (no las que se arman con ${}). */
export function frases(codigo: string): string[] {
  const r: string[] = [];
  for (const m of codigo.matchAll(/(?<![\w.$])t\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
    const literal = m[1]!;
    r.push(literal.startsWith('"') ? JSON.parse(literal) : literal.slice(1, -1).replace(/\\'/g, "'"));
  }
  return r;
}

test("las frases se encuentran como se escriben", () => {
  expect(frases(`t("Hola") + t('Adiós') + t("Con \\"comillas\\"", { n }) + dato.t("no") + gt("no")`)).toEqual(["Hola", "Adiós", 'Con "comillas"']);
});

test("toda frase de t() tiene traducción al inglés", () => {
  const faltan = new Map<string, string>();
  for (const raiz of RAICES) {
    for (const f of ficheros(raiz)) {
      for (const frase of frases(readFileSync(f, "utf8"))) if (!traducido("en", frase)) faltan.set(frase, f.slice(raiz.length + 1));
    }
  }
  expect([...faltan].map(([frase, f]) => `${f}: ${frase}`)).toEqual([]);
});
