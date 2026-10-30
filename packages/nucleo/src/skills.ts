/**
 * Skills en formato SKILL.md (frontmatter YAML con name y description) en <raíz>/<nombre>/SKILL.md, con ficheros
 * de apoyo opcionales en references/, templates/ y scripts/. Raíces, de más a menos precedencia: proyecto
 * (<cwd>/.aquiles/skills y <cwd>/.claude/skills), perfil (<perfil>/skills) e incluidas.
 * Registro por nombre en <perfil>/skills.json: origen, activa, usos, ultimoUso, creada y lo del curador.
 * Curador (solo las aprendidas del perfil): sin actividad 14 días → obsoleta; 30 → se mueve a <perfil>/skills-archivadas/.
 * Antes de cambiar una skill del perfil se copia entera en <perfil>/skills-copias/<nombre>/<id>/ (con meta.json).
 * Nada de esto borra skills ni copias.
 */
import {
  cpSync, type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, type Stats, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CambioCurador, InfoSkill, VersionSkill } from "@aquiles/protocolo";
import { z } from "zod";
import { dentroDe } from "./aprobaciones";
import { codificar, decodificar, esBinario } from "./herramientas/ficheros";
import { definir, ErrorHerramienta, type ContextoHerramienta, type Herramienta } from "./herramientas/herramienta";

export class ErrorSkill extends ErrorHerramienta {}

const DIRECTORIOS_APOYO = ["references", "templates", "scripts"] as const;
const MAX_SKILL = 60_000;
const MAX_FICHERO = 200_000;
const MAX_DESCRIPCION_INDICE = 300;
const DIA = 86_400_000;
const DIAS_OBSOLETA = 14;
const DIAS_ARCHIVADA = 30;
const NOMBRE_VALIDO = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,63}$/u;

interface Registro {
  origen?: InfoSkill["origen"];
  activa?: boolean;
  usos?: number;
  ultimoUso?: string;
  creada?: string;
  fijada?: boolean;
  obsoleta?: boolean;
  /** Última vez que se restauró del archivo; cuenta como actividad para el curador. */
  restaurada?: string;
}

interface Encontrada {
  nombre: string;
  descripcion: string;
  dir: string;
  ubicacion: InfoSkill["ubicacion"];
  archivada?: boolean;
}

export interface DetalleCambioSkill {
  sesionId: string;
  accion: "crear" | "parchear" | "escribir_fichero";
  nombre: string;
  /** SKILL.md o la ruta del fichero de apoyo. */
  fichero: string;
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

  /** Con `archivadas`, añade las de skills-archivadas/ (si no hay otra con el mismo nombre). */
  listar(cwd?: string, o: { archivadas?: boolean } = {}): InfoSkill[] {
    if (cwd) this.ultimoCwd = cwd;
    const reg = this.registro();
    return [...this.descubrir(cwd, o.archivadas).values()].map((e) => this.info(e, reg)).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  /** Las archivadas solo se encuentran con `archivadas` (el detalle en la app). */
  leer(nombre: string, cwd?: string, o: { archivadas?: boolean } = {}): (InfoSkill & { contenido: string; ficheros: string[] }) | undefined {
    if (cwd) this.ultimoCwd = cwd;
    const e = this.descubrir(cwd, o.archivadas).get(nombre);
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

  /** Cuenta un uso; si estaba obsoleta, vuelve a vigente. */
  registrarUso(nombre: string): void {
    this.actualizar(nombre, (r) => {
      r.usos = (r.usos ?? 0) + 1;
      r.ultimoUso = new Date().toISOString();
      delete r.obsoleta;
    });
  }

  /** Fijada = el curador no la toca. Fijar una obsoleta la vuelve vigente. */
  fijar(nombre: string, fijada: boolean): InfoSkill {
    const e = this.delPerfil(nombre, true);
    const reg = this.actualizar(e.nombre, (r) => {
      r.fijada = fijada;
      if (fijada) delete r.obsoleta;
    });
    return this.info(e, reg);
  }

  /** Mueve la carpeta a skills-archivadas/; no borra nada. */
  archivar(nombre: string): InfoSkill {
    const e = this.delPerfil(nombre);
    return this.info(this.moverAlArchivo(e), this.registro());
  }

  /** Devuelve una archivada a skills/ como vigente y apunta la fecha como actividad. */
  restaurar(nombre: string): InfoSkill {
    const raiz = this.raizPerfil();
    const e = this.archivadas().find((x) => x.nombre === nombre);
    if (!e) throw new ErrorSkill(`No hay ninguna skill archivada con el nombre «${nombre}».`);
    const destino = join(raiz, nombre);
    if (this.skillsEn(raiz, "perfil").some((x) => x.nombre === nombre) || existsSync(destino)) {
      throw new ErrorSkill(`Ya hay una skill «${nombre}» en ${raiz}; renómbrala o archívala antes de restaurar esta.`);
    }
    mover(e.dir, destino);
    const reg = this.actualizar(nombre, (r) => {
      delete r.obsoleta;
      r.restaurada = new Date().toISOString();
    });
    return this.info({ ...e, dir: destino, archivada: false }, reg);
  }

  /** Copias guardadas antes de cada cambio, de la más reciente a la más antigua. */
  versiones(nombre: string): VersionSkill[] {
    if (!this.perfil || !NOMBRE_VALIDO.test(nombre)) return [];
    const base = join(this.raizCopias(), nombre);
    let ids: string[];
    try {
      ids = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    return ids
      .sort()
      .reverse()
      .map((id) => {
        const dir = join(base, id);
        let meta: { fecha?: unknown; motivo?: unknown } = {};
        try {
          meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) ?? {};
        } catch {}
        return {
          id,
          fecha: typeof meta.fecha === "string" ? meta.fecha : statSync(dir).mtime.toISOString(),
          ficheros: ficherosDeCopia(dir),
          motivo: typeof meta.motivo === "string" ? meta.motivo : "desconocido",
        };
      });
  }

  /**
   * Vuelve a una copia: antes guarda otra de lo actual (motivo «restaurar»), pone los ficheros de la versión
   * y quita los de apoyo que la versión no tenía (quedan en la copia recién hecha).
   */
  restaurarVersion(nombre: string, id: string): InfoSkill {
    const e = this.delPerfil(nombre);
    const dirVersion = join(this.raizCopias(), e.nombre, id);
    if (!/^[\w-]+$/.test(id) || !existsSync(join(dirVersion, "SKILL.md"))) {
      throw new ErrorSkill(`No existe la versión «${id}» de la skill «${nombre}».`);
    }
    const datos = frontmatter(leerTexto(join(dirVersion, "SKILL.md")) ?? "");
    if (datos?.name?.trim() !== e.nombre) throw new ErrorSkill(`La versión «${id}» no es de la skill «${nombre}».`);
    const ficheros = ficherosDeCopia(dirVersion);
    const destinos = ficheros.map((rel) => [join(dirVersion, ...rel.split("/")), rutaDentro(e.dir, rel, true)] as const);
    this.copiar(e, "restaurar");
    for (const [origen, destino] of destinos) {
      mkdirSync(dirname(destino), { recursive: true });
      escribirAtomico(destino, readFileSync(origen));
    }
    const quedan = new Set(ficheros);
    for (const rel of listarApoyo(e.dir).ficheros) {
      if (!quedan.has(rel)) rmSync(join(e.dir, ...rel.split("/")), { force: true });
    }
    return this.info(e, this.registro());
  }

  /**
   * Curador: solo las aprendidas del perfil que no están fijadas. Actividad = la fecha más reciente de ultimoUso,
   * creada y restaurada (o el mtime de SKILL.md). Devuelve solo lo que cambió.
   */
  curar(ahora = new Date()): CambioCurador[] {
    if (!this.perfil) return [];
    const reg = this.registro();
    const cambios: CambioCurador[] = [];
    for (const e of this.skillsEn(this.raizPerfil(), "perfil")) {
      const r = reg[e.nombre] ?? {};
      if (r.origen !== "aprendida" || r.fijada) continue;
      const dias = (ahora.getTime() - actividad(e, r)) / DIA;
      const antes = r.obsoleta ? "obsoleta" : "vigente";
      if (dias > DIAS_ARCHIVADA) {
        try {
          this.moverAlArchivo(e);
        } catch {
          continue;
        }
        cambios.push({ nombre: e.nombre, antes, despues: "archivada" });
      } else if (dias > DIAS_OBSOLETA && !r.obsoleta) {
        reg[e.nombre] = { ...r, obsoleta: true };
        cambios.push({ nombre: e.nombre, antes, despues: "obsoleta" });
      } else if (dias <= DIAS_OBSOLETA && r.obsoleta) {
        const { obsoleta: _fuera, ...resto } = r;
        reg[e.nombre] = resto;
        cambios.push({ nombre: e.nombre, antes, despues: "vigente" });
      }
    }
    if (cambios.some((c) => c.despues !== "archivada")) this.guardarRegistro(reg);
    return cambios;
  }

  /**
   * Aplica ficheros a una skill del perfil (p. ej. una propuesta aceptada). Si no existe, la crea como aprendida
   * y tiene que venir SKILL.md; si existe, la copia antes de escribir. Conserva BOM y CRLF de lo que ya había.
   */
  aplicarFicheros(nombre: string, ficheros: { ruta: string; contenido: string }[], o: { motivo: string }): InfoSkill {
    const raiz = this.raizPerfil();
    if (!ficheros.length) throw new ErrorSkill("No hay ficheros que aplicar.");
    const existente = this.skillsEn(raiz, "perfil").find((x) => x.nombre === nombre);
    const dir = existente?.dir ?? join(raiz, nombre);
    const preparados = ficheros.map((f) => {
      const rel = normalizarRel(f.ruta);
      const abs = rutaDentro(dir, rel, true);
      return { abs, rel, texto: rel === "SKILL.md" ? validarSkill(f.contenido, nombre) : validarApoyo(f.contenido) };
    });

    if (!existente) {
      this.comprobarNombreNuevo(nombre);
      if (!preparados.some((p) => p.rel === "SKILL.md")) throw new ErrorSkill(`La skill «${nombre}» no existe: para crearla hace falta SKILL.md.`);
      if (existsSync(join(dir, "SKILL.md"))) throw new ErrorSkill(`Ya existe ${join(dir, "SKILL.md")} y no es una skill válida; revísala a mano.`);
      for (const p of preparados) {
        mkdirSync(dirname(p.abs), { recursive: true });
        escribirAtomico(p.abs, p.texto);
      }
      return this.registrarCreada(nombre, dir);
    }

    const cambian = preparados.flatMap((p) => {
      const bytes = bytesPara(p.abs, p.texto);
      return bytes ? [{ abs: p.abs, bytes }] : [];
    });
    if (cambian.length) {
      this.copiar(existente, o.motivo);
      for (const p of cambian) {
        mkdirSync(dirname(p.abs), { recursive: true });
        escribirAtomico(p.abs, p.bytes);
      }
    }
    return this.info(this.skillsEn(raiz, "perfil").find((x) => x.nombre === nombre) ?? existente, this.registro());
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
    const raiz = this.raizPerfil();
    this.comprobarNombreNuevo(nombre, cwd);
    const texto = validarSkill(contenido, nombre);
    const dir = join(raiz, nombre);
    if (existsSync(join(dir, "SKILL.md"))) throw new ErrorSkill(`Ya existe ${join(dir, "SKILL.md")}; amplíala con parchear.`);
    mkdirSync(dir, { recursive: true });
    escribirAtomico(join(dir, "SKILL.md"), texto);
    return this.registrarCreada(nombre, dir);
  }

  /**
   * Escribe SKILL.md o un fichero de apoyo de una skill del perfil (las de proyecto e incluidas no se tocan),
   * con copia previa de la skill si algo cambia. Conserva BOM y finales CRLF si el fichero ya los tenía.
   */
  escribir(nombre: string, rel: string, contenido: string, cwd?: string, motivo = "escribir"): void {
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
    const bytes = bytesPara(abs, esSkill ? validarSkill(contenido, nombre) : validarApoyo(contenido));
    if (!bytes) return;
    this.copiar(e, motivo);
    mkdirSync(dirname(abs), { recursive: true });
    escribirAtomico(abs, bytes);
  }

  private raizPerfil(): string {
    if (!this.perfil) throw new ErrorSkill("No hay perfil donde guardar skills.");
    return join(this.perfil, "skills");
  }

  private raizArchivo(): string {
    return join(this.perfil ?? "", "skills-archivadas");
  }

  private raizCopias(): string {
    return join(this.perfil ?? "", "skills-copias");
  }

  private archivadas(): Encontrada[] {
    return this.perfil ? this.skillsEn(this.raizArchivo(), "perfil", true) : [];
  }

  /** Skill del perfil en skills/ (o también archivada, si se permite); ErrorSkill claro si no. */
  private delPerfil(nombre: string, tambienArchivada = false): Encontrada {
    const e = this.skillsEn(this.raizPerfil(), "perfil").find((x) => x.nombre === nombre);
    if (e) return e;
    const archivada = this.archivadas().find((x) => x.nombre === nombre);
    if (archivada && tambienArchivada) return archivada;
    if (archivada) throw new ErrorSkill(`La skill «${nombre}» está archivada; restáurala antes.`);
    const otra = this.descubrir(this.ultimoCwd).get(nombre);
    if (otra) {
      const donde = otra.ubicacion === "incluida" ? "una de las incluidas con Aquiles" : "del proyecto";
      throw new ErrorSkill(`La skill «${nombre}» es ${donde}; esto solo vale para las del perfil.`);
    }
    throw new ErrorSkill(`No existe la skill «${nombre}» en el perfil.`);
  }

  private comprobarNombreNuevo(nombre: string, cwd?: string): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nombre) || nombre.length > 64) {
      throw new ErrorSkill(
        `Nombre no válido: «${nombre}». Usa kebab-case (minúsculas, cifras y guiones, hasta 64) y nombra una clase de tarea, ` +
          "p. ej. migrar-esquemas-sqlite, no la tarea concreta de hoy.",
      );
    }
    const existente = this.descubrir(cwd).get(nombre);
    if (existente) {
      throw new ErrorSkill(`Ya existe una skill «${nombre}» (${existente.ubicacion}, ${existente.dir}); amplíala con parchear o usa otro nombre.`);
    }
    if (this.archivadas().some((x) => x.nombre === nombre)) {
      throw new ErrorSkill(`Hay una skill «${nombre}» archivada; restáurala y amplíala en vez de crear otra.`);
    }
  }

  private registrarCreada(nombre: string, dir: string): InfoSkill {
    const ahora = new Date().toISOString();
    const reg = this.registro();
    reg[nombre] = { origen: "aprendida", activa: true, usos: 0, creada: ahora };
    this.guardarRegistro(reg);
    const texto = leerTexto(join(dir, "SKILL.md")) ?? "";
    return this.info({ nombre, descripcion: frontmatter(texto)?.description?.trim() ?? "", dir, ubicacion: "perfil" }, reg);
  }

  private moverAlArchivo(e: Encontrada): Encontrada {
    const destino = join(this.raizArchivo(), e.nombre);
    if (existsSync(destino)) throw new ErrorSkill(`Ya hay una skill archivada en ${destino}.`);
    mover(e.dir, destino);
    return { ...e, dir: destino, archivada: true };
  }

  /** Copia SKILL.md y los ficheros de apoyo en skills-copias/<nombre>/<id>/ con meta.json; devuelve el id. */
  private copiar(e: Encontrada, motivo: string): string {
    const base = join(this.raizCopias(), e.nombre);
    const fecha = new Date();
    const marca = fecha.toISOString().replace(/[-:.]/g, "");
    let id = marca;
    for (let n = 1; existsSync(join(base, id)); n++) id = `${marca}-${n}`;
    const destino = join(base, id);
    mkdirSync(destino, { recursive: true });
    for (const rel of ["SKILL.md", ...listarApoyo(e.dir).ficheros]) {
      const origen = join(e.dir, ...rel.split("/"));
      if (!existsSync(origen)) continue;
      const copia = join(destino, ...rel.split("/"));
      mkdirSync(dirname(copia), { recursive: true });
      writeFileSync(copia, readFileSync(origen));
    }
    writeFileSync(join(destino, "meta.json"), `${JSON.stringify({ fecha: fecha.toISOString(), motivo }, null, 2)}\n`);
    return id;
  }

  private raices(cwd?: string): { dir: string; ubicacion: InfoSkill["ubicacion"] }[] {
    const r: { dir: string; ubicacion: InfoSkill["ubicacion"] }[] = [];
    if (cwd) r.push({ dir: join(cwd, ".aquiles", "skills"), ubicacion: "proyecto" }, { dir: join(cwd, ".claude", "skills"), ubicacion: "proyecto" });
    if (this.perfil) r.push({ dir: join(this.perfil, "skills"), ubicacion: "perfil" });
    if (this.incluidas) r.push({ dir: this.incluidas, ubicacion: "incluida" });
    return r;
  }

  /** Skills por nombre; la primera raíz que tiene un nombre gana. Las archivadas, solo si se piden y al final. */
  private descubrir(cwd?: string, archivadas = false): Map<string, Encontrada> {
    const vistas = new Map<string, Encontrada>();
    const candidatas = this.raices(cwd).flatMap(({ dir, ubicacion }) => this.skillsEn(dir, ubicacion));
    if (archivadas) candidatas.push(...this.archivadas());
    for (const e of candidatas) if (!vistas.has(e.nombre)) vistas.set(e.nombre, e);
    return vistas;
  }

  /** Skills válidas de una raíz, por orden de carpeta (si dos se llaman igual, gana la primera). */
  private skillsEn(raiz: string, ubicacion: InfoSkill["ubicacion"], archivada = false): Encontrada[] {
    let carpetas: string[];
    try {
      carpetas = readdirSync(raiz, { withFileTypes: true })
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
    const salida: Encontrada[] = [];
    for (const carpeta of carpetas) {
      const dir = join(raiz, carpeta);
      const texto = leerTexto(join(dir, "SKILL.md"));
      const datos = texto === undefined ? undefined : frontmatter(texto);
      const nombre = datos?.name?.trim();
      const descripcion = datos?.description?.trim();
      if (!nombre || !descripcion || !NOMBRE_VALIDO.test(nombre) || salida.some((x) => x.nombre === nombre)) continue;
      salida.push({ nombre, descripcion, dir, ubicacion, ...(archivada ? { archivada } : {}) });
    }
    return salida;
  }

  private info(e: Encontrada, reg: Record<string, Registro>): InfoSkill {
    const r = reg[e.nombre] ?? {};
    const delPerfil = e.ubicacion === "perfil";
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
      vigencia: e.archivada ? "archivada" : delPerfil && r.obsoleta ? "obsoleta" : "vigente",
      fijada: delPerfil && r.fijada === true,
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
    this.guardarRegistro(reg);
    return reg;
  }

  private guardarRegistro(reg: Record<string, Registro>): void {
    if (!this.perfil) {
      this.registroEnMemoria = reg;
      return;
    }
    mkdirSync(this.perfil, { recursive: true });
    escribirAtomico(join(this.perfil, "skills.json"), `${JSON.stringify(reg, null, 2)}\n`);
  }
}

/** Fecha (ms) de la última actividad de una skill para el curador. */
function actividad(e: Encontrada, r: Registro): number {
  const fechas = [r.ultimoUso, r.creada, r.restaurada].map((f) => (f ? Date.parse(f) : Number.NaN)).filter((n) => !Number.isNaN(n));
  if (fechas.length) return Math.max(...fechas);
  try {
    return statSync(join(e.dir, "SKILL.md")).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** Mueve una carpeta; si Windows niega el rename (algo abierto dentro), copia y después quita el origen. */
function mover(origen: string, destino: string): void {
  mkdirSync(dirname(destino), { recursive: true });
  try {
    renameSync(origen, destino);
  } catch {
    cpSync(origen, destino, { recursive: true, errorOnExist: true, force: false });
    rmSync(origen, { recursive: true, force: true });
  }
}

/** SKILL.md (si está) y los ficheros de apoyo de una carpeta de copia. */
function ficherosDeCopia(dir: string): string[] {
  return [...(existsSync(join(dir, "SKILL.md")) ? ["SKILL.md"] : []), ...listarApoyo(dir).ficheros];
}

function validarApoyo(contenido: string): string {
  const texto = contenido.replace(/\r\n/g, "\n");
  if (texto.length > MAX_FICHERO) throw new ErrorSkill(`El fichero es demasiado largo (${texto.length} caracteres; máximo ${MAX_FICHERO}).`);
  return texto;
}

/** Bytes que hay que escribir para `texto` (LF) conservando BOM y CRLF del fichero actual; undefined si no cambia nada. */
function bytesPara(abs: string, texto: string): Uint8Array | undefined {
  let actual: Buffer | undefined;
  try {
    actual = readFileSync(abs);
  } catch {}
  const previo = actual ? decodificar(actual) : undefined;
  const bytes = codificar(previo?.crlf ? texto.replace(/\n/g, "\r\n") : texto, previo?.bom ?? false);
  return actual?.equals(bytes) ? undefined : bytes;
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

export function herramientasSkills(a: AlmacenSkills, alCambiar?: (detalle: DetalleCambioSkill) => void): Herramienta[] {
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
        alCambiar?.({ sesionId: ctx.sesionId, accion, nombre, fichero: "SKILL.md" });
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
      a.escribir(nombre, rel, nuevo, ctx.cwd, accion === "parchear" ? "parchear" : "escribir");
      vistas.huellas.set(clave, huella(nuevo));
      alCambiar?.({ sesionId: ctx.sesionId, accion, nombre, fichero: rel });
      return accion === "parchear"
        ? `Parcheada la skill «${nombre}» (${rel}).`
        : `${actual === undefined ? "Creado" : "Sustituido"} ${rel} en la skill «${nombre}».`;
    },
  });

  return [verSkill, gestionarSkill];
}
