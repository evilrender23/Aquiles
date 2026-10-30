/**
 * Ficheros adjuntos a los mensajes del usuario.
 *
 * Cada uno se guarda en `<perfil>/adjuntos/<sesión>/<id>-<nombre>` (sin perfil, en una carpeta temporal), copiado de
 * su ruta o decodificado del base64, y al guardarlo se saca el texto que recibirá el modelo: los de texto, tal cual;
 * Word, Excel, PowerPoint y ODT, del XML (se descomprimen con el tar del sistema, que lee zip); los PDF, con pdf.js
 * (unpdf). Las imágenes las ven los proveedores que aceptan imágenes; lo demás llega como una nota con la ruta.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { type InfoAdjunto, MAX_BYTES_ADJUNTO } from "@aquiles/protocolo";
import type { AdjuntoGuardado, Mensaje } from "./tipos";

export type ClaseAdjunto = InfoAdjunto["clase"];

/** Lo que llega con un mensaje (prompt.enviar o un canal): la ruta de un fichero local o su contenido en base64. */
export interface AdjuntoEntrante {
  nombre: string;
  tipo?: string;
  ruta?: string;
  datos?: string;
}

/** Un adjunto que no vale (nombre con rutas, demasiado grande, ruta que no existe…); el mensaje no se envía. */
export class ErrorAdjunto extends Error {}

/** Texto de un adjunto que recibe el modelo, como mucho. */
export const MAX_CARACTERES = 100_000;
/** De cada XML de un documento se lee como mucho esto: un zip pequeño puede esconder un XML enorme. */
const MAX_BYTES_XML = 50 * 1024 * 1024;
const ESPERA_TAR_MS = 30_000;
const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const IMAGENES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const OFFICE = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
} as const;
type FormatoOffice = keyof typeof OFFICE;
const TEXTOS: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", jsonl: "application/jsonl", yaml: "application/yaml", yml: "application/yaml", xml: "application/xml",
  html: "text/html", htm: "text/html", log: "text/plain", svg: "image/svg+xml", css: "text/css",
  js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
};
/** Código fuente y configuración: se leen como texto plano. */
const CODIGO = new Set(
  ("ts tsx jsx py rs go java kt kts c h cc cpp hpp cs fs rb php swift sh bash zsh ps1 psm1 bat cmd sql lua r dart scala " +
    "vue svelte gd gdshader glsl hlsl toml ini cfg conf env properties gradle tex rst diff patch").split(" "),
);

const extension = (nombre: string) => extname(nombre).slice(1).toLowerCase();

function porExtension(ext: string): { tipo: string; clase: ClaseAdjunto } | undefined {
  if (IMAGENES[ext]) return { tipo: IMAGENES[ext], clase: "imagen" };
  if (ext === "pdf") return { tipo: "application/pdf", clase: "documento" };
  if (ext in OFFICE) return { tipo: OFFICE[ext as FormatoOffice], clase: "documento" };
  if (TEXTOS[ext]) return { tipo: TEXTOS[ext], clase: "texto" };
  if (CODIGO.has(ext)) return { tipo: "text/plain", clase: "texto" };
  return undefined;
}

function claseDeTipo(tipo: string): ClaseAdjunto {
  const base = tipo.split(";")[0]?.trim().toLowerCase() ?? "";
  if (Object.values(IMAGENES).includes(base)) return "imagen";
  if (base === "application/pdf" || (Object.values(OFFICE) as string[]).includes(base)) return "documento";
  if (base.startsWith("text/") || /^application\/(json|jsonl|x-ndjson|xml|yaml|x-yaml|javascript|sql)$|\+(json|xml)$/.test(base)) return "texto";
  return "otro";
}

function extensionDe(tipo: string): string | undefined {
  if (tipo === "application/pdf") return "pdf";
  for (const tabla of [IMAGENES, OFFICE, TEXTOS] as Record<string, string>[]) {
    for (const [ext, mime] of Object.entries(tabla)) if (mime === tipo) return ext;
  }
  return undefined;
}

/** Tipo de imagen según los primeros bytes: a los modelos se les manda lo que de verdad es. */
function tipoImagen(b: Uint8Array): string | undefined {
  const ascii = (desde: number, hasta: number) => String.fromCharCode(...b.subarray(desde, hasta));
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function conBom16(b: Uint8Array): boolean {
  return (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);
}

function pareceTexto(b: Uint8Array): boolean {
  if (conBom16(b)) return true;
  const muestra = b.subarray(0, 8192);
  if (muestra.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(muestra, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tipo MIME y clase de un adjunto: el tipo que dice el cliente o, si falta, el de la extensión. Las imágenes se
 * reconocen por sus bytes, porque los modelos rechazan una imagen que no es del tipo que se declara.
 */
export function clasificar(nombre: string, tipo: string | undefined, bytes: Uint8Array): { tipo: string; clase: ClaseAdjunto } {
  const imagen = tipoImagen(bytes);
  if (imagen) return { tipo: imagen, clase: "imagen" };
  const ext = extension(nombre);
  const conocido = porExtension(ext);
  // «application/octet-stream» es lo que manda el navegador cuando no sabe qué es: no dice nada.
  const dado = tipo?.trim() && tipo.trim() !== "application/octet-stream" ? tipo.trim() : undefined;
  const final = dado ?? conocido?.tipo;
  let clase = conocido?.clase ?? (final ? claseDeTipo(final) : "otro");
  // Dice ser una imagen, pero sus bytes no lo son.
  if (clase === "imagen") clase = "otro";
  if (clase === "otro" && !ext && pareceTexto(bytes)) return { tipo: final ?? "text/plain", clase: "texto" };
  return { tipo: final ?? "application/octet-stream", clase };
}

function validarNombre(nombre: string): void {
  if (/[\\/]/.test(nombre) || /^[a-z]:/i.test(nombre) || /^\.+$/.test(nombre.trim())) {
    throw new ErrorAdjunto(`Nombre de adjunto no válido: «${nombre}». Tiene que ser solo el nombre del fichero, sin rutas.`);
  }
}

/**
 * Nombre en disco: sin lo que Windows no admite (ni puntos o espacios al final, que quita sin avisar) ni comas, con
 * las que codex separa las rutas de `-i`. Si no tiene extensión, se le pone la de su tipo.
 */
function nombreEnDisco(nombre: string, tipo: string): string {
  let n = nombre.replace(/[<>:"|?*,]/g, "_").replace(/\p{Cc}/gu, "_").replace(/[. ]+$/, "");
  if (!extname(n)) {
    const ext = extensionDe(tipo);
    if (ext) n += `.${ext}`;
  }
  const ext = extname(n);
  // Rutas cortas: muchas herramientas de Windows fallan por encima de 260 caracteres.
  if (n.length > 120) n = n.slice(0, 120 - ext.length) + ext;
  return n || "adjunto";
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;

function comprobarTamano(nombre: string, bytes: number): void {
  if (bytes > MAX_BYTES_ADJUNTO) throw new ErrorAdjunto(`«${nombre}» ocupa ${mb(bytes)}; el máximo por adjunto es ${mb(MAX_BYTES_ADJUNTO)}`);
}

/** El base64 de `datos`; se admite también una data URL entera (lo que da FileReader en el navegador). */
const base64De = (datos: string) => datos.replace(/^data:[^,]*;base64,/, "").replace(/\s/g, "");

/** Comprueba un adjunto sin leerlo entero: nombre, tamaño y, si es una ruta, que exista y sea un fichero. */
async function validar(a: AdjuntoEntrante): Promise<void> {
  validarNombre(a.nombre);
  if (a.ruta !== undefined) {
    if (!isAbsolute(a.ruta)) throw new ErrorAdjunto(`La ruta de «${a.nombre}» tiene que ser absoluta: ${a.ruta}`);
    const info = await stat(a.ruta).catch(() => undefined);
    if (!info) throw new ErrorAdjunto(`No existe el fichero de «${a.nombre}»: ${a.ruta}`);
    if (!info.isFile()) throw new ErrorAdjunto(`«${a.nombre}» no es un fichero: ${a.ruta}`);
    comprobarTamano(a.nombre, info.size);
    return;
  }
  const datos = base64De(a.datos ?? "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(datos) || datos.length % 4 === 1) throw new ErrorAdjunto(`El contenido de «${a.nombre}» no es base64 válido`);
  comprobarTamano(a.nombre, Math.floor((datos.length * 3) / 4) - (datos.match(/=+$/)?.[0].length ?? 0));
}

async function contenido(a: AdjuntoEntrante): Promise<Uint8Array> {
  const bytes = a.ruta !== undefined ? await Bun.file(a.ruta).bytes() : Buffer.from(base64De(a.datos ?? ""), "base64");
  comprobarTamano(a.nombre, bytes.length);
  return bytes;
}

/**
 * Valida y guarda los adjuntos de un mensaje en `dir`, con su texto extraído. Se validan todos antes de guardar
 * ninguno; si algo falla a medias, se borra lo guardado.
 */
export async function guardarAdjuntos(entrantes: readonly AdjuntoEntrante[], dir: string): Promise<AdjuntoGuardado[]> {
  for (const a of entrantes) await validar(a);
  await mkdir(dir, { recursive: true });
  const guardados: AdjuntoGuardado[] = [];
  try {
    for (const a of entrantes) {
      const bytes = await contenido(a);
      const { tipo, clase } = clasificar(a.nombre, a.tipo, bytes);
      const id = randomUUID().replace(/-/g, "").slice(0, 12);
      const ruta = join(dir, `${id}-${nombreEnDisco(a.nombre, tipo)}`);
      await writeFile(ruta, bytes);
      const g: AdjuntoGuardado = { id, nombre: a.nombre, tipo, bytes: bytes.length, clase, ruta };
      guardados.push(g);
      const texto = await extraerTexto(bytes, ruta, tipo, clase);
      if (texto !== undefined) g.texto = texto;
    }
  } catch (e) {
    await borrarAdjuntos(guardados);
    throw e;
  }
  return guardados;
}

export async function borrarAdjuntos(adjuntos: readonly AdjuntoGuardado[]): Promise<void> {
  for (const a of adjuntos) await rm(a.ruta, { force: true });
}

/** Carpeta de los adjuntos de una sesión. */
export function carpetaAdjuntos(perfil: string | null, sesionId: string): string {
  return join(perfil ? join(perfil, "adjuntos") : join(tmpdir(), "aquiles-adjuntos"), sesionId);
}

/** Contenido de un adjunto guardado en `dir` (la carpeta de su sesión), en base64; undefined si no está. */
export async function leerAdjunto(dir: string, id: string): Promise<{ tipo: string; datos: string } | undefined> {
  if (!/^[0-9a-f]{12}$/.test(id) || !existsSync(dir)) return undefined;
  const fichero = readdirSync(dir).find((f) => f.startsWith(`${id}-`));
  if (!fichero) return undefined;
  const bytes = await Bun.file(join(dir, fichero)).bytes();
  return { tipo: clasificar(fichero, undefined, bytes).tipo, datos: Buffer.from(bytes).toString("base64") };
}

/** Lo que ve la interfaz: sin el texto extraído, solo cuánto ocupa. */
export function infoAdjunto({ texto, ...info }: AdjuntoGuardado): InfoAdjunto {
  return texto === undefined ? info : { ...info, caracteres: texto.length };
}

// ——— Texto para el modelo ———

/** Texto para el modelo; undefined si no hay nada que sacar o falla (el modelo recibe entonces una nota con la ruta). */
async function extraerTexto(bytes: Uint8Array, ruta: string, tipo: string, clase: ClaseAdjunto): Promise<string | undefined> {
  let texto: string | undefined;
  try {
    if (clase === "texto") texto = decodificarTexto(bytes);
    else if (clase === "documento") {
      const ext = extension(ruta);
      if (ext === "pdf" || tipo === "application/pdf") texto = await textoPdf(bytes);
      else {
        const formato = ext in OFFICE ? (ext as FormatoOffice) : (Object.keys(OFFICE) as FormatoOffice[]).find((k) => OFFICE[k] === tipo);
        if (formato) texto = await textoOffice(bytes, formato);
      }
    }
  } catch {
    return undefined;
  }
  if (!texto?.trim()) return undefined;
  if (texto.length <= MAX_CARACTERES) return texto;
  const miles = (n: number) => n.toLocaleString("es-ES");
  return (
    `${texto.slice(0, MAX_CARACTERES)}\n\n[Recortado: el texto entero tiene ${miles(texto.length)} caracteres y aquí van los ` +
    `${miles(MAX_CARACTERES)} primeros. El fichero está en ${ruta}.]`
  );
}

/** UTF-8 (con o sin BOM), UTF-16 con BOM y, si no es UTF-8 válido, latin1. */
function decodificarTexto(b: Uint8Array): string {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("latin1").decode(b);
  }
}

async function textoPdf(bytes: Uint8Array): Promise<string> {
  // pdf.js pesa: se carga la primera vez que hace falta.
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js se queda con el buffer que recibe, y rechaza un Buffer de Node (los adjuntos en `datos` llegan así): copia
  // en un Uint8Array normal. Sin avisos: irían a stdout, por donde el núcleo dice que está listo.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    if (!text.some((t) => t.trim())) return "";
    return text.length === 1 ? (text[0] ?? "") : text.map((t, i) => `[Página ${i + 1}]\n${t.trim()}`).join("\n\n");
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const MIEMBROS: Record<FormatoOffice, string[]> = {
  docx: ["word/document.xml"],
  pptx: ["ppt/slides/slide*.xml"],
  xlsx: ["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", "xl/worksheets/*.xml"],
  odt: ["content.xml"],
};

/** Descomprime del documento solo lo que hace falta, en una carpeta temporal, y saca el texto del XML. */
async function textoOffice(bytes: Uint8Array, formato: FormatoOffice): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aquiles-doc-"));
  try {
    // Todo relativo a la carpeta temporal: el tar de Windows no se lleva bien con rutas que no son ASCII.
    await writeFile(join(dir, "doc.zip"), bytes);
    const p = Bun.spawn([TAR, "-xf", "doc.zip", ...MIEMBROS[formato]], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    const limite = setTimeout(() => p.kill(), ESPERA_TAR_MS);
    // Si falta algún miembro (un libro sin cadenas compartidas), tar acaba con error pero saca los demás.
    await p.exited;
    clearTimeout(limite);
    const xml = async (ruta: string) => (existsSync(join(dir, ruta)) ? await Bun.file(join(dir, ruta)).slice(0, MAX_BYTES_XML).text() : undefined);

    if (formato === "docx") return textoOoxml((await xml("word/document.xml")) ?? "");
    if (formato === "odt") return textoOdt((await xml("content.xml")) ?? "");
    if (formato === "pptx") {
      const carpeta = join(dir, "ppt", "slides");
      const numeros = existsSync(carpeta)
        ? (await readdir(carpeta)).flatMap((f) => /^slide(\d+)\.xml$/.exec(f)?.[1] ?? []).map(Number).sort((a, b) => a - b)
        : [];
      const partes: string[] = [];
      for (const n of numeros) partes.push(`[Diapositiva ${n}]\n${textoOoxml((await xml(`ppt/slides/slide${n}.xml`)) ?? "")}`);
      return partes.join("\n\n");
    }
    const compartidas = cadenasCompartidas((await xml("xl/sharedStrings.xml")) ?? "");
    const partes: string[] = [];
    for (const h of hojasXlsx((await xml("xl/workbook.xml")) ?? "", (await xml("xl/_rels/workbook.xml.rels")) ?? "")) {
      const hoja = await xml(h.ruta);
      if (hoja !== undefined) partes.push(`[Hoja: ${h.nombre}]\n${filasHoja(hoja, compartidas)}`);
    }
    return partes.join("\n\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ——— XML sin dependencias ———

interface Etiqueta {
  /** Nombre sin prefijo de espacio de nombres (`w:t` → `t`). */
  nombre: string;
  atributos: string;
  abre: boolean;
  /** También en las vacías (`<w:tab/>` abre y cierra). */
  cierra: boolean;
}

/** +1 al abrir, −1 al cerrar y 0 en las vacías: para saber si se está dentro de un elemento. */
const profundidad = (n: Etiqueta) => (n.abre === n.cierra ? 0 : n.abre ? 1 : -1);

const ENTIDADES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodificarEntidades(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (todo, e: string) => {
    if (e[0] !== "#") return ENTIDADES[e] ?? todo;
    const codigo = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return codigo > 0 && codigo <= 0x10ffff ? String.fromCodePoint(codigo) : todo;
  });
}

/** Etiquetas y trozos de texto (ya decodificados), en orden. */
function* nodosXml(xml: string): Generator<Etiqueta | string> {
  const re = /<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<[!?][\s\S]*?>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    if (m[2]) yield { nombre: m[2].slice(m[2].indexOf(":") + 1), atributos: m[3] ?? "", abre: !m[1], cierra: Boolean(m[1] || m[4]) };
    else if (m[5] !== undefined) yield m[5];
    else if (m[6] !== undefined) yield decodificarEntidades(m[6]);
  }
}

function atributo(atributos: string, nombre: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${nombre}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(atributos);
  return m ? decodificarEntidades(m[1] ?? m[2] ?? "") : undefined;
}

/** Une los trozos: sin espacios antes de tabuladores y saltos, y como mucho una línea en blanco seguida. */
const unir = (partes: string[]) => partes.join("").replace(/ +(?=[\t\n])/g, "").replace(/\n{3,}/g, "\n\n").trim();

/**
 * Texto de Word (`word/document.xml`) o de una diapositiva (`ppt/slides/slideN.xml`): párrafos en líneas y tablas
 * con las celdas separadas por tabuladores. Se salta `mc:Fallback`, que repite el texto de los cuadros de texto.
 */
function textoOoxml(xml: string): string {
  const partes: string[] = [];
  let enTexto = false;
  let runs = 0;
  let celdas = 0;
  let celdaEnFila = 0;
  let respaldo = 0;
  for (const n of nodosXml(xml)) {
    if (typeof n === "string") {
      if (enTexto && !respaldo) partes.push(n);
      continue;
    }
    if (n.nombre === "Fallback") respaldo += profundidad(n);
    if (respaldo) continue;
    switch (n.nombre) {
      case "t":
        enTexto = n.abre && !n.cierra;
        break;
      case "r":
        runs += profundidad(n);
        break;
      // En las propiedades del párrafo también hay `tab` (las tabulaciones definidas), pero eso no es texto.
      case "tab":
        if (runs > 0) partes.push("\t");
        break;
      case "br":
      case "cr":
        partes.push("\n");
        break;
      case "p":
        if (n.cierra) partes.push(celdas > 0 ? " " : "\n");
        break;
      case "tr":
        if (n.abre) celdaEnFila = 0;
        if (n.cierra) partes.push("\n");
        break;
      case "tc":
        if (n.abre && celdaEnFila++ > 0) partes.push("\t");
        celdas += profundidad(n);
        break;
      case "tbl":
        partes.push("\n");
        break;
    }
  }
  return unir(partes);
}

/** Texto de un ODT (`content.xml`): el de los párrafos y títulos del cuerpo, con las tablas como en Word. */
function textoOdt(xml: string): string {
  const partes: string[] = [];
  let parrafos = 0;
  let celdas = 0;
  let celdaEnFila = 0;
  for (const n of nodosXml(xml)) {
    // En ODF, los espacios seguidos cuentan como uno; los que se quieren se escriben con `text:s`.
    if (typeof n === "string") {
      if (parrafos > 0) partes.push(n.replace(/[ \t\r\n]+/g, " "));
      continue;
    }
    switch (n.nombre) {
      case "p":
      case "h":
        parrafos += profundidad(n);
        if (n.cierra) partes.push(celdas > 0 ? " " : "\n");
        break;
      case "s":
        partes.push(" ".repeat(Math.min(1000, Number(atributo(n.atributos, "text:c") ?? 1) || 1)));
        break;
      case "tab":
        partes.push("\t");
        break;
      case "line-break":
        partes.push("\n");
        break;
      case "table-row":
        if (n.abre) celdaEnFila = 0;
        if (n.cierra) partes.push("\n");
        break;
      case "table-cell":
      case "covered-table-cell":
        if (n.abre && celdaEnFila++ > 0) partes.push("\t");
        celdas += profundidad(n);
        break;
    }
  }
  return unir(partes);
}

/** `xl/sharedStrings.xml`: el texto de cada `si`, sin las guías fonéticas (`rPh`). */
function cadenasCompartidas(xml: string): string[] {
  const lista: string[] = [];
  let actual: string[] | undefined;
  let enTexto = false;
  let fonetica = 0;
  for (const n of nodosXml(xml)) {
    if (typeof n === "string") {
      if (actual && enTexto && !fonetica) actual.push(n);
      continue;
    }
    if (n.nombre === "si") {
      if (n.abre) actual = [];
      if (n.cierra && actual) {
        lista.push(actual.join(""));
        actual = undefined;
      }
    } else if (n.nombre === "t") enTexto = n.abre && !n.cierra;
    else if (n.nombre === "rPh") fonetica += profundidad(n);
  }
  return lista;
}

/** Hojas del libro en su orden, con la ruta de su XML (de `xl/workbook.xml` y sus relaciones). */
function hojasXlsx(libro: string, relaciones: string): { nombre: string; ruta: string }[] {
  const destinos = new Map<string, string>();
  for (const n of nodosXml(relaciones)) {
    if (typeof n === "string" || n.nombre !== "Relationship" || !n.abre) continue;
    const id = atributo(n.atributos, "Id");
    const destino = atributo(n.atributos, "Target");
    if (id && destino) destinos.set(id, destino.startsWith("/") ? destino.slice(1) : `xl/${destino}`);
  }
  const hojas: { nombre: string; ruta: string }[] = [];
  for (const n of nodosXml(libro)) {
    if (typeof n === "string" || n.nombre !== "sheet" || !n.abre) continue;
    const nombre = atributo(n.atributos, "name");
    const ruta = destinos.get(atributo(n.atributos, "r:id") ?? "");
    if (nombre && ruta) hojas.push({ nombre, ruta });
  }
  return hojas;
}

/** Columna (desde 0) de una referencia como `AB12`; Excel llega hasta la 16.384. */
function columna(ref: string | undefined): number | undefined {
  const letras = /^[A-Z]+/i.exec(ref ?? "")?.[0];
  if (!letras) return undefined;
  let n = 0;
  for (const l of letras.toUpperCase()) n = n * 26 + (l.charCodeAt(0) - 64);
  return n <= 16_384 ? n - 1 : undefined;
}

/** Las filas de una hoja, con las celdas separadas por tabuladores (las vacías dejan su hueco). */
function filasHoja(xml: string, compartidas: string[]): string {
  const filas: string[] = [];
  let celdas: string[] = [];
  let celda: { col: number; tipo?: string; valor: string } | undefined;
  let enValor = false;
  for (const n of nodosXml(xml)) {
    if (typeof n === "string") {
      if (celda && enValor) celda.valor += n;
      continue;
    }
    if (n.nombre === "row") {
      if (n.abre) celdas = [];
      if (n.cierra) {
        while (celdas.length && !celdas.at(-1)) celdas.pop();
        if (celdas.length) filas.push(Array.from(celdas, (c) => c ?? "").join("\t"));
      }
    } else if (n.nombre === "c") {
      if (n.abre) celda = { col: columna(atributo(n.atributos, "r")) ?? celdas.length, tipo: atributo(n.atributos, "t"), valor: "" };
      if (n.cierra && celda) {
        const v = celda.tipo === "s" ? (compartidas[Number(celda.valor)] ?? "") : celda.tipo === "b" ? (celda.valor === "1" ? "VERDADERO" : "FALSO") : celda.valor;
        celdas[celda.col] = v.replace(/[\t\r\n]+/g, " ");
        celda = undefined;
      }
    } else if (n.nombre === "v" || n.nombre === "t") enValor = n.abre && !n.cierra;
  }
  return filas.join("\n");
}

// ——— Lo que recibe cada proveedor ———

/** Cómo llega una imagen al modelo: entera en el mensaje o solo nombrada, con el motivo. */
export type VistaImagen = "adjunta" | "sin-vision" | "antigua" | "limite" | "grande" | "perdida";

const NOTAS_IMAGEN: Record<VistaImagen, string> = {
  adjunta: "Imagen adjunta a este mensaje.",
  "sin-vision": "Imagen que no puedes ver desde aquí. Está guardada en esa ruta: usa tus herramientas si necesitas algo de ella.",
  antigua: "Imagen de un mensaje anterior que ya no se reenvía. Está guardada en esa ruta.",
  limite: "Imagen que no cabe en esta petición (hay demasiadas). Está guardada en esa ruta.",
  grande: "Imagen demasiado grande para mandarla al modelo. Está guardada en esa ruta.",
  perdida: "Imagen que ya no está en esa ruta.",
};
const SIN_TEXTO = "No hay texto extraído de este fichero. Está guardado en esa ruta: usa tus herramientas si necesitas leerlo.";

const escapar = (v: string) => v.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c] ?? c);

/** `<adjunto nombre="…" tipo="…" ruta="…">` con el texto extraído o, si no hay, una nota para que use sus herramientas. */
export function bloqueAdjunto(a: AdjuntoGuardado, vista: VistaImagen = "sin-vision"): string {
  const cuerpo = a.clase === "imagen" ? NOTAS_IMAGEN[vista] : (a.texto ?? SIN_TEXTO);
  return `<adjunto nombre="${escapar(a.nombre)}" tipo="${escapar(a.tipo)}" ruta="${escapar(a.ruta)}">\n${cuerpo}\n</adjunto>`;
}

/** Texto de un mensaje del usuario con sus adjuntos detrás. Sin `vistas`, el modelo no ve imágenes. */
export function textoUsuario(m: { texto: string; adjuntos?: readonly AdjuntoGuardado[] }, vistas?: ReadonlyMap<string, VistaImagen>): string {
  const bloques = (m.adjuntos ?? []).map((a) => bloqueAdjunto(a, vistas?.get(a.id) ?? "sin-vision"));
  return [m.texto, ...bloques].filter((t) => t.trim()).join("\n\n");
}

export interface LimitesImagenes {
  /** Van las imágenes de los últimos N mensajes del usuario que tienen alguna; las anteriores se quedan en nota. */
  mensajes: number;
  maxImagenes: number;
  maxBytesImagen: number;
  maxBytesTotal: number;
}

/**
 * Para anthropic, openai y el CLI de claude: como mucho 5 MB de base64 por imagen y peticiones bastante por debajo
 * de los 32 MB. anthropic y openai reenvían la conversación entera en cada llamada, así que solo van las recientes.
 */
export const LIMITES_API: LimitesImagenes = { mensajes: 4, maxImagenes: 20, maxBytesImagen: 3_750_000, maxBytesTotal: 15_000_000 };

/** Qué imágenes de la conversación van enteras y por qué no van las demás, por id de adjunto. */
export function verImagenes(mensajes: readonly Mensaje[], l: LimitesImagenes): Map<string, VistaImagen> {
  const vistas = new Map<string, VistaImagen>();
  let conImagenes = 0;
  let n = 0;
  let total = 0;
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i];
    const imagenes = m?.rol === "usuario" ? (m.adjuntos ?? []).filter((a) => a.clase === "imagen") : [];
    if (!imagenes.length) continue;
    conImagenes += 1;
    for (const a of imagenes) {
      let vista: VistaImagen = "adjunta";
      if (conImagenes > l.mensajes) vista = "antigua";
      else if (a.bytes > l.maxBytesImagen) vista = "grande";
      else if (n >= l.maxImagenes || total + a.bytes > l.maxBytesTotal) vista = "limite";
      else if (!existsSync(a.ruta)) vista = "perdida";
      if (vista === "adjunta") {
        n += 1;
        total += a.bytes;
      }
      vistas.set(a.id, vista);
    }
  }
  return vistas;
}

/** Imágenes de un mensaje que van enteras al modelo. */
export function imagenesAdjuntas(m: Mensaje, vistas: ReadonlyMap<string, VistaImagen>): AdjuntoGuardado[] {
  return m.rol === "usuario" ? (m.adjuntos ?? []).filter((a) => vistas.get(a.id) === "adjunta") : [];
}

export const base64 = (a: AdjuntoGuardado): string => readFileSync(a.ruta).toString("base64");
