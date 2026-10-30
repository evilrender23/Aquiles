import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agruparGGUF, buscarModelos, Descargas, ficherosRepo, modelosLocales, type ProgresoDescarga } from "../src/locales/huggingface";

const base = mkdtempSync(join(tmpdir(), "aquiles-hf-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("agrupa partes, ordena por tamaño y lee la cuantización del nombre", () => {
  expect(
    agruparGGUF([
      { ruta: "README.md", bytes: 1 },
      { ruta: "BF16/M-BF16-00002-of-00002.gguf", bytes: 5 },
      { ruta: "BF16/M-BF16-00001-of-00002.gguf", bytes: 50 },
      { ruta: "M-UD-Q4_K_XL.gguf", bytes: 17 },
      { ruta: "mmproj-F16.gguf", bytes: 2 },
    ]),
  ).toEqual([
    { nombre: "mmproj-F16.gguf", partes: ["mmproj-F16.gguf"], bytes: 2, cuantizacion: "F16" },
    { nombre: "M-UD-Q4_K_XL.gguf", partes: ["M-UD-Q4_K_XL.gguf"], bytes: 17, cuantizacion: "UD-Q4_K_XL" },
    { nombre: "BF16/M-BF16-00001-of-00002.gguf", partes: ["BF16/M-BF16-00001-of-00002.gguf", "BF16/M-BF16-00002-of-00002.gguf"], bytes: 55, cuantizacion: "BF16" },
  ]);
});

test("búsqueda y ficheros de un repositorio desde la API (con clave si la hay)", async () => {
  const pedidas: { url: string; auth?: string }[] = [];
  const falso = async (url: string, init?: RequestInit) => {
    pedidas.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (url.includes("/api/models?"))
      return Response.json([
        { id: "a/b-GGUF", downloads: 10, likes: 2, gated: "auto", lastModified: "2026-10-01", pipeline_tag: "image-text-to-text" },
        { id: "c/d", downloads: 1 },
        { id: "voz/asr", pipeline_tag: "automatic-speech-recognition" },
        { id: "e/embed", tags: ["gguf", "sentence-similarity"] },
      ]);
    return Response.json({ gated: false, gguf: { context_length: 262144, architecture: "qwen35" }, siblings: [{ rfilename: "x-Q8_0.gguf", size: 9 }, { rfilename: "mmproj-x.gguf", size: 1 }] });
  };
  expect(await buscarModelos("qwen", { fetch: falso, token: "t" })).toEqual([
    { repo: "a/b-GGUF", descargas: 10, likes: 2, protegido: true, imagenes: true, actualizado: "2026-10-01" },
    { repo: "c/d", descargas: 1, likes: 0, protegido: false },
  ]);
  expect(pedidas[0]?.url).toContain("filter=gguf");
  expect(pedidas[0]?.auth).toBe("Bearer t");
  const repo = await ficherosRepo("a/b-GGUF", { fetch: falso });
  expect(repo).toMatchObject({ protegido: false, ventana: 262144, arquitectura: "qwen35" });
  expect(repo.ficheros.map((f) => f.nombre)).toEqual(["x-Q8_0.gguf"]);
  expect(repo.proyectores.map((f) => f.nombre)).toEqual(["mmproj-x.gguf"]);
  await expect(ficherosRepo("../fuera", { fetch: falso })).rejects.toThrow("no válido");
});

test("descarga reanudable con partes y proyector; luego aparece en local y se borra", async () => {
  const contenido: Record<string, string> = { "m-00001-of-00002.gguf": "AAAAAAAAAA", "m-00002-of-00002.gguf": "BBBBB", "mmproj-m.gguf": "PP" };
  const rangos: (string | undefined)[] = [];
  const falso = async (url: string, init?: RequestInit) => {
    const nombre = decodeURIComponent(url.split("/resolve/main/")[1] ?? "");
    const rango = (init?.headers as Record<string, string> | undefined)?.range;
    rangos.push(rango);
    const texto = contenido[nombre] ?? "";
    if (rango) return new Response(texto.slice(Number(/bytes=(\d+)-/.exec(rango)?.[1])), { status: 206 });
    return new Response(texto);
  };
  // Una descarga anterior dejó la primera parte a medias.
  mkdirSync(join(base, "o__r"), { recursive: true });
  writeFileSync(join(base, "o__r", "m-00001-of-00002.gguf.part"), "AAAA");
  const avisos: ProgresoDescarga[] = [];
  const terminado = new Promise<void>((ok) => {
    const d = new Descargas({ base, fetch: falso, intervaloMs: 0, alProgreso: (p) => (avisos.push(p), p.estado !== "descargando" && ok()) });
    d.iniciar("o/r", { nombre: "m-00001-of-00002.gguf", partes: ["m-00001-of-00002.gguf", "m-00002-of-00002.gguf"], bytes: 15 }, { nombre: "mmproj-m.gguf", partes: ["mmproj-m.gguf"], bytes: 2 });
  });
  await terminado;
  expect(avisos.at(-1)).toMatchObject({ estado: "terminada", bytes: 17, total: 17 });
  expect(rangos[0]).toBe("bytes=4-");
  expect(readFileSync(join(base, "o__r", "m-00001-of-00002.gguf"), "utf8")).toBe("AAAAAAAAAA");
  const locales = await modelosLocales(base);
  expect(locales).toEqual([
    {
      id: "o/r/m-00001-of-00002.gguf", repo: "o/r", nombre: "m-00001-of-00002.gguf", ruta: join(base, "o__r", "m-00001-of-00002.gguf"),
      bytes: 15, partes: ["m-00001-of-00002.gguf", "m-00002-of-00002.gguf"], proyector: join(base, "o__r", "mmproj-m.gguf"),
    },
  ]);
  await new Descargas({ base }).borrar("o/r/m-00001-of-00002.gguf");
  expect(existsSync(join(base, "o__r"))).toBe(false);
});

test("un modelo con partes que faltan no cuenta como descargado", async () => {
  mkdirSync(join(base, "p__q"), { recursive: true });
  writeFileSync(join(base, "p__q", "z-00001-of-00003.gguf"), "x");
  expect((await modelosLocales(base)).filter((m) => m.repo === "p/q")).toEqual([]);
});
