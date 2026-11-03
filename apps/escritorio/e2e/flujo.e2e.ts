/**
 * De extremo a extremo: el núcleo de verdad con el proveedor simulado, la interfaz compilada (dist/) servida en un
 * puerto libre y Chromium con Playwright, en el modo navegador (?ws=…&token=…). Se ejecuta con `bun run e2e`
 * (compila la interfaz antes); `bun test` normal no lo coge: no se llama *.test.ts y hay que pedirlo por su ruta.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const RAIZ = resolve(import.meta.dir, "../../..");
const DIST = join(RAIZ, "apps/escritorio/dist");
const TOKEN = "token-e2e-0123456789";

let nucleo: Bun.Subprocess;
let web: ReturnType<typeof Bun.serve>;
let navegador: Browser;
let pagina: Page;
let home = "";

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("Falta apps/escritorio/dist: ejecuta `bun run e2e`, que compila antes la interfaz.");
  web = Bun.serve({
    port: 0,
    fetch(req) {
      const ruta = new URL(req.url).pathname;
      const fichero = Bun.file(join(DIST, ruta === "/" ? "index.html" : ruta));
      return fichero.size ? new Response(fichero) : new Response(Bun.file(join(DIST, "index.html")));
    },
  });
  home = mkdtempSync(join(tmpdir(), "aquiles-e2e-"));
  const proyecto = mkdtempSync(join(tmpdir(), "aquiles-e2e-proyecto-"));
  writeFileSync(join(proyecto, "README.md"), "# Proyecto de prueba\n");
  nucleo = Bun.spawn(
    ["bun", join(RAIZ, "packages/nucleo/src/main.ts"), "--puerto", "0", "--token", TOKEN, "--proveedor", "simulado", "--cwd", proyecto],
    { env: { ...process.env, AQUILES_HOME: home, AQUILES_ORIGENES: `http://localhost:${web.port}` }, stdout: "pipe", stderr: "ignore" },
  );
  // La primera línea dice en qué puerto escucha: AQUILES_READY port=N.
  const lector = (nucleo.stdout as ReadableStream<Uint8Array>).getReader();
  let salida = "";
  while (!/AQUILES_READY port=\d+/.test(salida)) {
    const { value, done } = await lector.read();
    if (done) throw new Error(`El núcleo no arrancó: ${salida}`);
    salida += new TextDecoder().decode(value);
  }
  const puerto = /port=(\d+)/.exec(salida)![1];
  navegador = await chromium.launch();
  pagina = await navegador.newPage({ viewport: { width: 1200, height: 850 } });
  await pagina.goto(`http://localhost:${web.port}/?ws=ws://127.0.0.1:${puerto}&token=${TOKEN}`);
}, 60_000);

afterAll(async () => {
  await navegador?.close();
  nucleo?.kill();
  web?.stop(true);
});

/** Espera a que se vea (los comparadores de Playwright no están en bun:test). */
const visible = (l: ReturnType<Page["locator"]>, timeout = 5_000) => l.first().waitFor({ state: "visible", timeout });

const enviar = async (texto: string) => {
  const caja = pagina.getByRole("textbox", { name: /Mensaje para Aquiles|Instrucción para Aquiles/ }).first();
  await caja.fill(texto);
  await caja.press("Enter");
};

test("conversar: la respuesta en markdown llega y se pinta", async () => {
  await enviar("hola");
  await visible(pagina.getByRole("heading", { name: "Respuesta de prueba" }), 10_000);
  await visible(pagina.locator("code", { hasText: "código" }).first());
}, 30_000);

test("permisos: un comando pide permiso, «Permitir una vez» lo ejecuta y su tarjeta da el resultado", async () => {
  await enviar("ejecuta echo hola-e2e");
  const permitir = pagina.getByRole("button", { name: "Permitir una vez" });
  await visible(permitir, 10_000);
  await permitir.click();
  await visible(pagina.getByText(/Hecho: `?terminal`? devolvió/), 15_000);
  await visible(pagina.locator(".herramienta__resumen", { hasText: "echo hola-e2e" }));
}, 30_000);

test("ajustes: cambiar los pasos máximos se guarda solo en el perfil", async () => {
  await pagina.getByText("Ajustes", { exact: true }).first().click();
  const pasos = pagina.getByLabel("Pasos");
  await pasos.fill("30");
  await visible(pagina.getByText("Guardado", { exact: true }), 5_000);
  const ajustes = JSON.parse(readFileSync(join(home, "perfiles", "principal", "ajustes.json"), "utf8"));
  expect(ajustes.maxPasos).toBe(30);
}, 30_000);
