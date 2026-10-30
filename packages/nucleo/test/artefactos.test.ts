import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { separarArtefactos, textoSinArtefactos } from "@aquiles/protocolo";
import { FicheroYaExiste, guardarArtefacto, VistasArtefactos } from "../src/artefactos";

test("separa texto y artefactos completos, con id, tipo, título y lenguaje", () => {
  const texto = 'Aquí la tienes:\n<artefacto id="calc" tipo="html" titulo="Calculadora">\n<p>hola</p>\n</artefacto>\nY un script:\n<artefacto id="x" tipo="codigo" lenguaje="Python" titulo="Suma">\nprint(1+1)\n</artefacto>';
  const trozos = separarArtefactos(texto);
  expect(trozos.map((t) => t.tipo)).toEqual(["texto", "artefacto", "texto", "artefacto"]);
  expect(trozos[1]).toEqual({ tipo: "artefacto", artefacto: { id: "calc", tipo: "html", titulo: "Calculadora", contenido: "<p>hola</p>", completo: true } });
  expect(trozos[3]).toMatchObject({ artefacto: { lenguaje: "python", contenido: "print(1+1)", completo: true } });
});

test("mientras llega: artefacto abierto y sin etiqueta a medias en el texto", () => {
  expect(separarArtefactos('Va:\n<artefacto id="a" tipo="svg" titulo="Logo">\n<svg>', { enCurso: true })).toEqual([
    { tipo: "texto", texto: "Va:\n" },
    { tipo: "artefacto", artefacto: { id: "a", tipo: "svg", titulo: "Logo", contenido: "<svg>", completo: false } },
  ]);
  expect(separarArtefactos("Va:\n<artef", { enCurso: true })).toEqual([{ tipo: "texto", texto: "Va:\n" }]);
  expect(separarArtefactos('Va:\n<artefacto id="a" ti', { enCurso: true })).toEqual([{ tipo: "texto", texto: "Va:\n" }]);
  expect(separarArtefactos("1 <a 2")).toEqual([{ tipo: "texto", texto: "1 <a 2" }]);
});

test("quita la valla de código y corrige tipo e id", () => {
  const [t] = separarArtefactos('<artefacto tipo="raro" titulo="Página de Ñandú">\n```html\n<b>x</b>\n```\n</artefacto>');
  expect(t).toEqual({ tipo: "artefacto", artefacto: { id: "pagina-de-nandu", tipo: "codigo", titulo: "Página de Ñandú", contenido: "<b>x</b>", completo: true } });
  const [abierto] = separarArtefactos('<artefacto id="b" tipo="markdown" titulo="B">\n```md\n# Hola', { enCurso: true });
  expect(abierto).toMatchObject({ artefacto: { contenido: "# Hola", completo: false } });
});

test("textoSinArtefactos deja una referencia por artefacto", () => {
  expect(textoSinArtefactos('Hecho.\n<artefacto id="a" tipo="html" titulo="Juego">\n<canvas>\n</artefacto>\nDime qué te parece.')).toBe(
    "Hecho.\n\n[Artefacto: Juego]\n\nDime qué te parece.",
  );
});

test("vista aislada: CSP sandbox, solo https hacia fuera, y el SVG envuelto en una página", async () => {
  const v = new VistasArtefactos();
  const ruta = v.publicar("html", "<p>hola</p>");
  expect(ruta).toMatch(/^\/vista\/[\w-]{20,}$/);
  const r = v.responder(ruta);
  expect(await r?.text()).toBe("<p>hola</p>");
  const csp = r?.headers.get("content-security-policy") ?? "";
  expect(csp).toStartWith("sandbox allow-scripts");
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).toContain("connect-src https:;");
  expect(await v.responder(v.publicar("svg", "<svg></svg>"))?.text()).toContain("<body><svg></svg></body>");
  expect(v.responder("/vista/otra")?.status).toBe(404);
  expect(v.responder("/rpc")).toBeUndefined();
});

test("guardar: solo un nombre de fichero, y sin pisar salvo que se pida", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aquiles-art-"));
  try {
    const ruta = await guardarArtefacto(cwd, "juego.html", "a");
    expect(readFileSync(ruta, "utf8")).toBe("a");
    await expect(guardarArtefacto(cwd, "juego.html", "b")).rejects.toBeInstanceOf(FicheroYaExiste);
    await guardarArtefacto(cwd, "juego.html", "b", true);
    expect(readFileSync(ruta, "utf8")).toBe("b");
    for (const malo of ["../x.html", "a/b.html", "..", "c:x"]) await expect(guardarArtefacto(cwd, malo, "x")).rejects.toThrow("no válido");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
