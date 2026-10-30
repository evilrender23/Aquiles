/**
 * Memoria acotada del perfil: entradas cortas separadas por una línea «§», con un límite de caracteres por destino.
 *   usuario  → <perfil>/memoria/USER.md   (quién es el usuario y qué prefiere)
 *   agente   → <perfil>/memoria/MEMORY.md (entorno y lecciones generales)
 *   proyecto → <perfil>/memoria/proyectos/<slug>-<hash8>.md (una por carpeta; primera línea `<!-- cwd: … -->`)
 * La personalidad va en <perfil>/SOUL.md. La sección del prompt se construye al crear la sesión y no cambia.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { BloqueMemoria, DestinoMemoria } from "@aquiles/protocolo";
import { z } from "zod";
import { definir, ErrorHerramienta, type Herramienta } from "./herramientas/herramienta";

export const LIMITES: Readonly<Record<DestinoMemoria, number>> = { usuario: 1400, agente: 2200, proyecto: 2200 };

const SEPARADOR = "\n§\n";
const DESTINOS = ["usuario", "agente", "proyecto"] as const;

/** Error esperable (límite, seguridad, falta la carpeta); `exceso` = caracteres que sobran si se pasó del límite. */
export class ErrorMemoria extends ErrorHerramienta {
  constructor(mensaje: string, readonly exceso?: number) {
    super(mensaje);
    this.name = "ErrorMemoria";
  }
}

export class Memoria {
  private enMemoria = new Map<string, string>();

  /** `perfil` null: solo en memoria (tests). */
  constructor(private perfil: string | null) {}

  leer(destino: DestinoMemoria, cwd?: string): BloqueMemoria {
    const texto = this.leerTexto(this.ruta(destino, cwd));
    return bloque(destino, texto === undefined ? [] : partirEntradas(texto));
  }

  /**
   * Sustituye todas las entradas del destino (normalizadas, sin duplicados) tras validar el límite y la seguridad
   * de las entradas que no estaban ya guardadas.
   */
  guardar(destino: DestinoMemoria, entradas: string[], cwd?: string): BloqueMemoria {
    const ruta = this.ruta(destino, cwd);
    const b = bloque(destino, prepararEntradas(entradas, new Set(this.leer(destino, cwd).entradas)));
    if (b.usados > b.limite) {
      throw new ErrorMemoria(
        `La memoria de ${destino} se pasa del límite: ${b.usados}/${b.limite} caracteres (sobran ${b.usados - b.limite}).`,
        b.usados - b.limite,
      );
    }
    const cabecera = destino === "proyecto" ? `<!-- cwd: ${resolve(cwd!)} -->\n` : "";
    this.escribirTexto(ruta, cabecera + (b.entradas.length ? `${b.entradas.join(SEPARADOR)}\n` : ""));
    return b;
  }

  alma(): string {
    return (this.leerTexto(this.rutaAlma()) ?? "").trim();
  }

  guardarAlma(texto: string): string {
    const limpio = texto.replace(/\r\n?/g, "\n").trim();
    this.escribirTexto(this.rutaAlma(), limpio ? `${limpio}\n` : "");
    return limpio;
  }

  /** Personalidad (si hay) y las tres memorias con su uso, para el system prompt de una sesión nueva. */
  seccionPrompt(cwd: string): string {
    const partes: string[] = [];
    const alma = this.alma();
    if (alma) partes.push("## Personalidad", alma, "");
    partes.push(
      "## Memoria",
      "Notas guardadas con la herramienta memoria en sesiones anteriores, tal como estaban al empezar esta sesión. " +
        "Lo que guardes ahora se verá en la próxima.",
    );
    const titulos: Record<DestinoMemoria, string> = {
      usuario: "Usuario",
      agente: "Agente (entorno y lecciones)",
      proyecto: `Proyecto (${resolve(cwd)})`,
    };
    for (const destino of DESTINOS) {
      const b = this.leer(destino, cwd);
      partes.push(
        "",
        `### ${titulos[destino]} [${b.usados}/${b.limite}]`,
        b.entradas.length ? b.entradas.map((e) => `- ${e.replace(/\n/g, "\n  ")}`).join("\n") : "(vacía)",
      );
    }
    return partes.join("\n");
  }

  private ruta(destino: DestinoMemoria, cwd?: string): string {
    const base = join(this.perfil ?? "", "memoria");
    if (destino === "usuario") return join(base, "USER.md");
    if (destino === "agente") return join(base, "MEMORY.md");
    if (!cwd) throw new ErrorMemoria("La memoria de proyecto necesita la carpeta del proyecto (cwd).");
    return join(base, "proyectos", `${slug(cwd)}-${hash8(cwd)}.md`);
  }

  private rutaAlma(): string {
    return join(this.perfil ?? "", "SOUL.md");
  }

  private leerTexto(ruta: string): string | undefined {
    if (!this.perfil) return this.enMemoria.get(ruta);
    try {
      return readFileSync(ruta, "utf8");
    } catch {
      return undefined;
    }
  }

  private escribirTexto(ruta: string, texto: string): void {
    if (!this.perfil) {
      this.enMemoria.set(ruta, texto);
      return;
    }
    mkdirSync(dirname(ruta), { recursive: true });
    const temporal = `${ruta}.${process.pid}.tmp`;
    writeFileSync(temporal, texto);
    try {
      renameSync(temporal, ruta);
    } catch {
      // Windows niega el rename si otro proceso tiene el fichero abierto: se escribe directamente.
      rmSync(temporal, { force: true });
      writeFileSync(ruta, texto);
    }
  }
}

function bloque(destino: DestinoMemoria, entradas: string[]): BloqueMemoria {
  return { entradas, usados: entradas.join(SEPARADOR).length, limite: LIMITES[destino] };
}

function partirEntradas(texto: string): string[] {
  const lineas = texto.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  if (/^<!--\s*cwd:.*-->\s*$/.test(lineas[0] ?? "")) lineas.shift();
  const entradas: string[] = [];
  let actual: string[] = [];
  const cerrar = () => {
    const e = actual.join("\n").trim();
    if (e) entradas.push(e);
    actual = [];
  };
  for (const l of lineas) {
    if (l.trim() === "§") cerrar();
    else actual.push(l);
  }
  cerrar();
  return entradas;
}

function normalizarCwd(cwd: string): string {
  const r = resolve(cwd);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function hash8(cwd: string): string {
  return createHash("sha256").update(normalizarCwd(cwd)).digest("hex").slice(0, 8);
}

function slug(cwd: string): string {
  const s = plegar(basename(resolve(cwd)))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "raiz";
}

/** Minúsculas y sin tildes, para comparar y buscar patrones. */
function plegar(t: string): string {
  return t.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Espacios repetidos a uno, líneas recortadas y sin líneas vacías. */
function normalizar(t: string): string {
  return t
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function prepararEntradas(entradas: readonly string[], guardadas: ReadonlySet<string>): string[] {
  const salida: string[] = [];
  for (const bruta of entradas) {
    const e = guardadas.has(bruta) ? bruta : prepararEntrada(bruta);
    if (e && !salida.includes(e)) salida.push(e);
  }
  return salida;
}

/** Normaliza una entrada y lanza ErrorMemoria si no es segura; "" si queda vacía. */
function prepararEntrada(bruta: string): string {
  const raro = invisible(bruta);
  if (raro) throw new ErrorMemoria(`Entrada rechazada: contiene un carácter invisible o de control (${raro}): «${recorte(bruta)}»`);
  const e = normalizar(bruta);
  if (e.split("\n").includes("§")) throw new ErrorMemoria("Entrada rechazada: una línea «§» sola es el separador de entradas.");
  const motivo = sospecha(e);
  if (motivo) {
    throw new ErrorMemoria(
      `Entrada rechazada (${motivo}): «${recorte(e)}». La memoria guarda hechos y preferencias, no instrucciones para el modelo.`,
    );
  }
  return e;
}

function invisible(texto: string): string | undefined {
  for (const c of texto) {
    const n = c.codePointAt(0)!;
    const control = (n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d) || (n >= 0x7f && n <= 0x9f);
    const formato =
      n === 0xad || n === 0x061c || n === 0x180e || n === 0xfeff ||
      (n >= 0x200b && n <= 0x200f) || (n >= 0x202a && n <= 0x202e) || (n >= 0x2060 && n <= 0x2064) ||
      (n >= 0x2066 && n <= 0x2069) || (n >= 0xfff9 && n <= 0xfffb) || (n >= 0xe0000 && n <= 0xe007f);
    if (control || formato) return `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return undefined;
}

const PATRONES: [RegExp, string][] = [
  [
    /\b(?:ignor|olvid|descart|omit|salt)\w*\s+(?:todas\s+)?(?:las\s+|tus\s+|sus\s+|estas\s+)?(?:instrucciones|indicaciones|reglas|normas|ordenes|directrices)\s+(?:anteriores|previas|de arriba|del sistema|originales)\b/,
    "pide ignorar instrucciones",
  ],
  [/\b(?:ignor|olvid|descart)\w*\s+(?:todas\s+)?tus\s+(?:instrucciones|indicaciones|reglas|normas|ordenes|directrices)\b/, "pide ignorar instrucciones"],
  [
    /\b(?:ignore|disregard|forget|override|skip)\s+(?:all\s+)?(?:of\s+)?(?:the\s+|your\s+|any\s+|these\s+)?(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions|prompts?|rules|directions|guidelines|messages)\b/,
    "pide ignorar instrucciones",
  ],
  [/\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:of\s+)?your\s+(?:instructions|rules|guidelines|programming)\b/, "pide ignorar instrucciones"],
  [/\bsystem\s*prompt\b|\bprompt\s+del?\s+sistema\b/, "habla del system prompt"],
  [/<\s*\/?\s*(?:system|sistema|assistant|developer)\b[^>]*>|<\|im_(?:start|end)\|>|\[\/?(?:inst|sys)\]|<<\s*\/?\s*sys\s*>>/, "lleva etiquetas de rol"],
  [/\b(?:you are now|from now on you are)\b|\b(?:ahora|a partir de ahora|desde ahora)\s+eres\b/, "intenta cambiar el papel del agente"],
  [
    /\b(?:no se lo (?:digas|cuentes)|no le (?:digas|cuentes)|sin (?:decirselo|contarselo)|ocultaselo)\b[^.\n]{0,20}\busuario\b|\b(?:do not|don't|never) (?:tell|inform|show) the user\b|\bwithout telling the user\b/,
    "pide ocultar algo al usuario",
  ],
  [/\b(?:cat|type|get-content|gc|more|less|head|tail|strings)\s+[^\n]*(?:\.env\b|id_rsa|id_ed25519|\.netrc|\.pgpass|\.npmrc|\.aws[\\/]credentials)/, "lee ficheros de claves"],
  [/\b(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|nc|netcat|scp)\b[^\n]*(?:\$\{?|\$env:|%)\w*(?:key|token|secret|pass|clave|cred)/, "envía claves por la red"],
  [/(?:>>|\becho\b)[^\n]*authorized_keys/, "añade claves SSH"],
];

const ENVIAR =
  /\b(?:envia|enviar|envies|manda|mandar|sube|subir|exfiltra|filtra|comparte|compartir|publica|publicar|reenvia|send|upload|post|leak|exfiltrate|forward|share)\b/;
const SECRETO = /\b(?:claves?|api[ _-]?keys?|tokens?|contrasenas?|credenciales|secretos?|passwords?|credentials|secrets?)\b/;
const DESTINO_EXTERNO = /https?:\/\/|\b[\w.+-]+@[\w-]+\.[\w.]+|\bwebhook/;

function sospecha(entrada: string): string | undefined {
  const t = plegar(entrada);
  for (const [re, motivo] of PATRONES) if (re.test(t)) return motivo;
  if (ENVIAR.test(t) && SECRETO.test(t) && DESTINO_EXTERNO.test(t)) return "pide enviar claves fuera";
  return undefined;
}

function recorte(t: string, max = 80): string {
  const una = t.replace(/\s+/g, " ").trim();
  return una.length > max ? `${una.slice(0, max - 1)}…` : una;
}

const destino = z.enum(DESTINOS);
const operacion = z.object({
  accion: z.enum(["añadir", "sustituir", "quitar"]),
  destino,
  texto: z.string().optional().describe("añadir: la entrada nueva; sustituir: la entrada que reemplaza a la encontrada"),
  buscar: z.string().optional().describe("sustituir y quitar: trozo de texto que esté en una sola entrada"),
});
type Operacion = z.infer<typeof operacion>;

interface Trabajo {
  antes: string[];
  despues: string[];
  hechas: string[];
}

export interface DetalleCambioMemoria {
  sesionId: string;
  /** Lo hecho en ese destino («añadida «…»», «quitada «…»»…), como en el resultado de la herramienta. */
  hechas: string[];
}

export function herramientaMemoria(
  m: Memoria,
  alCambiar?: (destino: DestinoMemoria, cwd: string | undefined, detalle: DetalleCambioMemoria) => void,
): Herramienta {
  return definir({
    nombre: "memoria",
    descripcion:
      `Guarda notas que se cargan en el prompt de las próximas sesiones. Es pequeña (usuario ${LIMITES.usuario}, ` +
      `agente ${LIMITES.agente} y proyecto ${LIMITES.proyecto} caracteres), así que cada entrada debe ser corta y concreta. ` +
      "Destinos: usuario = quién es el usuario, cómo trabaja y qué prefiere; agente = hechos del entorno (sistema, herramientas, rutas) " +
      "y lecciones generales que valgan en cualquier proyecto; proyecto = convenciones, comandos y datos de la carpeta de trabajo actual. " +
      "Reglas: cada cosa en un solo sitio; nada pasajero ni propio de la tarea de ahora; nada que se vea leyendo el código; ni claves ni secretos. " +
      "Las correcciones y preferencias que exprese el usuario sí merecen guardarse. " +
      "Acciones: añadir (texto), sustituir (buscar = trozo único de la entrada, texto = la nueva) y quitar (buscar). " +
      "Usa operaciones para hacer varias de una vez: el límite se comprueba sobre el resultado final, así que puedes quitar o acortar y añadir en la misma llamada. " +
      "Lo guardado no cambia el prompt de esta sesión: se verá en la próxima.",
    nivel: "escritura",
    parametros: z.object({
      accion: operacion.shape.accion.optional(),
      destino: destino.optional(),
      texto: operacion.shape.texto,
      buscar: operacion.shape.buscar,
      operaciones: z.array(operacion).min(1).max(20).optional().describe("Varias operaciones que se aplican juntas o ninguna"),
    }),
    resumen: (a) =>
      a.operaciones?.length && !a.accion ? `${a.operaciones.length} operaciones` : `${a.accion ?? "?"} ${a.destino ?? ""}`.trim(),
    async ejecutar(args, ctx) {
      const ops: Partial<Operacion>[] = [
        ...(args.accion || args.destino ? [{ accion: args.accion, destino: args.destino, texto: args.texto, buscar: args.buscar }] : []),
        ...(args.operaciones ?? []),
      ];
      if (!ops.length) throw new ErrorHerramienta("Indica accion y destino, o una lista de operaciones.");

      const trabajos = new Map<DestinoMemoria, Trabajo>();
      for (const [i, op] of ops.entries()) {
        const prefijo = ops.length > 1 ? `Operación ${i + 1}: ` : "";
        if (!op.accion || !op.destino) throw new ErrorHerramienta(`${prefijo}faltan accion o destino. No se ha guardado nada.`);
        if (op.destino === "proyecto" && !ctx.cwd) throw new ErrorHerramienta(`${prefijo}no hay carpeta de trabajo para la memoria de proyecto.`);
        let t = trabajos.get(op.destino);
        if (!t) {
          const antes = m.leer(op.destino, ctx.cwd).entradas;
          t = { antes, despues: [...antes], hechas: [] };
          trabajos.set(op.destino, t);
        }
        try {
          aplicar(t, op as Operacion);
        } catch (e) {
          if (!(e instanceof ErrorHerramienta) || !prefijo) throw e;
          throw new ErrorHerramienta(`${prefijo}${e.message}\nNo se ha aplicado ninguna operación.`);
        }
      }

      for (const [d, t] of trabajos) {
        const b = bloque(d, t.despues);
        if (b.usados <= b.limite) continue;
        throw new ErrorMemoria(
          `La memoria de ${d} se pasaría del límite: ${b.usados}/${b.limite} caracteres (sobran ${b.usados - b.limite}). ` +
            "No se ha guardado nada. Sustituye entradas por versiones más cortas o quita las que ya no sirvan " +
            "(puedes hacerlo junto con lo que querías añadir, en una sola llamada con operaciones).\n" +
            `Entradas actuales de ${d} (${bloque(d, t.antes).usados}/${b.limite}):\n${listar(t.antes)}`,
          b.usados - b.limite,
        );
      }

      const lineas: string[] = [];
      for (const [d, t] of trabajos) {
        const cambia = t.despues.length !== t.antes.length || t.despues.some((e, i) => e !== t.antes[i]);
        const b = cambia ? m.guardar(d, t.despues, ctx.cwd) : bloque(d, t.antes);
        if (cambia) alCambiar?.(d, d === "proyecto" ? ctx.cwd : undefined, { sesionId: ctx.sesionId, hechas: [...t.hechas] });
        lineas.push(`- ${d} [${b.usados}/${b.limite}]: ${t.hechas.join("; ")}`);
      }
      return `Memoria actualizada (se verá desde la próxima sesión):\n${lineas.join("\n")}`;
    },
  });
}

function aplicar(t: Trabajo, op: Operacion): void {
  if (op.accion === "añadir") {
    const e = exigirTexto(op);
    if (t.despues.includes(e)) t.hechas.push(`ya estaba «${recorte(e, 60)}»`);
    else {
      t.despues.push(e);
      t.hechas.push(`añadida «${recorte(e, 60)}»`);
    }
    return;
  }
  const i = unica(t.despues, op);
  const vieja = t.despues[i]!;
  if (op.accion === "quitar") {
    t.despues.splice(i, 1);
    t.hechas.push(`quitada «${recorte(vieja, 60)}»`);
    return;
  }
  const nueva = exigirTexto(op);
  const repetida = t.despues.indexOf(nueva);
  if (repetida !== -1 && repetida !== i) t.despues.splice(i, 1);
  else t.despues[i] = nueva;
  t.hechas.push(`sustituida «${recorte(vieja, 40)}» por «${recorte(nueva, 60)}»`);
}

function exigirTexto(op: Operacion): string {
  if (op.texto === undefined) throw new ErrorHerramienta(`${op.accion} necesita texto.`);
  const e = prepararEntrada(op.texto);
  if (!e) throw new ErrorHerramienta("El texto está vacío.");
  return e;
}

/** Índice de la única entrada que contiene `buscar` (exacto y, si no aparece, sin tildes ni mayúsculas). */
function unica(entradas: string[], op: Operacion): number {
  const b = normalizar(op.buscar ?? "");
  if (!b) throw new ErrorHerramienta(`${op.accion} necesita buscar: un trozo de la entrada.`);
  let indices = entradas.flatMap((e, i) => (e.includes(b) ? [i] : []));
  if (!indices.length) indices = entradas.flatMap((e, i) => (plegar(e).includes(plegar(b)) ? [i] : []));
  if (indices.length === 1) return indices[0]!;
  if (!indices.length) {
    throw new ErrorHerramienta(
      `Ninguna entrada de ${op.destino} contiene «${b}».` + (entradas.length ? ` Entradas:\n${listar(entradas)}` : " Está vacía."),
    );
  }
  throw new ErrorHerramienta(
    `«${b}» aparece en ${indices.length} entradas de ${op.destino}; usa un trozo que esté en una sola:\n${listar(indices.map((i) => entradas[i]!))}`,
  );
}

function listar(entradas: readonly string[]): string {
  return entradas.length ? entradas.map((e, i) => `${i + 1}. ${e.replace(/\n/g, "\n   ")}`).join("\n") : "(ninguna)";
}
