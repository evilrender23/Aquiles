/**
 * Skills en formato SKILL.md (frontmatter YAML con name y description) en <raíz>/<nombre>/SKILL.md, con ficheros
 * de apoyo opcionales en references/, templates/ y scripts/. Raíces, de más a menos precedencia: proyecto
 * (<cwd>/.aquiles/skills y <cwd>/.claude/skills), perfil (<perfil>/skills) e incluidas.
 * Registro por nombre en <perfil>/skills.json: origen, activa, usos, ultimoUso y creada.
 */
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, type Stats, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { InfoSkill } from "@aquiles/protocolo";
import { z } from "zod";
import { dentroDe } from "./aprobaciones";
import { codificar, decodificar, esBinario } from "./herramientas/ficheros";
import { definir, ErrorHerramienta, type ContextoHerramienta, type Herramienta } from "./herramientas/herramienta";

export class ErrorSkill extends ErrorHerramienta {}

const DIRECTORIOS_APOYO = ["references", "templates", "scripts"] as const;
const MAX_SKILL = 60_000;
const MAX_FICHERO = 200_000;
const MAX_DESCRIPCION_INDICE = 300;

interface Registro {
  origen?: InfoSkill["origen"];
  activa?: boolean;
  usos?: number;
  ultimoUso?: string;
  creada?: string;
}

interface Encontrada {
  nombre: string;
  descripcion: string;
  dir: string;
  ubicacion: InfoSkill["ubicacion"];
}

export class AlmacenSkills {
  private readonly perfil: string | null;
  private readonly incluidas: string | null;
  private registroEnMemoria: Record<string, Registro> = {};
  /** Última carpeta consultada: `ajustar` la usa para encontrar skills de proyecto cuando no se le pasa cwd. */
  private ultimoCwd?: string;

  constructor(o: { perfil: string | null; incluidas?: string | null }) {
    this.perfil = o.perfil;
    this.incluidas = o.incluidas ?? null;
  }

  listar(cwd?: string): InfoSkill[] {
    if (cwd) this.ultimoCwd = cwd;
    const reg = this.registro();
    return [...this.descubrir(cwd).values()].map((e) => this.info(e, reg)).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  leer(nombre: string, cwd?: string): (InfoSkill & { contenido: string; ficheros: string[] }) | undefined {
    if (cwd) this.ultimoCwd = cwd;
    const e = this.descubrir(cwd).get(nombre);
    if (!e) return undefined;
    const contenido = leerTexto(join(e.dir, "SKILL.md"));
    if (contenido === undefined) return undefined;
    return { ...this.info(e, this.registro()), contenido, ficheros: listarApoyo(e.dir).ficheros };
  }

  /** Texto de un fichero de la skill (ruta relativa a su carpeta), o undefined si no existe. */
  leerFichero(nombre: string, rel: string, cwd?: string): string | undefined {
    const e = this.descubrir(cwd).get(nombre);
    if (!e) return undefined;
    const abs = rutaDentro(e.dir, rel, true);
    let info: Stats;
    try {
      info = statSync(abs);
    } catch {
      return undefined;
    }
    if (!info.isFile()) return undefined;
    if (info.size > MAX_FICHERO * 4) throw new ErrorSkill(`${rel} es demasiado grande (${info.size} bytes).`);
    const bytes = readFileSync(abs);
    if (esBinario(bytes)) throw new ErrorSkill(`${rel} parece binario.`);
    return decodificar(bytes).texto.replace(/\r\n/g, "\n");
  }

  ajustar(nombre: string, activa: boolean, cwd?: string): InfoSkill {
    const e = this.descubrir(cwd ?? this.ultimoCwd).get(nombre);
    if (!e) throw new ErrorSkill(`No existe la skill «${nombre}».`);
    const reg = this.actualizar(nombre, (r) => {
      r.activa = activa;
    });
    return this.info(e, reg);
  }

  registrarUso(nombre: string): void {
    this.actualizar(nombre, (r) => {
      r.usos = (r.usos ?? 0) + 1;
      r.ultimoUso = new Date().toISOString();
    });
  }

  /** Índice de las skills activas para el system prompt; "" si no hay ninguna. */
  seccionPrompt(cwd: string): string {
    const activas = this.listar(cwd).filter((s) => s.activa);
    if (!activas.length) return "";
    return [
      "## Skills",
      "Instrucciones guardadas para clases de tarea. Antes de empezar una tarea que encaje con alguna, cárgala con ver_skill y síguela.",
      ...activas.map((s) => `- ${s.nombre} — ${recortar(s.descripcion.replace(/\s+/g, " "), MAX_DESCRIPCION_INDICE)}`),
    ].join("\n");
  }

  /** Crea una skill en el perfil como aprendida. `contenido` es el SKILL.md completo. */
  crear(nombre: string, contenido: string, cwd?: string): InfoSkill {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nombre) || nombre.length > 64) {
      throw new ErrorSkill(
        `Nombre no válido: «${nombre}». Usa kebab-case (minúsculas, cifras y guiones, hasta 64) y nombra una clase de tarea, ` +
          "p. ej. migrar-esquemas-sqlite, no la tarea concreta de hoy.",
      );
    }
    const raiz = this.raizPerfil();
    const existente = this.descubrir(cwd).get(nombre);
    if (existente) {
      throw new ErrorSkill(`Ya existe una skill «${nombre}» (${existente.ubicacion}, ${existente.dir}); amplíala con parchear o usa otro nombre.`);
    }
    const texto = validarSkill(contenido, nombre);
    const dir = join(raiz, nombre);
    if (existsSync(join(dir, "SKILL.md"))) throw new ErrorSkill(`Ya existe ${join(dir, "SKILL.md")}; amplíala con parchear.`);
    mkdirSync(dir, { recursive: true });
    escribirAtomico(join(dir, "SKILL.md"), texto);
    const ahora = new Date().toISOString();
    const reg = this.actualizar(nombre, (r) => {
      r.origen = "aprendida";
      r.activa = true;
      r.usos = 0;
      r.creada = ahora;
      delete r.ultimoUso;
    });
    return this.info({ nombre, descripcion: frontmatter(texto)!.description!.trim(), dir, ubicacion: "perfil" }, reg);
  }

  /**
   * Escribe SKILL.md o un fichero de apoyo de una skill del perfil (las de proyecto e incluidas no se tocan).
   * Conserva BOM y finales CRLF si el fichero ya los tenía.
   */
  escribir(nombre: string, rel: string, contenido: string, cwd?: string): void {
    const e = this.descubrir(cwd).get(nombre);
    if (!e) throw new ErrorSkill(`No existe la skill «${nombre}».`);
    if (e.ubicacion !== "perfil") {
      throw new ErrorSkill(
        `La skill «${nombre}» es ${e.ubicacion === "incluida" ? "una de las incluidas con Aquiles" : `del proyecto (${e.dir})`} ` +
          "y aquí solo se cambian las del perfil." + (e.ubicacion === "proyecto" ? " Si hace falta, edita el fichero con editar." : ""),
      );
    }
    const esSkill = normalizarRel(rel) === "SKILL.md";
    const abs = rutaDentro(e.dir, rel, esSkill);
    let texto = contenido.replace(/\r\n/g, "\n");
    if (esSkill) texto = validarSkill(texto, nombre);
    else if (texto.length > MAX_FICHERO) throw new ErrorSkill(`El fichero es demasiado largo (${texto.length} caracteres; máximo ${MAX_FICHERO}).`);
    let previo: ReturnType<typeof decodificar> | undefined;
    try {
      previo = decodificar(readFileSync(abs));
    } catch {}
    if (previo?.crlf) texto = texto.replace(/\n/g, "\r\n");
    mkdirSync(dirname(abs), { recursive: true });
    escribirAtomico(abs, codificar(texto, previo?.bom ?? false));
  }

  private raizPerfil(): string {
    if (!this.perfil) throw new ErrorSkill("No hay perfil donde guardar skills.");
    return join(this.perfil, "skills");
  }

  private raices(cwd?: string): { dir: string; ubicacion: InfoSkill["ubicacion"] }[] {
    const r: { dir: string; ubicacion: InfoSkill["ubicacion"] }[] = [];
    if (cwd) r.push({ dir: join(cwd, ".aquiles", "skills"), ubicacion: "proyecto" }, { dir: join(cwd, ".claude", "skills"), ubicacion: "proyecto" });
    if (this.perfil) r.push({ dir: join(this.perfil, "skills"), ubicacion: "perfil" });
    if (this.incluidas) r.push({ dir: this.incluidas, ubicacion: "incluida" });
    return r;
  }

  /** Skills por nombre; la primera raíz que tiene un nombre gana. */
  private descubrir(cwd?: string): Map<string, Encontrada> {
    const vistas = new Map<string, Encontrada>();
    for (const { dir: raiz, ubicacion } of this.raices(cwd)) {
      let carpetas: string[];
      try {
        carpetas = readdirSync(raiz, { withFileTypes: true })
          .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
          .map((d) => d.name)
          .sort();
      } catch {
        continue;
      }
      for (const carpeta of carpetas) {
        const dir = join(raiz, carpeta);
        const texto = leerTexto(join(dir, "SKILL.md"));
        const datos = texto === undefined ? undefined : frontmatter(texto);
        const nombre = datos?.name?.trim();
        const descripcion = datos?.description?.trim();
        if (!nombre || !descripcion || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,63}$/u.test(nombre) || vistas.has(nombre)) continue;
        vistas.set(nombre, { nombre, descripcion, dir, ubicacion });
      }
    }
    return vistas;
  }

  private info(e: Encontrada, reg: Record<string, Registro>): InfoSkill {
    const r = reg[e.nombre] ?? {};
    return {
      nombre: e.nombre,
      descripcion: e.descripcion,
      origen: e.ubicacion === "incluida" ? "incluida" : r.origen === "aprendida" ? "aprendida" : "manual",
      ubicacion: e.ubicacion,
      ruta: e.dir,
      activa: r.activa ?? true,
      usos: r.usos ?? 0,
      ...(r.ultimoUso ? { ultimoUso: r.ultimoUso } : {}),
      ...(r.creada ? { creada: r.creada } : {}),
      actualizada: listarApoyo(e.dir).actualizada,
    };
  }

  private registro(): Record<string, Registro> {
    if (!this.perfil) return structuredClone(this.registroEnMemoria);
    try {
      const datos = JSON.parse(readFileSync(join(this.perfil, "skills.json"), "utf8"));
      return datos && typeof datos === "object" && !Array.isArray(datos) ? datos : {};
    } catch {
      return {};
    }
  }

  private actualizar(nombre: string, cambio: (r: Registro) => void): Record<string, Registro> {
    const reg = this.registro();
    const r = reg[nombre] ?? {};
    cambio(r);
    reg[nombre] = r;
    if (!this.perfil) this.registroEnMemoria = reg;
    else {
      mkdirSync(this.perfil, { recursive: true });
      escribirAtomico(join(this.perfil, "skills.json"), `${JSON.stringify(reg, null, 2)}\n`);
    }
    return reg;
  }
}

/**
 * Frontmatter YAML sencillo: `clave: valor` (con o sin comillas), bloques `>` y `|`, y continuaciones sangradas.
 * Las claves anidadas se leen como texto de la clave padre y se ignoran.
 */
function frontmatter(texto: string): Record<string, string> | undefined {
  const lineas = texto.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lineas[0]?.trimEnd() !== "---") return undefined;
  const fin = lineas.findIndex((l, i) => i > 0 && (l.trimEnd() === "---" || l.trimEnd() === "..."));
  if (fin === -1) return undefined;
  const datos: Record<string, string> = {};
  let clave: string | undefined;
  let estilo = "";
  let valores: string[] = [];
  const cerrar = () => {
    if (clave) datos[clave] = (estilo === "|" ? valores.join("\n") : valores.filter(Boolean).join(" ")).trim();
  };
  for (const l of lineas.slice(1, fin)) {
    const m = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(l);
    if (m) {
      cerrar();
      clave = m[1]!;
      const v = (m[2] ?? "").trim();
      estilo = /^[>|][+-]?$/.test(v) ? v[0]! : "";
      valores = estilo || !v ? [] : [sinComillas(v)];
    } else if (clave && (/^\s/.test(l) || !l.trim())) valores.push(l.trim());
  }
  cerrar();
  return datos;
}

function sinComillas(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Comprueba un SKILL.md antes de guardarlo; devuelve el texto con finales LF. */
function validarSkill(contenido: string, nombre: string): string {
  const texto = contenido.replace(/\r\n/g, "\n");
  if (texto.length > MAX_SKILL) throw new ErrorSkill(`SKILL.md es demasiado largo (${texto.length} caracteres; máximo ${MAX_SKILL}). Pasa el detalle a references/.`);
  const datos = frontmatter(texto);
  const ejemplo = `---\nname: ${nombre}\ndescription: Qué hace y cuándo usarla.\n---\n\n# …`;
  if (!datos) throw new ErrorSkill(`SKILL.md debe empezar con el frontmatter entre líneas «---», así:\n${ejemplo}`);
  if (datos.name?.trim() !== nombre) throw new ErrorSkill(`El frontmatter debe tener name: ${nombre} (tiene «${datos.name ?? ""}»).`);
  const descripcion = datos.description?.trim();
  if (!descripcion) throw new ErrorSkill(`Falta description en el frontmatter: qué hace la skill y cuándo usarla. Ejemplo:\n${ejemplo}`);
  if (descripcion.length > 1024) throw new ErrorSkill("La description no puede pasar de 1024 caracteres.");
  return texto;
}

function normalizarRel(rel: string): string {
  return rel.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

/** Ruta absoluta de un fichero de la skill; solo SKILL.md (si se permite) o bajo references/, templates/ o scripts/. */
function rutaDentro(dir: string, rel: string, permitirSkill: boolean): string {
  const r = normalizarRel(rel);
  const partes = r.split("/");
  if (permitirSkill && r === "SKILL.md") return join(dir, "SKILL.md");
  if (
    /^[a-zA-Z]:/.test(r) || r.startsWith("/") || r.includes(":") ||
    partes.some((p) => !p || p === "." || p === "..") ||
    partes.length < 2 || !(DIRECTORIOS_APOYO as readonly string[]).includes(partes[0]!)
  ) {
    throw new ErrorSkill(`Ruta no válida: «${rel}». Los ficheros de apoyo van bajo references/, templates/ o scripts/ dentro de la skill.`);
  }
  const abs = resolve(dir, ...partes);
  if (!dentroDe(abs, dir)) throw new ErrorSkill(`Ruta fuera de la skill: «${rel}».`);
  return abs;
}

/** Ficheros de apoyo (rutas relativas con «/») y la fecha del cambio más reciente en la carpeta. */
function listarApoyo(dir: string): { ficheros: string[]; actualizada: string } {
  const ficheros: string[] = [];
  let ultima = 0;
  try {
    ultima = statSync(join(dir, "SKILL.md")).mtimeMs;
  } catch {}
  const recorrer = (abs: string, rel: string, nivel: number) => {
    let entradas: Dirent[];
    try {
      entradas = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entradas) {
      if (ficheros.length >= 300 || d.name.startsWith(".") || d.name === "node_modules") continue;
      const hijo = join(abs, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory() && nivel < 4) recorrer(hijo, r, nivel + 1);
      else if (d.isFile()) {
        ficheros.push(r);
        try {
          ultima = Math.max(ultima, statSync(hijo).mtimeMs);
        } catch {}
      }
    }
  };
  for (const sub of DIRECTORIOS_APOYO) recorrer(join(dir, sub), sub, 1);
  return { ficheros: ficheros.sort(), actualizada: new Date(ultima || Date.now()).toISOString() };
}

function leerTexto(ruta: string): string | undefined {
  try {
    return decodificar(readFileSync(ruta)).texto.replace(/\r\n/g, "\n");
  } catch {
    return undefined;
  }
}

function escribirAtomico(ruta: string, datos: string | Uint8Array): void {
  const temporal = `${ruta}.${process.pid}.tmp`;
  writeFileSync(temporal, datos);
  try {
    renameSync(temporal, ruta);
  } catch {
    rmSync(temporal, { force: true });
    writeFileSync(ruta, datos);
  }
}

function recortar(t: string, max: number): string {
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const CLAVE_VISTAS = "skills.vistas";

/** Lo visto con ver_skill en la sesión: skills ya contadas y huella de cada fichero leído. */
interface Vistas {
  contadas: Set<string>;
  huellas: Map<string, string>;
}

function vistasDe(ctx: ContextoHerramienta): Vistas {
  let v = ctx.estado.get(CLAVE_VISTAS) as Vistas | undefined;
  if (!v) {
    v = { contadas: new Set(), huellas: new Map() };
    ctx.estado.set(CLAVE_VISTAS, v);
  }
  return v;
}

function claveVista(nombre: string, rel: string): string {
  const r = normalizarRel(rel);
  return `${nombre}\n${process.platform === "win32" ? r.toLowerCase() : r}`;
}

function huella(texto: string): string {
  return Bun.hash(texto).toString(16);
}

export function herramientasSkills(a: AlmacenSkills, alCambiar?: () => void): Herramienta[] {
  const verSkill = definir({
    nombre: "ver_skill",
    descripcion:
      "Carga una skill del índice de skills: instrucciones para una clase de tarea, con sus ficheros de apoyo. " +
      "Úsala antes de empezar una tarea que encaje con alguna y sigue lo que diga. " +
      "Con 'fichero' abre uno de sus ficheros de apoyo (references/, templates/ o scripts/).",
    nivel: "lectura",
    parametros: z.object({
      nombre: z.string().min(1).describe("Nombre de la skill, tal como aparece en el índice"),
      fichero: z.string().min(1).optional().describe("Fichero de apoyo, p. ej. references/api.md"),
    }),
    resumen: ({ nombre, fichero }) => (fichero ? `${nombre}/${normalizarRel(fichero)}` : nombre),
    async ejecutar({ nombre, fichero }, ctx) {
      const s = a.leer(nombre, ctx.cwd);
      if (!s) {
        const hay = a.listar(ctx.cwd).filter((x) => x.activa).map((x) => x.nombre);
        throw new ErrorSkill(`No existe la skill «${nombre}». Disponibles: ${hay.join(", ") || "ninguna"}.`);
      }
      if (!s.activa) throw new ErrorSkill(`La skill «${nombre}» está desactivada.`);
      const vistas = vistasDe(ctx);
      if (!vistas.contadas.has(nombre)) {
        vistas.contadas.add(nombre);
        a.registrarUso(nombre);
      }
      if (!fichero || normalizarRel(fichero) === "SKILL.md") {
        vistas.huellas.set(claveVista(nombre, "SKILL.md"), huella(s.contenido));
        if (!s.ficheros.length) return s.contenido;
        return `${s.contenido.trimEnd()}\n\n---\nFicheros de apoyo (ábrelos con ver_skill y fichero): ${s.ficheros.join(", ")}`;
      }
      const texto = a.leerFichero(nombre, fichero, ctx.cwd);
      if (texto === undefined) {
        throw new ErrorSkill(`La skill «${nombre}» no tiene ${fichero}. Ficheros de apoyo: ${s.ficheros.join(", ") || "ninguno"}.`);
      }
      vistas.huellas.set(claveVista(nombre, fichero), huella(texto));
      return texto;
    },
  });

  const gestionarSkill = definir({
    nombre: "gestionar_skill",
    descripcion:
      "Crea o mejora skills del perfil: procedimientos reutilizables para una clase de tarea que se ofrecerán en las próximas sesiones. " +
      "crear: 'nombre' en kebab-case que nombre la clase de tarea (p. ej. migrar-esquemas-sqlite, nunca la tarea de hoy) y 'contenido' con el SKILL.md " +
      "completo: frontmatter entre líneas --- con name (igual a nombre) y description (qué hace y cuándo usarla), y después cuándo usarla, " +
      "los pasos con comandos concretos, las trampas y cómo comprobar el resultado. " +
      "parchear: sustituye 'buscar' (texto exacto que aparece una sola vez) por 'reemplazar' en SKILL.md o en 'fichero'. " +
      "escribir_fichero: crea o sustituye un fichero de apoyo ('fichero' bajo references/, templates/ o scripts/) con 'contenido'. " +
      "Antes de parchear o sobrescribir, mira la skill o el fichero con ver_skill en esta sesión. " +
      "Mejor ampliar una skill que ya existe que crear otra parecida. No guardes fallos pasajeros del entorno ni intentos fallidos como método. " +
      "Las skills no se borran.",
    nivel: "escritura",
    parametros: z.object({
      accion: z.enum(["crear", "parchear", "escribir_fichero"]),
      nombre: z.string().min(1).describe("Nombre de la skill en kebab-case"),
      contenido: z.string().optional().describe("crear: SKILL.md completo; escribir_fichero: contenido del fichero"),
      buscar: z.string().optional().describe("parchear: texto exacto que se sustituye (debe aparecer una sola vez)"),
      reemplazar: z.string().optional().describe("parchear: texto nuevo"),
      fichero: z.string().optional().describe("Fichero de apoyo bajo references/, templates/ o scripts/; en parchear, si falta, se parchea SKILL.md"),
    }),
    resumen: ({ accion, nombre, fichero }) => `${accion} ${nombre}${fichero ? `/${normalizarRel(fichero)}` : ""}`,
    async ejecutar({ accion, nombre, contenido, buscar, reemplazar, fichero }, ctx) {
      const vistas = vistasDe(ctx);
      if (accion === "crear") {
        if (contenido === undefined) throw new ErrorSkill("crear necesita contenido: el SKILL.md completo.");
        const info = a.crear(nombre, contenido, ctx.cwd);
        vistas.huellas.set(claveVista(nombre, "SKILL.md"), huella(a.leer(nombre, ctx.cwd)?.contenido ?? ""));
        alCambiar?.();
        return `Creada la skill «${nombre}» en ${info.ruta} (aprendida). Aparecerá en el índice desde la próxima sesión.`;
      }

      const s = a.leer(nombre, ctx.cwd);
      if (!s) throw new ErrorSkill(`No existe la skill «${nombre}»${accion === "parchear" ? "" : "; créala antes con crear"}.`);
      const rel = accion === "parchear" ? normalizarRel(fichero ?? "SKILL.md") : normalizarRel(fichero ?? "");
      if (accion === "escribir_fichero" && (!rel || rel === "SKILL.md")) {
        throw new ErrorSkill("escribir_fichero necesita 'fichero' bajo references/, templates/ o scripts/; para SKILL.md usa parchear.");
      }
      const actual = rel === "SKILL.md" ? s.contenido : a.leerFichero(nombre, rel, ctx.cwd);
      const clave = claveVista(nombre, rel);
      if (actual !== undefined) {
        const previa = vistas.huellas.get(clave);
        const ver = rel === "SKILL.md" ? `ver_skill con nombre «${nombre}»` : `ver_skill con nombre «${nombre}» y fichero «${rel}»`;
        if (!previa) throw new ErrorSkill(`No has visto ${nombre}/${rel} en esta sesión; míralo antes con ${ver}.`);
        if (previa !== huella(actual)) throw new ErrorSkill(`${nombre}/${rel} ha cambiado desde que lo viste; vuelve a mirarlo con ${ver}.`);
      }

      let nuevo: string;
      if (accion === "parchear") {
        if (actual === undefined) throw new ErrorSkill(`La skill «${nombre}» no tiene ${rel}.`);
        if (!buscar) throw new ErrorSkill("parchear necesita buscar: el texto exacto que se sustituye.");
        if (reemplazar === undefined) throw new ErrorSkill("parchear necesita reemplazar (puede ser vacío para borrar el texto).");
        const b = buscar.replace(/\r\n/g, "\n");
        const veces = actual.split(b).length - 1;
        if (veces === 0) throw new ErrorSkill(`No encuentro ese texto en ${nombre}/${rel}; copia el trozo exacto de lo que devolvió ver_skill.`);
        if (veces > 1) throw new ErrorSkill(`El texto aparece ${veces} veces en ${nombre}/${rel}; amplía buscar para que sea único.`);
        const i = actual.indexOf(b);
        nuevo = actual.slice(0, i) + reemplazar.replace(/\r\n/g, "\n") + actual.slice(i + b.length);
      } else {
        if (contenido === undefined) throw new ErrorSkill("escribir_fichero necesita contenido.");
        nuevo = contenido.replace(/\r\n/g, "\n");
      }
      a.escribir(nombre, rel, nuevo, ctx.cwd);
      vistas.huellas.set(clave, huella(nuevo));
      alCambiar?.();
      return accion === "parchear"
        ? `Parcheada la skill «${nombre}» (${rel}).`
        : `${actual === undefined ? "Creado" : "Sustituido"} ${rel} en la skill «${nombre}».`;
    },
  });

  return [verSkill, gestionarSkill];
}
