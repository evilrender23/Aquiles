import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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

const DIA = 86_400_000;
const haceDias = (n: number, desde = Date.now()) => new Date(desde - n * DIA).toISOString();

/** Cambia a mano el registro (skills.json) del perfil. */
function tocarRegistro(cambio: (r: Record<string, Record<string, unknown>>) => void): void {
  const ruta = join(perfil, "skills.json");
  const r = existsSync(ruta) ? JSON.parse(readFileSync(ruta, "utf8")) : {};
  cambio(r);
  writeFileSync(ruta, JSON.stringify(r));
}

test("vigencia y curador: obsoleta a los 14 días, archivada a los 30, solo aprendidas no fijadas", async () => {
  skill(incluidas, "incluida", md("incluida", "x"));
  skill(join(cwd, ".aquiles", "skills"), "del-repo", md("del-repo", "x"));
  skill(join(perfil, "skills"), "manual-vieja", md("manual-vieja", "puesta a mano"));
  const a = new AlmacenSkills({ perfil, incluidas });
  for (const n of ["vieja", "media", "nueva", "fijada-vieja", "sin-fechas", "usada"]) a.crear(n, md(n, `skill ${n}`));
  tocarRegistro((r) => {
    r.vieja!.creada = haceDias(40);
    r.media!.creada = haceDias(20);
    r.nueva!.creada = haceDias(3);
    r["fijada-vieja"]!.creada = haceDias(90);
    r["fijada-vieja"]!.fijada = true;
    delete r["sin-fechas"]!.creada;
    r.usada!.creada = haceDias(60);
    r.usada!.ultimoUso = haceDias(2);
    r["manual-vieja"] = { ultimoUso: haceDias(100) };
    r["del-repo"] = { fijada: true, obsoleta: true };
    r.incluida = { fijada: true, obsoleta: true };
  });
  const antiguo = (Date.now() - 20 * DIA) / 1000;
  utimesSync(join(perfil, "skills", "sin-fechas", "SKILL.md"), antiguo, antiguo);

  const inicial = a.listar(cwd);
  expect(inicial.every((s) => s.vigencia === "vigente")).toBe(true);
  expect(inicial.find((s) => s.nombre === "fijada-vieja")!.fijada).toBe(true);
  expect(inicial.find((s) => s.nombre === "del-repo")).toMatchObject({ vigencia: "vigente", fijada: false });
  expect(inicial.find((s) => s.nombre === "incluida")).toMatchObject({ vigencia: "vigente", fijada: false });

  const cambios = a.curar();
  expect(cambios.sort((x, y) => x.nombre.localeCompare(y.nombre))).toEqual([
    { nombre: "media", antes: "vigente", despues: "obsoleta" },
    { nombre: "sin-fechas", antes: "vigente", despues: "obsoleta" },
    { nombre: "vieja", antes: "vigente", despues: "archivada" },
  ]);
  expect(a.curar()).toEqual([]);
  expect(existsSync(join(perfil, "skills", "vieja"))).toBe(false);
  expect(readFileSync(join(perfil, "skills-archivadas", "vieja", "SKILL.md"), "utf8")).toBe(md("vieja", "skill vieja"));

  const vigencias = Object.fromEntries(a.listar(cwd).map((s) => [s.nombre, s.vigencia]));
  expect(vigencias).toEqual({
    "del-repo": "vigente", "fijada-vieja": "vigente", incluida: "vigente", "manual-vieja": "vigente",
    media: "obsoleta", nueva: "vigente", "sin-fechas": "obsoleta", usada: "vigente",
  });
  const conArchivadas = a.listar(cwd, { archivadas: true });
  expect(conArchivadas.find((s) => s.nombre === "vieja")).toMatchObject({ vigencia: "archivada", ruta: join(perfil, "skills-archivadas", "vieja") });
  expect(a.seccionPrompt(cwd)).not.toContain("- vieja");
  expect(a.seccionPrompt(cwd)).toContain("- media");
  expect(a.leer("vieja")).toBeUndefined();
  expect(a.leer("vieja", undefined, { archivadas: true })!.contenido).toBe(md("vieja", "skill vieja"));

  const [ver] = herramientasSkills(a);
  expect(await fallo(ver!.ejecutar({ nombre: "vieja" }, contextoPrueba(cwd)))).toContain("No existe la skill «vieja»");
  await ver!.ejecutar({ nombre: "media" }, contextoPrueba(cwd));
  expect(a.leer("media")!.vigencia).toBe("vigente");

  // Con un `ahora` inventado: dentro de 31 días se archivaría también la nueva.
  const futuro = a.curar(new Date(Date.now() + 31 * DIA));
  expect(futuro.map((c) => c.nombre).sort()).toEqual(["media", "nueva", "sin-fechas", "usada"]);
  expect(futuro.every((c) => c.despues === "archivada")).toBe(true);
  expect(existsSync(join(perfil, "skills", "manual-vieja"))).toBe(true);
  expect(existsSync(join(perfil, "skills", "fijada-vieja"))).toBe(true);
  expect(new AlmacenSkills({ perfil: null }).curar()).toEqual([]);
});

test("fijar, archivar y restaurar solo en skills del perfil y sin borrar nada", () => {
  skill(incluidas, "incluida", md("incluida", "x"));
  const a = new AlmacenSkills({ perfil, incluidas });
  a.crear("guia", md("guia", "Guía"));
  a.escribir("guia", "references/notas.md", "notas");
  tocarRegistro((r) => {
    r.guia!.creada = haceDias(20);
  });
  a.curar();
  expect(a.leer("guia")!.vigencia).toBe("obsoleta");

  expect(a.fijar("guia", true)).toMatchObject({ fijada: true, vigencia: "vigente" });
  tocarRegistro((r) => {
    r.guia!.creada = haceDias(45);
  });
  expect(a.curar()).toEqual([]);
  expect(a.fijar("guia", false)).toMatchObject({ fijada: false });
  expect(() => a.fijar("incluida", true)).toThrow(/incluidas/);
  expect(() => a.fijar("no-hay", true)).toThrow(/No existe la skill «no-hay» en el perfil/);

  const archivada = a.archivar("guia");
  expect(archivada).toMatchObject({ vigencia: "archivada", ruta: join(perfil, "skills-archivadas", "guia") });
  expect(readFileSync(join(perfil, "skills-archivadas", "guia", "references", "notas.md"), "utf8")).toBe("notas");
  expect(() => a.archivar("guia")).toThrow(/está archivada/);
  expect(() => a.archivar("incluida")).toThrow(ErrorSkill);
  expect(a.fijar("guia", true).vigencia).toBe("archivada");
  a.fijar("guia", false);
  expect(() => a.crear("guia", md("guia", "otra"))).toThrow(/archivada/);
  expect(() => a.aplicarFicheros("guia", [{ ruta: "SKILL.md", contenido: md("guia", "otra") }], { motivo: "propuesta" })).toThrow(/archivada/);

  const restaurada = a.restaurar("guia");
  expect(restaurada).toMatchObject({ vigencia: "vigente", ruta: join(perfil, "skills", "guia"), origen: "aprendida" });
  expect(readFileSync(join(perfil, "skills", "guia", "references", "notas.md"), "utf8")).toBe("notas");
  expect(existsSync(join(perfil, "skills-archivadas", "guia"))).toBe(false);
  expect(a.curar()).toEqual([]); // la restauración cuenta como actividad aunque se creó hace 45 días
  expect(() => a.restaurar("guia")).toThrow(/No hay ninguna skill archivada/);

  a.archivar("guia");
  skill(join(perfil, "skills"), "guia", md("guia", "puesta a mano mientras tanto"));
  expect(() => a.restaurar("guia")).toThrow(/Ya hay una skill «guia»/);
  expect(existsSync(join(perfil, "skills-archivadas", "guia", "SKILL.md"))).toBe(true);
});

test("copias antes de cada cambio y restaurarVersion", async () => {
  const a = new AlmacenSkills({ perfil });
  const [ver, gestionar] = herramientasSkills(a);
  const ctx = contextoPrueba(cwd);
  const original = md("pasos", "Pasos", "Uno.\nDos.\n");
  await gestionar!.ejecutar({ accion: "crear", nombre: "pasos", contenido: original }, ctx);
  expect(a.versiones("pasos")).toEqual([]);
  expect(existsSync(join(perfil, "skills-copias"))).toBe(false);

  await gestionar!.ejecutar({ accion: "parchear", nombre: "pasos", buscar: "Uno.", reemplazar: "Primero." }, ctx);
  await gestionar!.ejecutar({ accion: "escribir_fichero", nombre: "pasos", fichero: "scripts/x.sh", contenido: "echo 1" }, ctx);
  await ver!.ejecutar({ nombre: "pasos", fichero: "scripts/x.sh" }, ctx);
  await gestionar!.ejecutar({ accion: "escribir_fichero", nombre: "pasos", fichero: "scripts/x.sh", contenido: "echo 1" }, ctx); // igual: sin copia
  a.escribir("pasos", "SKILL.md", readFileSync(join(perfil, "skills", "pasos", "SKILL.md"), "utf8")); // igual: sin copia

  const versiones = a.versiones("pasos");
  expect(versiones.map((v) => v.motivo)).toEqual(["escribir", "parchear"]);
  expect(versiones[0]!.ficheros).toEqual(["SKILL.md"]);
  expect(versiones[0]!.id).toMatch(/^\d{8}T\d{9}Z(?:-\d+)?$/);
  expect(versiones[0]!.id > versiones[1]!.id).toBe(true);
  expect(versiones[1]!.fecha).toMatch(/^\d{4}-\d\d-\d\dT/);
  const dirPrimera = join(perfil, "skills-copias", "pasos", versiones[1]!.id);
  expect(readFileSync(join(dirPrimera, "SKILL.md"), "utf8")).toBe(original);
  expect(JSON.parse(readFileSync(join(dirPrimera, "meta.json"), "utf8"))).toMatchObject({ motivo: "parchear" });

  const info = a.restaurarVersion("pasos", versiones[1]!.id);
  expect(info.nombre).toBe("pasos");
  expect(readFileSync(join(perfil, "skills", "pasos", "SKILL.md"), "utf8")).toBe(original);
  expect(existsSync(join(perfil, "skills", "pasos", "scripts", "x.sh"))).toBe(false);
  const despues = a.versiones("pasos");
  expect(despues).toHaveLength(3);
  expect(despues[0]).toMatchObject({ motivo: "restaurar", ficheros: ["SKILL.md", "scripts/x.sh"] });
  expect(readFileSync(join(perfil, "skills-copias", "pasos", despues[0]!.id, "scripts", "x.sh"), "utf8")).toBe("echo 1");

  // La sesión vio otra versión: parchear exige volver a mirarla.
  expect(await fallo(gestionar!.ejecutar({ accion: "parchear", nombre: "pasos", buscar: "Uno.", reemplazar: "1." }, ctx))).toContain("ha cambiado");
  expect(() => a.restaurarVersion("pasos", "no-existe")).toThrow(/No existe la versión/);
  expect(() => a.restaurarVersion("pasos", "../../skills")).toThrow(/No existe la versión/);
  expect(() => a.restaurarVersion("otra", versiones[1]!.id)).toThrow(ErrorSkill);
  expect(a.versiones("../pasos")).toEqual([]);
});

test("aplicarFicheros crea skills nuevas, copia antes de cambiar las que hay y conserva BOM y CRLF", () => {
  const a = new AlmacenSkills({ perfil });
  const nueva = a.aplicarFicheros(
    "revisar-prs",
    [{ ruta: "SKILL.md", contenido: md("revisar-prs", "Revisa PRs") }, { ruta: "references\\checklist.md", contenido: "- tests" }],
    { motivo: "propuesta" },
  );
  expect(nueva).toMatchObject({ nombre: "revisar-prs", origen: "aprendida", ubicacion: "perfil", vigencia: "vigente", usos: 0 });
  expect(nueva.creada).toBeDefined();
  expect(readFileSync(join(perfil, "skills", "revisar-prs", "references", "checklist.md"), "utf8")).toBe("- tests");
  expect(a.versiones("revisar-prs")).toEqual([]);

  expect(() => a.aplicarFicheros("sin-skill", [{ ruta: "references/a.md", contenido: "x" }], { motivo: "propuesta" })).toThrow(/hace falta SKILL.md/);
  expect(() => a.aplicarFicheros("Mal Nombre", [{ ruta: "SKILL.md", contenido: md("Mal Nombre", "x") }], { motivo: "propuesta" })).toThrow(/kebab-case/);
  expect(() => a.aplicarFicheros("revisar-prs", [], { motivo: "propuesta" })).toThrow(ErrorSkill);

  skill(join(perfil, "skills"), "a-mano", `﻿${md("a-mano", "Puesta a mano", "Uno.\nDos.\n").replace(/\n/g, "\r\n")}`);
  const antes = readFileSync(join(perfil, "skills", "a-mano", "SKILL.md"));
  expect(() =>
    a.aplicarFicheros("a-mano", [{ ruta: "SKILL.md", contenido: md("otro-nombre", "x") }], { motivo: "propuesta" }),
  ).toThrow(/name: a-mano/);
  expect(() =>
    a.aplicarFicheros("a-mano", [{ ruta: "references/a.md", contenido: "x" }, { ruta: "../fuera.md", contenido: "x" }], { motivo: "propuesta" }),
  ).toThrow(/Ruta no válida/);
  expect(existsSync(join(perfil, "skills", "a-mano", "references"))).toBe(false);
  expect(a.versiones("a-mano")).toEqual([]);

  const info = a.aplicarFicheros(
    "a-mano",
    [{ ruta: "SKILL.md", contenido: md("a-mano", "Puesta a mano", "Uno.\nDos.\nTres.\n") }, { ruta: "templates/t.md", contenido: "plantilla" }],
    { motivo: "propuesta" },
  );
  expect(info.origen).toBe("manual");
  const ahora = readFileSync(join(perfil, "skills", "a-mano", "SKILL.md"));
  expect([...ahora.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(ahora.toString("utf8")).toContain("Dos.\r\nTres.\r\n");
  const versiones = a.versiones("a-mano");
  expect(versiones).toHaveLength(1);
  expect(versiones[0]!.motivo).toBe("propuesta");
  expect(readFileSync(join(perfil, "skills-copias", "a-mano", versiones[0]!.id, "SKILL.md")).equals(antes)).toBe(true);

  a.aplicarFicheros("a-mano", [{ ruta: "templates/t.md", contenido: "plantilla" }], { motivo: "propuesta" });
  expect(a.versiones("a-mano")).toHaveLength(1);
  expect(readdirSync(join(perfil, "skills-copias", "a-mano"))).toHaveLength(1);
});

test("alCambiar recibe el detalle de cada cambio con la sesión", async () => {
  const a = new AlmacenSkills({ perfil });
  const detalles: unknown[] = [];
  const [ver, gestionar] = herramientasSkills(a, (d) => detalles.push(d));
  const ctx = contextoPrueba(cwd);
  await gestionar!.ejecutar({ accion: "crear", nombre: "uno", contenido: md("uno", "x") }, ctx);
  await gestionar!.ejecutar({ accion: "parchear", nombre: "uno", buscar: "Hacerlo.", reemplazar: "Hacerlo bien." }, ctx);
  await gestionar!.ejecutar({ accion: "escribir_fichero", nombre: "uno", fichero: "references\\a.md", contenido: "a" }, ctx);
  await ver!.ejecutar({ nombre: "uno" }, ctx);
  expect(detalles).toEqual([
    { sesionId: "prueba", accion: "crear", nombre: "uno", fichero: "SKILL.md" },
    { sesionId: "prueba", accion: "parchear", nombre: "uno", fichero: "SKILL.md" },
    { sesionId: "prueba", accion: "escribir_fichero", nombre: "uno", fichero: "references/a.md" },
  ]);
});
