/**
 * Almacén de skills: lista y lee las de todas las raíces, guarda el registro (skills.json) con usos y estado,
 * escribe las del perfil con copia previa (skills-copias/) y pasa el curador, que archiva en skills-archivadas/.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, type Stats, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CambioCurador, InfoSkill, VersionSkill } from "@aquiles/protocolo";
import { codificar, decodificar, esBinario } from "../herramientas/ficheros";
import {
  type Encontrada, ErrorSkill, frontmatter, leerTexto, listarApoyo, MAX_FICHERO, NOMBRE_VALIDO, normalizarRel, raices, rutaDentro,
  skillsEn, validarApoyo, validarSkill,
} from "./carga";

const MAX_DESCRIPCION_INDICE = 300;
const DIA = 86_400_000;
const DIAS_OBSOLETA = 14;
const DIAS_ARCHIVADA = 30;

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
    if (skillsEn(raiz, "perfil").some((x) => x.nombre === nombre) || existsSync(destino)) {
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
    for (const e of skillsEn(this.raizPerfil(), "perfil")) {
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
    const existente = skillsEn(raiz, "perfil").find((x) => x.nombre === nombre);
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
    return this.info(skillsEn(raiz, "perfil").find((x) => x.nombre === nombre) ?? existente, this.registro());
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
    return this.perfil ? skillsEn(this.raizArchivo(), "perfil", true) : [];
  }

  /** Skill del perfil en skills/ (o también archivada, si se permite); ErrorSkill claro si no. */
  private delPerfil(nombre: string, tambienArchivada = false): Encontrada {
    const e = skillsEn(this.raizPerfil(), "perfil").find((x) => x.nombre === nombre);
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

  /** Skills por nombre; la primera raíz que tiene un nombre gana. Las archivadas, solo si se piden y al final. */
  private descubrir(cwd?: string, archivadas = false): Map<string, Encontrada> {
    const vistas = new Map<string, Encontrada>();
    const candidatas = raices(cwd, this.perfil, this.incluidas).flatMap(({ dir, ubicacion }) => skillsEn(dir, ubicacion));
    if (archivadas) candidatas.push(...this.archivadas());
    for (const e of candidatas) if (!vistas.has(e.nombre)) vistas.set(e.nombre, e);
    return vistas;
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
