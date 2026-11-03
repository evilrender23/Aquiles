import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herramientaGenerarImagen, rutaLibre } from "../src/herramientas/imagen";
import { generarImagen, serviciosDisponibles } from "../src/imagenes";
import { contextoPrueba } from "./contexto-prueba";

const PNG = Buffer.from("png-falso").toString("base64");

/** Un fetch falso que guarda la petición y responde lo que se le diga. */
function falso(responder: (url: string, cuerpo: any) => { status?: number; json: unknown }) {
  const pedidas: { url: string; cabeceras: Record<string, string>; cuerpo: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const cuerpo = JSON.parse(String(init.body));
    pedidas.push({ url, cabeceras: init.headers as Record<string, string>, cuerpo });
    const r = responder(url, cuerpo);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, pedidas };
}

test("servicios: los de API con clave (Gemini, OpenAI, OpenRouter) y luego los CLI (agy, Codex)", () => {
  expect(serviciosDisponibles({}, [])).toEqual([]);
  expect(serviciosDisponibles({ OPENROUTER_API_KEY: "r", OPENAI_API_KEY: "o" }, [])).toEqual(["openai", "openrouter"]);
  expect(serviciosDisponibles({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" }, ["codex"])).toEqual(["gemini", "openai", "codex"]);
  // Sin claves, los CLI instalados: agy (Nano Banana) antes que Codex.
  expect(serviciosDisponibles({}, ["agy", "codex"])).toEqual(["agy", "codex"]);
});

test("Gemini: generateContent con modalidad imagen; la imagen sale de inlineData", async () => {
  const { f, pedidas } = falso(() => ({
    json: { candidates: [{ content: { parts: [{ text: "Aquí está." }, { inlineData: { mimeType: "image/png", data: PNG } }] } }] },
  }));
  const r = await generarImagen("un gato naranja", { entorno: { GEMINI_API_KEY: "clave-g" }, fetch: f });
  expect(Buffer.from(r.bytes).toString()).toBe("png-falso");
  expect(r).toMatchObject({ mime: "image/png", servicio: "gemini", modelo: "gemini-2.5-flash-image", texto: "Aquí está." });
  expect(pedidas[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
  expect(pedidas[0]!.cabeceras["x-goog-api-key"]).toBe("clave-g");
  expect(pedidas[0]!.cuerpo).toEqual({ contents: [{ parts: [{ text: "un gato naranja" }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } });

  const bloqueada = falso(() => ({ json: { promptFeedback: { blockReason: "SAFETY" } } }));
  await expect(generarImagen("x", { entorno: { GEMINI_API_KEY: "g" }, fetch: bloqueada.f })).rejects.toThrow("motivo: SAFETY");
  const error = falso(() => ({ status: 403, json: { error: { message: "API key not valid" } } }));
  await expect(generarImagen("x", { entorno: { GEMINI_API_KEY: "g" }, fetch: error.f })).rejects.toThrow("Gemini respondió 403: API key not valid");
});

test("OpenAI: images/generations con gpt-image-1 y b64_json", async () => {
  const { f, pedidas } = falso(() => ({ json: { data: [{ b64_json: PNG }] } }));
  const r = await generarImagen("un faro", { entorno: { OPENAI_API_KEY: "clave-o" }, fetch: f });
  expect(r).toMatchObject({ servicio: "openai", modelo: "gpt-image-1", mime: "image/png" });
  expect(pedidas[0]!.url).toBe("https://api.openai.com/v1/images/generations");
  expect(pedidas[0]!.cabeceras.authorization).toBe("Bearer clave-o");
  expect(pedidas[0]!.cuerpo).toEqual({ model: "gpt-image-1", prompt: "un faro", n: 1, size: "1024x1024" });
});

test("OpenRouter: chat/completions con modalities y la imagen como data URL", async () => {
  const { f, pedidas } = falso(() => ({
    json: { choices: [{ message: { content: "Lista", images: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG}` } }] } }] },
  }));
  const r = await generarImagen("un barco", { entorno: { OPENROUTER_API_KEY: "clave-r" }, fetch: f, modelo: "google/gemini-3-pro-image-preview" });
  expect(r).toMatchObject({ servicio: "openrouter", modelo: "google/gemini-3-pro-image-preview", mime: "image/jpeg", texto: "Lista" });
  expect(pedidas[0]!.cuerpo).toMatchObject({ model: "google/gemini-3-pro-image-preview", modalities: ["image", "text"] });
  const sinImagen = falso(() => ({ json: { choices: [{ message: { content: "No puedo" } }] } }));
  await expect(generarImagen("x", { entorno: { OPENROUTER_API_KEY: "r" }, fetch: sinImagen.f })).rejects.toThrow("¿el modelo genera imágenes?");
});

test("sin ninguna clave, un error que dice dónde ponerla", async () => {
  await expect(generarImagen("x", { entorno: {}, clis: [] })).rejects.toThrow("Ajustes → Modelos → Claves de API");
});

test("generar_imagen: guarda con la extensión del formato, sin pisar lo que hay, y lo dice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aquiles-img-"));
  await writeFile(join(dir, "portada.jpg"), "vieja");
  expect(rutaLibre(join(dir, "portada.png"), "jpg")).toBe(join(dir, "portada-2.jpg"));
  const { f } = falso(() => ({ json: { choices: [{ message: { images: [{ image_url: { url: `data:image/jpeg;base64,${PNG}` } }] } }] } }));
  const h = herramientaGenerarImagen({ entorno: { OPENROUTER_API_KEY: "r" }, fetch: f });
  const ctx = contextoPrueba(dir);
  const r = await h.ejecutar({ descripcion: "una portada", ruta: "portada.png" }, ctx);
  expect(r).toStartWith("Imagen guardada en portada-2.jpg");
  expect(await readFile(join(dir, "portada-2.jpg"), "utf8")).toBe("png-falso");
  expect(await readFile(join(dir, "portada.jpg"), "utf8")).toBe("vieja");
  expect(h.resumen?.({ descripcion: "x", ruta: "img/a.png" })).toBe("img/a.png");

  const sinClave = herramientaGenerarImagen({ entorno: {}, clis: [] });
  await expect(sinClave.ejecutar({ descripcion: "una portada", ruta: "p.png" }, ctx)).rejects.toThrow("Claves de API");
});

test("el visor de documentos abre imágenes como data URL", async () => {
  const { leerDocumento } = await import("../src/documentos");
  const dir = await mkdtemp(join(tmpdir(), "aquiles-img-visor-"));
  await writeFile(join(dir, "foto.JPG"), "jpeg-falso");
  expect(await leerDocumento(join(dir, "foto.JPG"))).toEqual({
    nombre: "foto.JPG",
    formato: "imagen",
    contenido: `data:image/jpeg;base64,${Buffer.from("jpeg-falso").toString("base64")}`,
  });
  await writeFile(join(dir, "a.bmp"), "x");
  await expect(leerDocumento(join(dir, "a.bmp"))).rejects.toThrow("una imagen");
});

describe("con los CLI (agy y codex)", () => {
  const FALSO = join(import.meta.dir, "imagen-cli-falso.ts");
  const correr = async (cli: "agy" | "codex", modo: string) => {
    const dir = await mkdtemp(join(tmpdir(), "aquiles-img-cli-"));
    process.env.IMAGEN_FALSO_CLI = cli;
    process.env.IMAGEN_FALSO_MODO = modo;
    process.env.IMAGEN_FALSO_ARGS = join(dir, "args.json");
    process.env.IMAGEN_FALSO_DATOS = join(dir, "datos");
    const r = await generarImagen("un gato naranja", {
      servicio: cli, comandoCli: [process.execPath, FALSO], carpetasDeDatos: [join(dir, "datos")], entorno: {},
    });
    const visto = JSON.parse(await readFile(join(dir, "args.json"), "utf8")) as { args: string[]; cwd: string };
    const stdin = await readFile(join(dir, "args.stdin"), "utf8");
    return { r, visto, stdin };
  };

  test("codex: exec con image_generation activada y lo demás apagado; la imagen en base64 en un evento", async () => {
    const { r, visto, stdin } = await correr("codex", "b64");
    expect(r).toMatchObject({ servicio: "codex", mime: "image/png", texto: "Aquí tienes la imagen." });
    expect(Buffer.from(r.bytes).subarray(0, 4).toString("latin1")).toBe("\x89PNG");
    expect(visto.args).toContain("exec");
    expect(visto.args.join(" ")).toContain("--enable image_generation");
    expect(visto.args.join(" ")).not.toContain("--disable image_generation");
    expect(visto.args.join(" ")).toContain("--disable shell_tool");
    expect(stdin).toContain("un gato naranja");
  });

  test("codex: la imagen como fichero en su carpeta de trabajo (temporal, que luego se borra)", async () => {
    const { r, visto } = await correr("codex", "cwd");
    expect(r.mime).toBe("image/png");
    expect(visto.cwd).toContain("aquiles-imagen-codex-");
    expect(await Bun.file(join(visto.cwd, "imagen.png")).exists()).toBe(false);
  });

  test("agy: solo generate_image permitida, para al llegar result; la imagen por ruta o en su carpeta de datos", async () => {
    const porRuta = await correr("agy", "ruta");
    expect(porRuta.r).toMatchObject({ servicio: "agy", modelo: "Nano Banana (agy)", texto: "Imagen generada." });
    const ajustes = porRuta.visto.args[porRuta.visto.args.indexOf("--settings") + 1]!;
    expect(ajustes).toContain("aquiles-imagen-agy-");
    expect(JSON.parse(porRuta.stdin).message.content).toContain("generate_image");

    const enDatos = await correr("agy", "datos");
    expect(enDatos.r.mime).toBe("image/png");
  });

  test("sin imagen: error claro con el registro de eventos guardado", async () => {
    await expect(correr("agy", "nada")).rejects.toThrow(/terminó sin que aparezca ninguna imagen.*Sus eventos están en .*aquiles-imagen-agy-\d+\.jsonl/);
  });
});
