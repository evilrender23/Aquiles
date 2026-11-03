/** Herramientas del modelo para las skills: ver_skill (leer) y gestionar_skill (crear, parchear, escribir ficheros de apoyo). */
import { z } from "zod";
import { type ContextoHerramienta, definir, type Herramienta } from "../herramientas/herramienta";
import type { AlmacenSkills } from "./almacen";
import { ErrorSkill, normalizarRel } from "./carga";

export interface DetalleCambioSkill {
  sesionId: string;
  accion: "crear" | "parchear" | "escribir_fichero";
  nombre: string;
  /** SKILL.md o la ruta del fichero de apoyo. */
  fichero: string;
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
