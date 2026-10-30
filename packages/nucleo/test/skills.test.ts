import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AlmacenSkills, ErrorSkill, herramientasSkills } from "../src/skills";
import { carpetaTemporal, contextoPrueba } from "./contexto-prueba";

let tmp: { dir: string; borrar(): Promise<void> };
let perfil: string;
let incluidas: string;
let cwd: string;
beforeEach(async () => {
  tmp = await carpetaTemporal("skills");
  perfil = join(tmp.dir, "perfil");
  incluidas = join(tmp.dir, "incluidas");
  cwd = join(tmp.dir, "repo");
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => tmp.borrar());

function skill(raiz: string, carpeta: string, texto: string, extra: Record<string, string> = {}): void {
  writeFileSync(join(mkdir(join(raiz, carpeta)), "SKILL.md"), texto);
  for (const [rel, contenido] of Object.entries(extra)) writeFileSync(join(mkdir(dirname(join(raiz, carpeta, rel))), rel.split("/").at(-1)!), contenido);
}

function mkdir(d: string): string {
  mkdirSync(d, { recursive: true });
  return d;
}

const md = (nombre: string, descripcion: string, cuerpo = "# Pasos\n1. Hacerlo.\n") => `---\nname: ${nombre}\ndescription: ${descripcion}\n---\n\n${cuerpo}`;

async function fallo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorSkill);
    return (e as Error).message;
  }
  throw new Error("no falló");
}

test("descubre skills en las cuatro raíces con precedencia proyecto > perfil > incluida", () => {
  skill(incluidas, "comun", md("comun", "versión incluida"));
  skill(incluidas, "solo-incluida", md("solo-incluida", "viene con Aquiles"));
  skill(join(perfil, "skills"), "comun", md("comun", "versión del perfil"));
  skill(join(perfil, "skills"), "del-perfil", md("del-perfil", "mía"), { "references/api.md": "API", "scripts/x.sh": "echo" });
  skill(join(cwd, ".claude", "skills"), "comun", md("comun", "versión de .claude"));
  skill(join(cwd, ".claude", "skills"), "de-claude", md("de-claude", "compatibilidad"));
  skill(join(cwd, ".aquiles", "skills"), "comun", md("comun", "versión de .aquiles"));

  const a = new AlmacenSkills({ perfil, incluidas });
  const todas = a.listar(cwd);
  expect(todas.map((s) => s.nombre)).toEqual(["comun", "de-claude", "del-perfil", "solo-incluida"]);
  const porNombre = Object.fromEntries(todas.map((s) => [s.nombre, s]));
  expect(porNombre.comun!.descripcion).toBe("versión de .aquiles");
  expect(porNombre.comun!.ubicacion).toBe("proyecto");
  expect(porNombre["de-claude"]!.ubicacion).toBe("proyecto");
  expect(porNombre["del-perfil"]).toMatchObject({ ubicacion: "perfil", origen: "manual", activa: true, usos: 0, ruta: join(perfil, "skills", "del-perfil") });
  expect(porNombre["solo-incluida"]).toMatchObject({ ubicacion: "incluida", origen: "incluida" });

  expect(a.listar().find((s) => s.nombre === "comun")!.descripcion).toBe("versión del perfil");
  expect(new AlmacenSkills({ perfil: null }).listar(cwd).map((s) => s.nombre)).toEqual(["comun", "de-claude"]);

  const leida = a.leer("del-perfil", cwd)!;
  expect(leida.contenido).toBe(md("del-perfil", "mía"));
  expect(leida.ficheros).toEqual(["references/api.md", "scripts/x.sh"]);
  expect(a.leerFichero("del-perfil", "references\\api.md")).toBe("API");
  expect(a.leerFichero("del-perfil", "references/no.md")).toBeUndefined();
  expect(() => a.leerFichero("del-perfil", "../comun/SKILL.md")).toThrow(ErrorSkill);
  expect(a.leer("no-existe")).toBeUndefined();
});

test("ignora frontmatter inválido y entiende comillas, bloques y claves extra", () => {
  const raiz = join(perfil, "skills");
  skill(raiz, "sin-frontmatter", "# Hola\n");
  skill(raiz, "sin-descripcion", "---\nname: sin-descripcion\n---\n");
  skill(raiz, "sin-cierre", "---\nname: sin-cierre\ndescription: x\n");
  skill(raiz, "nombre-raro", "---\nname: con espacios\ndescription: x\n---\n");
  skill(raiz, "vacia", "");
  mkdir(join(raiz, "sin-fichero"));
  skill(raiz, "comillas", "\uFEFF---\r\nname: \"comillas\"\r\ndescription: 'Usa ''esto'': sí'\r\nlicense: MIT\r\nmetadata:\r\n  autor: x\r\n---\r\nCuerpo\r\n");
  skill(raiz, "plegada", "---\nname: plegada\ndescription: >\n  Primera línea\n  y segunda.\nallowed-tools: [leer]\n---\n");
  skill(raiz, "continuada", "---\nname: continuada\ndescription: Empieza aquí\n  y sigue aquí.\n---\n");

  const a = new AlmacenSkills({ perfil });
  const s = Object.fromEntries(a.listar().map((x) => [x.nombre, x.descripcion]));
  expect(s).toEqual({ comillas: "Usa 'esto': sí", continuada: "Empieza aquí y sigue aquí.", plegada: "Primera línea y segunda." });
  expect(a.leer("comillas")!.contenido).toBe("---\nname: \"comillas\"\ndescription: 'Usa ''esto'': sí'\nlicense: MIT\nmetadata:\n  autor: x\n---\nCuerpo\n");
});

test("registro: ajustar y usos persisten en skills.json; el índice solo lleva las activas", () => {
  skill(join(perfil, "skills"), "uno", md("uno", "La primera\n  skill."));
  skill(join(perfil, "skills"), "dos", md("dos", "La segunda"));
  skill(join(cwd, ".aquiles", "skills"), "local", md("local", "Del repo"));
  const a = new AlmacenSkills({ perfil });

  const seccion = a.seccionPrompt(cwd);
  expect(seccion).toContain("ver_skill");
  expect(seccion).toContain("- uno — La primera skill.");
  expect(seccion).toContain("- local — Del repo");

  expect(a.ajustar("dos", false)).toMatchObject({ nombre: "dos", activa: false });
  a.registrarUso("uno");
  a.registrarUso("uno");
  expect(a.ajustar("local", false).activa).toBe(false); // encuentra la de proyecto por el último cwd consultado
  expect(() => a.ajustar("nada", true)).toThrow(ErrorSkill);

  const registro = JSON.parse(readFileSync(join(perfil, "skills.json"), "utf8"));
  expect(registro.dos).toEqual({ activa: false });
  expect(registro.uno.usos).toBe(2);

  const b = new AlmacenSkills({ perfil });
  const uno = b.listar().find((x) => x.nombre === "uno")!;
  expect(uno.usos).toBe(2);
  expect(uno.ultimoUso).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(b.listar().find((x) => x.nombre === "dos")!.activa).toBe(false);
  expect(b.seccionPrompt(cwd)).not.toContain("- dos");
  expect(b.seccionPrompt(cwd)).not.toContain("- local");
  b.ajustar("dos", false);
  b.ajustar("uno", false);
  expect(b.seccionPrompt(join(tmp.dir, "otra"))).toBe("");
});

test("ver_skill devuelve el contenido, cuenta un uso por sesión y abre ficheros de apoyo", async () => {
  skill(join(perfil, "skills"), "desplegar", md("desplegar", "Despliega"), { "references/pasos.md": "Paso 1\r\nPaso 2\r\n" });
  skill(join(perfil, "skills"), "apagada", md("apagada", "x"));
  const a = new AlmacenSkills({ perfil });
  a.ajustar("apagada", false);
  const [ver] = herramientasSkills(a);
  expect(ver!.nombre).toBe("ver_skill");
  expect(ver!.nivel).toBe("lectura");

  const ctx = contextoPrueba(cwd);
  const r = await ver!.ejecutar({ nombre: "desplegar" }, ctx);
  expect(r).toContain("# Pasos");
  expect(r).toContain("Ficheros de apoyo (ábrelos con ver_skill y fichero): references/pasos.md");
  expect(await ver!.ejecutar({ nombre: "desplegar", fichero: "references/pasos.md" }, ctx)).toBe("Paso 1\nPaso 2\n");
  await ver!.ejecutar({ nombre: "desplegar" }, ctx);
  expect(a.leer("desplegar")!.usos).toBe(1);
  expect(ctx.estado.has("skills.vistas")).toBe(true);

  await ver!.ejecutar({ nombre: "desplegar" }, contextoPrueba(cwd));
  expect(a.leer("desplegar")!.usos).toBe(2);

  expect(await fallo(ver!.ejecutar({ nombre: "otra" }, ctx))).toContain("Disponibles: desplegar");
  expect(await fallo(ver!.ejecutar({ nombre: "apagada" }, ctx))).toContain("desactivada");
  expect(await fallo(ver!.ejecutar({ nombre: "desplegar", fichero: "references/no.md" }, ctx))).toContain("no tiene references/no.md");
  expect(await fallo(ver!.ejecutar({ nombre: "desplegar", fichero: "../../skills.json" }, ctx))).toContain("Ruta no válida");
});

test("gestionar_skill crea skills aprendidas en el perfil y valida nombre y frontmatter", async () => {
  skill(incluidas, "incluida", md("incluida", "x"));
  const a = new AlmacenSkills({ perfil, incluidas });
  let avisos = 0;
  const [, gestionar] = herramientasSkills(a, () => avisos++);
  expect(gestionar!.nivel).toBe("escritura");
  const ctx = contextoPrueba(cwd);

  const r = await gestionar!.ejecutar({ accion: "crear", nombre: "migrar-esquemas-sqlite", contenido: md("migrar-esquemas-sqlite", "Migra esquemas") }, ctx);
  expect(r).toContain("Creada la skill «migrar-esquemas-sqlite»");
  expect(avisos).toBe(1);
  expect(readFileSync(join(perfil, "skills", "migrar-esquemas-sqlite", "SKILL.md"), "utf8")).toBe(md("migrar-esquemas-sqlite", "Migra esquemas"));
  const info = a.leer("migrar-esquemas-sqlite")!;
  expect(info).toMatchObject({ origen: "aprendida", ubicacion: "perfil", activa: true, usos: 0 });
  expect(info.creada).toMatch(/^\d{4}-/);

  expect(await fallo(gestionar!.ejecutar({ accion: "crear", nombre: "Arreglar Bug", contenido: md("Arreglar Bug", "x") }, ctx))).toContain("kebab-case");
  expect(await fallo(gestionar!.ejecutar({ accion: "crear", nombre: "otra", contenido: "# sin frontmatter" }, ctx))).toContain("frontmatter");
  expect(await fallo(gestionar!.ejecutar({ accion: "crear", nombre: "otra", contenido: md("distinta", "x") }, ctx))).toContain("name: otra");
  expect(await fallo(gestionar!.ejecutar({ accion: "crear", nombre: "otra", contenido: "---\nname: otra\n---\n" }, ctx))).toContain("description");
  expect(await fallo(gestionar!.ejecutar({ accion: "crear", nombre: "otra" }, ctx))).toContain("necesita contenido");
  expect(await fallo(gestionar!.ejecutar({ accion: "crear", nombre: "incluida", contenido: md("incluida", "x") }, ctx))).toContain("Ya existe");
  expect(await fallo(gestionar!.ejecutar({ accion: "crear", nombre: "migrar-esquemas-sqlite", contenido: md("migrar-esquemas-sqlite", "x") }, ctx))).toContain(
    "Ya existe",
  );
  expect(existsSync(join(perfil, "skills", "otra"))).toBe(false);
  expect(avisos).toBe(1);

  const sinPerfil = herramientasSkills(new AlmacenSkills({ perfil: null }))[1]!;
  expect(await fallo(sinPerfil.ejecutar({ accion: "crear", nombre: "x", contenido: md("x", "y") }, ctx))).toContain("No hay perfil");
});

test("gestionar_skill: leer antes de escribir y nunca fuera de la carpeta de la skill", async () => {
  skill(join(perfil, "skills"), "publicar", md("publicar", "Publica", "Paso uno.\r\nPaso dos.\r\nPaso dos.\r\n"), { "references/notas.md": "viejo" });
  skill(join(cwd, ".aquiles", "skills"), "del-repo", md("del-repo", "x"));
  skill(incluidas, "incluida", md("incluida", "x"));
  const a = new AlmacenSkills({ perfil, incluidas });
  const [ver, gestionar] = herramientasSkills(a);
  const ctx = contextoPrueba(cwd);
  const parche = { accion: "parchear" as const, nombre: "publicar", buscar: "Paso uno.", reemplazar: "Paso 1." };

  expect(await fallo(gestionar!.ejecutar(parche, ctx))).toContain("No has visto publicar/SKILL.md");
  await ver!.ejecutar({ nombre: "publicar" }, ctx);
  expect(await fallo(gestionar!.ejecutar({ ...parche, buscar: "Paso dos." }, ctx))).toContain("aparece 2 veces");
  expect(await fallo(gestionar!.ejecutar({ ...parche, buscar: "Paso tres." }, ctx))).toContain("No encuentro");
  expect(await fallo(gestionar!.ejecutar({ ...parche, reemplazar: undefined }, ctx))).toContain("necesita reemplazar");
  expect(await gestionar!.ejecutar(parche, ctx)).toBe("Parcheada la skill «publicar» (SKILL.md).");
  const ruta = join(perfil, "skills", "publicar", "SKILL.md");
  expect(readFileSync(ruta, "utf8")).toContain("Paso 1.\r\nPaso dos.\r\n");
  await gestionar!.ejecutar({ ...parche, buscar: "Paso 1.", reemplazar: "Paso uno." }, ctx);
  expect(await fallo(gestionar!.ejecutar({ ...parche, buscar: "name: publicar", reemplazar: "name: otra" }, ctx))).toContain("name: publicar");

  writeFileSync(ruta, md("publicar", "Publica", "Cambiado por fuera.\n"));
  expect(await fallo(gestionar!.ejecutar({ ...parche, buscar: "Cambiado" }, ctx))).toContain("ha cambiado desde que lo viste");

  const escribir = { accion: "escribir_fichero" as const, nombre: "publicar", contenido: "nuevo" };
  expect(await gestionar!.ejecutar({ ...escribir, fichero: "templates/plantilla.md" }, ctx)).toContain("Creado templates/plantilla.md");
  expect(readFileSync(join(perfil, "skills", "publicar", "templates", "plantilla.md"), "utf8")).toBe("nuevo");
  expect(await gestionar!.ejecutar({ ...escribir, fichero: "templates/plantilla.md", contenido: "otra vez" }, ctx)).toContain("Sustituido");
  expect(await fallo(gestionar!.ejecutar({ ...escribir, fichero: "references/notas.md" }, ctx))).toContain("No has visto publicar/references/notas.md");
  await ver!.ejecutar({ nombre: "publicar", fichero: "references/notas.md" }, ctx);
  await gestionar!.ejecutar({ ...escribir, fichero: "references/notas.md" }, ctx);
  expect(readFileSync(join(perfil, "skills", "publicar", "references", "notas.md"), "utf8")).toBe("nuevo");
  await gestionar!.ejecutar({ accion: "parchear", nombre: "publicar", fichero: "references/notas.md", buscar: "nuevo", reemplazar: "parcheado" }, ctx);
  expect(readFileSync(join(perfil, "skills", "publicar", "references", "notas.md"), "utf8")).toBe("parcheado");

  for (const fichero of ["../fuera.md", "references/../../fuera.md", "C:\\fuera.md", "/etc/x", "otra/x.md", "references", "references/x.md:ads", "SKILL.md", ""]) {
    const m = await fallo(gestionar!.ejecutar({ ...escribir, fichero }, ctx));
    expect(m, fichero).toMatch(/Ruta no válida|necesita 'fichero'/);
  }
  expect(existsSync(join(perfil, "skills", "fuera.md"))).toBe(false);
  expect(existsSync(join(perfil, "fuera.md"))).toBe(false);

  await ver!.ejecutar({ nombre: "del-repo" }, ctx);
  expect(await fallo(gestionar!.ejecutar({ accion: "parchear", nombre: "del-repo", buscar: "x", reemplazar: "y" }, ctx))).toContain("del proyecto");
  await ver!.ejecutar({ nombre: "incluida" }, ctx);
  expect(await fallo(gestionar!.ejecutar({ ...escribir, nombre: "incluida", fichero: "references/a.md" }, ctx))).toContain("incluidas");
  expect(await fallo(gestionar!.ejecutar({ ...escribir, nombre: "no-existe", fichero: "references/a.md" }, ctx))).toContain("créala antes");
});
