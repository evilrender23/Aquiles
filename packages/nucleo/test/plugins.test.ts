import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorHerramienta, especDe, type ContextoHerramienta } from "../src/herramientas/herramienta";
import { ErrorPlugin, Plugins } from "../src/plugins";

const ctx = { cwd: "C:\\p", sesionId: "s1", senal: new AbortController().signal } as ContextoHerramienta;

function perfil(plugins: Record<string, Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "aquiles-plugins-"));
  for (const [nombre, ficheros] of Object.entries(plugins)) {
    mkdirSync(join(dir, "plugins", nombre), { recursive: true });
    for (const [f, texto] of Object.entries(ficheros)) writeFileSync(join(dir, "plugins", nombre, f), texto);
  }
  return dir;
}

const SALUDO = (texto: string) => `
export default ({ definir, z, ErrorHerramienta }) => ({
  descripcion: "Saluda a la gente",
  herramientas: [
    definir({
      nombre: "saludar",
      descripcion: "Saluda",
      parametros: z.object({ nombre: z.string() }),
      resumen: (a) => a.nombre,
      async ejecutar({ nombre }) {
        if (nombre === "nadie") throw new ErrorHerramienta("¿A quién?");
        return "${texto}, " + nombre;
      },
    }),
    { nombre: "leer_algo", descripcion: "Lee", nivel: "lectura", async ejecutar() { return { ok: true }; } },
    { nombre: "rota", nivel: "peligrosa", async ejecutar() { return ""; } },
    { nombre: "sin_ejecutar" },
  ],
});
`;

test("solo importa los activos; las herramientas llevan prefijo, nivel por defecto y van envueltas", async () => {
  const dir = perfil({
    saludos: { "plugin.ts": SALUDO("Hola") },
    // Si se importara, fallaría la prueba: listar no ejecuta código de un plugin desactivado.
    inactivo: { "plugin.js": 'export default { descripcion: "Uno apagado", herramientas: [] };\nthrow new Error("no debería ejecutarse");\n' },
  });
  const cambios: number[] = [];
  const plugins = new Plugins({ dir, alCambiar: () => cambios.push(1) });
  await plugins.cargar();
  expect(plugins.herramientas()).toEqual([]);
  expect(plugins.listar()).toEqual([
    { nombre: "inactivo", descripcion: "Uno apagado", ruta: join(dir, "plugins", "inactivo"), activo: false, cargado: false, herramientas: [] },
    { nombre: "saludos", descripcion: "Saluda a la gente", ruta: join(dir, "plugins", "saludos"), activo: false, cargado: false, herramientas: [] },
  ]);

  const info = await plugins.activar("saludos", true);
  expect(info).toMatchObject({ nombre: "saludos", activo: true, cargado: true, herramientas: ["saludar", "leer_algo"] });
  expect(info.error).toContain("rota (nivel «peligrosa» no válido");
  expect(info.error).toContain("sin_ejecutar (sin ejecutar)");
  expect(JSON.parse(readFileSync(join(dir, "plugins.json"), "utf8"))).toEqual({ activos: ["saludos"] });
  expect(cambios.length).toBe(2);

  const [saludar, leerAlgo] = plugins.herramientas();
  expect(saludar).toMatchObject({ nombre: "plugin__saludos__saludar", nivel: "ejecucion" });
  expect(leerAlgo).toMatchObject({ nombre: "plugin__saludos__leer_algo", nivel: "lectura" });
  expect(await saludar!.ejecutar({ nombre: "Ana" }, ctx)).toBe("Hola, Ana");
  // Usa el ErrorHerramienta de Aquiles: el bucle lo devuelve al modelo como error normal.
  expect(saludar!.ejecutar({ nombre: "nadie" }, ctx)).rejects.toBeInstanceOf(ErrorHerramienta);
  expect(await leerAlgo!.ejecutar({}, ctx)).toBe('{"ok":true}');
  expect(saludar!.resumen?.({ nombre: "Ana" })).toBe("Ana");
  // Su esquema sale del zod de Aquiles, como el de cualquier herramienta.
  expect(especDe(saludar!).esquema).toMatchObject({ type: "object", properties: { nombre: { type: "string" } } });

  // Otro proceso arranca con lo guardado en plugins.json.
  const otro = new Plugins({ dir });
  await otro.cargar();
  expect(otro.herramientas().map((h) => h.nombre)).toEqual(["plugin__saludos__saludar", "plugin__saludos__leer_algo"]);

  await plugins.activar("saludos", false);
  expect(plugins.herramientas()).toEqual([]);
  expect(plugins.listar().find((p) => p.nombre === "saludos")).toMatchObject({ activo: false, cargado: false, herramientas: [] });
});

test("al reactivarlo vuelve a importar el fichero", async () => {
  const dir = perfil({ saludos: { "plugin.ts": SALUDO("Hola") } });
  const plugins = new Plugins({ dir });
  await plugins.activar("saludos", true);
  expect(await plugins.herramientas()[0]!.ejecutar({ nombre: "Ana" }, ctx)).toBe("Hola, Ana");
  writeFileSync(join(dir, "plugins", "saludos", "plugin.ts"), SALUDO("Buenas"));
  await plugins.activar("saludos", true);
  expect(await plugins.herramientas()[0]!.ejecutar({ nombre: "Ana" }, ctx)).toBe("Buenas, Ana");
});

test("un plugin que falla no tumba a los demás", async () => {
  const dir = perfil({
    bueno: { "plugin.js": 'export default { descripcion: "Bien", herramientas: [{ nombre: "x", async ejecutar() { return "x"; } }] };' },
    sintaxis: { "plugin.ts": "export default {{{" },
    lanza: { "plugin.ts": 'throw new Error("me rompo al importar");' },
    vacio: { "plugin.ts": "export const nada = 1;" },
    forma: { "plugin.ts": "export default () => ({ herramientas: 3 });" },
    ganchos: {
      "plugin.ts":
        'export default { herramientas: [{ nombre: "g", nivel: "escritura", resumen() { throw new Error("x"); }, rutas() { throw new Error("x"); }, async ejecutar() { return "g"; } }] };',
    },
    sinfichero: { "LEEME.md": "nada" },
    "Mal Nombre": { "plugin.ts": "export default { herramientas: [] };" },
  });
  writeFileSync(join(dir, "plugins.json"), JSON.stringify({ activos: ["bueno", "sintaxis", "lanza", "vacio", "forma", "ganchos", "sinfichero", "Mal Nombre"] }));
  const plugins = new Plugins({ dir });
  await plugins.cargar();
  const porNombre = Object.fromEntries(plugins.listar().map((p) => [p.nombre, p]));
  expect(porNombre.bueno).toMatchObject({ cargado: true, herramientas: ["x"] });
  expect(porNombre.bueno!.error).toBeUndefined();
  expect(porNombre.sintaxis).toMatchObject({ cargado: false });
  expect(porNombre.sintaxis!.error).toBeTruthy();
  expect(porNombre.lanza).toMatchObject({ cargado: false, error: "me rompo al importar" });
  expect(porNombre.vacio).toMatchObject({ cargado: false, error: "no tiene `export default`" });
  expect(porNombre.forma!.error).toContain("debe exportar");
  expect(porNombre.sinfichero).toMatchObject({ cargado: false, error: "No tiene plugin.ts ni plugin.js" });
  expect(porNombre["Mal Nombre"]!.error).toContain("Nombre de carpeta no válido");
  expect(plugins.herramientas().map((h) => h.nombre)).toEqual(["plugin__bueno__x", "plugin__ganchos__g"]);

  // Un gancho que lanza no rompe el turno: resumen vacío y sin rutas.
  const g = plugins.herramientas()[1]!;
  expect(g.resumen?.({})).toBe("");
  expect(g.rutas?.({}, "C:\\p")).toEqual([]);

  expect(plugins.activar("no-existe", true)).rejects.toBeInstanceOf(ErrorPlugin);
  expect(plugins.activar("sinfichero", true)).rejects.toThrow("No tiene plugin.ts");
});

test("sin carpeta de perfil no hay plugins", async () => {
  const plugins = new Plugins({ dir: null });
  await plugins.cargar();
  expect(plugins.listar()).toEqual([]);
  expect(plugins.herramientas()).toEqual([]);
});
