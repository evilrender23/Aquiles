import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herramientaBuscarSesiones, IndiceSesiones } from "../src/busqueda";
import type { Mensaje } from "../src/tipos";
import { carpetaTemporal, contextoPrueba } from "./contexto-prueba";

let tmp: { dir: string; borrar(): Promise<void> };
const abiertos: IndiceSesiones[] = [];
beforeEach(async () => {
  tmp = await carpetaTemporal("busqueda");
});
afterEach(async () => {
  for (const i of abiertos.splice(0)) i.cerrar();
  await tmp.borrar();
});

function indice(ruta: string | null = null): IndiceSesiones {
  const i = new IndiceSesiones(ruta);
  abiertos.push(i);
  return i;
}

const usuario = (texto: string): Mensaje => ({ rol: "usuario", texto });
const asistente = (texto: string): Mensaje => ({ rol: "asistente", texto, llamadas: [] });

test("encuentra sin distinguir tildes ni mayúsculas y marca la coincidencia", () => {
  const i = indice();
  i.registrarSesion({ sesionId: "s1", titulo: "Compilar el núcleo", cwd: "C:\\repo", actualizada: "2026-10-01T10:00:00.000Z" });
  i.indexar("s1", 0, usuario("¿Por qué falla la COMPILACIÓN del núcleo en Windows?"), "2026-10-01T10:00:00.000Z");
  i.indexar("s1", 1, asistente("Era el sufijo del sidecar: Tauri busca el triple de MSVC."), "2026-10-01T10:01:00.000Z");
  i.indexar("s2", 0, usuario("Receta de pan sin gluten"), "2026-10-02T10:00:00.000Z");

  const r = i.buscar("compilacion nucleo");
  expect(r).toHaveLength(1);
  expect(r[0]).toEqual({
    sesionId: "s1",
    titulo: "Compilar el núcleo",
    cwd: "C:\\repo",
    fecha: "2026-10-01T10:00:00.000Z",
    rol: "usuario",
    fragmento: "¿Por qué falla la «COMPILACIÓN» del «núcleo» en Windows?",
  });
  expect(i.buscar("Sidecar")[0]!.rol).toBe("asistente");
  expect(i.buscar("compil")[0]!.fragmento).toContain("«COMPILACIÓN»");
  expect(i.buscar("PAN")[0]).toMatchObject({ sesionId: "s2", cwd: "" });
  expect(i.buscar("pan", 20, "s2")).toEqual([]);
  // Si ningún mensaje tiene todas las palabras, vale con alguna.
  expect(i.buscar("sidecar gluten").map((x) => x.sesionId).sort()).toEqual(["s1", "s2"]);
});

test("consultas con sintaxis de FTS5 o caracteres raros no rompen", () => {
  const i = indice();
  i.indexar("s", 0, usuario('El fichero "C:\\Users\\Ozx\\a-b.ts" usa mi_funcion(x) y NOT/AND/OR: 50% *ok* ^1'), "2026-10-01T00:00:00.000Z");
  for (const q of ['"', 'a-b', "mi_funcion(x)", "NOT", "AND OR", "C:\\Users", "*", "^", "50%", "(", "NEAR(a b)", "col:texto", "'; DROP TABLE mensajes; --", "—", "   "]) {
    expect(() => i.buscar(q), q).not.toThrow();
  }
  expect(i.buscar("a-b")).toHaveLength(1);
  expect(i.buscar('"mi_funcion(x)"')).toHaveLength(1);
  expect(i.buscar("NOT")).toHaveLength(1);
  expect(i.buscar("—")).toEqual([]);
  expect(i.buscar("'; DROP TABLE mensajes; --")).toEqual([]);
  expect(i.buscar("ozx")).toHaveLength(1);
});

test("indexar es idempotente y de las herramientas guarda solo el principio", () => {
  const i = indice();
  expect(i.indexar("s", 0, usuario("hola mundo"), "2026-10-01T00:00:00.000Z")).toBe(true);
  expect(i.indexar("s", 0, usuario("hola mundo"), "2026-10-01T00:00:00.000Z")).toBe(false);
  expect(i.buscar("hola")).toHaveLength(1);
  expect(i.indexar("s", 1, asistente(""), "2026-10-01T00:00:00.000Z")).toBe(false);

  const resultado = Array.from({ length: 20 }, (_, n) => `línea ${n} ${n === 15 ? "escondida" : "visible"}`).join("\n");
  i.indexar("s", 2, { rol: "herramienta", id: "t1", nombre: "terminal", resumen: "bun test", resultado, error: false }, "2026-10-01T00:00:00.000Z");
  expect(i.buscar("terminal")[0]!.rol).toBe("herramienta");
  expect(i.buscar("bun test")).toHaveLength(1);
  expect(i.buscar("visible")).toHaveLength(1);
  expect(i.buscar("escondida")).toEqual([]);

  i.borrarSesion("s");
  expect(i.buscar("hola")).toEqual([]);
});

test("de los adjuntos indexa el nombre y el principio del texto extraído", () => {
  const i = indice();
  const texto = `${"relleno ".repeat(300)}escondido`;
  const m: Mensaje = {
    rol: "usuario",
    texto: "",
    adjuntos: [{ id: "a", nombre: "presupuesto-cocina.xlsx", tipo: "x", bytes: 1, clase: "documento", ruta: "C:/a", texto: `azulejos ${texto}` }],
  };
  expect(i.indexar("s", 0, m, "2026-10-01T00:00:00.000Z")).toBe(true);
  expect(i.buscar("presupuesto")).toHaveLength(1);
  expect(i.buscar("azulejos")).toHaveLength(1);
  expect(i.buscar("escondido")).toEqual([]);
});

test("como mucho 3 resultados por sesión, ordenados por relevancia y fecha", () => {
  const i = indice();
  for (let n = 0; n < 6; n++) i.indexar("larga", n, usuario(`error de red número ${n}`), `2026-10-0${n + 1}T00:00:00.000Z`);
  i.indexar("corta", 0, usuario("otro error"), "2026-09-01T00:00:00.000Z");
  const r = i.buscar("error");
  expect(r.filter((x) => x.sesionId === "larga")).toHaveLength(3);
  expect(r.filter((x) => x.sesionId === "corta")).toHaveLength(1);
  expect(i.buscar("error", 2)).toHaveLength(2);
  const larga = r.filter((x) => x.sesionId === "larga").map((x) => x.fecha);
  expect(larga).toEqual([...larga].sort().reverse());
});

test("sincronizar lee los JSONL con el ordinal de las líneas mensaje y tolera la última línea cortada", () => {
  const dir = join(tmp.dir, "sesiones");
  const ruta = join(dir, "abc-123.jsonl");
  const lineas = [
    { tipo: "inicio", id: "abc-123", cwd: "C:\\proyecto", sistema: "…", creada: "2026-09-30T08:00:00.000Z", modoAprobacion: "preguntar-ejecutar" },
    { tipo: "mensaje", mensaje: usuario("Configura el despliegue con Docker"), fecha: "2026-09-30T08:01:00.000Z" },
    { tipo: "mensaje", mensaje: asistente("Hecho: Dockerfile multietapa.") },
    { tipo: "compactacion", mensajes: [{ rol: "resumen", texto: "Resumen que no se indexa: kubernetes" }] },
    { tipo: "ajuste", titulo: "Docker en producción" },
    { tipo: "mensaje", mensaje: { rol: "resumen", texto: "Se configuró Docker y nginx." } },
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(ruta, `${lineas.map((l) => JSON.stringify(l)).join("\n")}\n{"tipo":"mensaje","mensaje":{"rol":"usu`);

  const i = indice(join(tmp.dir, "indice.db"));
  i.indexar("abc-123", 1, asistente("Hecho: Dockerfile multietapa."), "2026-09-30T08:02:00.000Z"); // ya indexado en vivo
  expect(i.sincronizar(dir)).toBe(2);
  expect(i.sincronizar(dir)).toBe(0);
  expect(i.sincronizar(join(tmp.dir, "no-existe"))).toBe(0);

  const docker = i.buscar("docker");
  expect(docker.map((r) => r.rol).sort()).toEqual(["asistente", "resumen", "usuario"]);
  expect(docker[0]).toMatchObject({ sesionId: "abc-123", titulo: "Docker en producción", cwd: "C:\\proyecto" });
  expect(docker.find((r) => r.rol === "usuario")!.fecha).toBe("2026-09-30T08:01:00.000Z");
  expect(docker.find((r) => r.rol === "resumen")!.fecha).toBe("2026-09-30T08:00:00.000Z");
  expect(i.buscar("kubernetes")).toEqual([]);

  // La línea cortada se completa y llega otra: entra solo la nueva, con el ordinal siguiente.
  writeFileSync(ruta, `${lineas.map((l) => JSON.stringify(l)).join("\n")}\n`);
  appendFileSync(ruta, `${JSON.stringify({ tipo: "mensaje", mensaje: usuario("¿Y el certificado TLS?"), fecha: "2026-10-01T09:00:00.000Z" })}\n`);
  expect(i.sincronizar(dir)).toBe(1);
  expect(i.indexar("abc-123", 3, usuario("¿Y el certificado TLS?"), "2026-10-01T09:00:00.000Z")).toBe(false);
  i.cerrar();
  abiertos.pop();

  // Persiste en disco; al desaparecer el fichero, la sesión sale del índice.
  const otra = indice(join(tmp.dir, "indice.db"));
  expect(otra.buscar("certificado")).toHaveLength(1);
  rmSync(ruta);
  expect(otra.sincronizar(dir)).toBe(0);
  expect(otra.buscar("docker")).toEqual([]);
});

test("título por defecto del primer mensaje del usuario", () => {
  const dir = join(tmp.dir, "s");
  mkdirSync(dir);
  const largo = `Quiero que revises ${"muy ".repeat(20)}a fondo`;
  writeFileSync(
    join(dir, "x.jsonl"),
    [{ tipo: "inicio", id: "x", cwd: "D:\\", sistema: "", creada: "2026-01-01T00:00:00.000Z" }, { tipo: "mensaje", mensaje: usuario(largo) }]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  const i = indice();
  expect(i.sincronizar(dir)).toBe(1);
  const t = i.buscar("revises")[0]!.titulo!;
  expect(t.length).toBe(60);
  expect(t.endsWith("…")).toBe(true);
});

test("buscar_sesiones deja fuera la sesión actual y da id, título, fecha y fragmento", async () => {
  const i = indice();
  i.registrarSesion({ sesionId: "vieja", titulo: "Migración SQLite", cwd: "C:\\app", actualizada: "2026-08-01T00:00:00.000Z" });
  i.indexar("vieja", 0, usuario("Migramos el esquema de SQLite con una tabla temporal"), "2026-08-01T00:00:00.000Z");
  i.indexar("prueba", 0, usuario("¿Cómo migramos SQLite la otra vez?"), "2026-10-30T00:00:00.000Z");
  const h = herramientaBuscarSesiones(i);
  expect(h.nombre).toBe("buscar_sesiones");
  expect(h.nivel).toBe("lectura");

  const r = await h.ejecutar({ consulta: "sqlite" }, contextoPrueba(tmp.dir));
  expect(r).toContain("1 resultado para «sqlite»:");
  expect(r).toContain("2026-08-01 · Migración SQLite · sesión vieja · C:\\app");
  expect(r).toContain("usuario: Migramos el esquema de «SQLite» con una tabla temporal");
  expect(await h.ejecutar({ consulta: "inexistente" }, contextoPrueba(tmp.dir))).toBe("Sin resultados para «inexistente» en otras sesiones.");
  expect(h.parametros.safeParse({ consulta: "" }).success).toBe(false);
});
