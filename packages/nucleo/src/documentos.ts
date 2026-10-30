/**
 * Documentos de Word y Markdown.
 *
 * - Escribir: la herramienta `escribir_documento` y «Guardar como Word» convierten markdown en .docx con `docx`. El
 *   markdown se analiza con mdast + GFM, el mismo analizador que usa el Markdown de la app, así que el Word lleva lo
 *   mismo que se ve en la vista.
 * - Ver: `documentos.leer` da los .md tal cual y los .docx convertidos a HTML con `mammoth`; la app los enseña en la
 *   vista aislada de los artefactos.
 *
 * Las librerías se cargan al primer uso, para que el núcleo arranque sin ellas.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type * as Docx from "docx";
import type { FootnoteDefinition, List, ListItem, Nodes, PhrasingContent, Root, RootContent, Table } from "mdast";
import { guardarArtefacto } from "./artefactos";

export type FormatoDocumento = "markdown" | "html";

export interface DocumentoLeido {
  nombre: string;
  formato: FormatoDocumento;
  contenido: string;
}

/** Lo que el visor enseña como markdown, tal cual. */
export const EXTENSIONES_MARKDOWN = [".md", ".markdown", ".txt"];
const MAX_BYTES_DOCUMENTO = 25 * 1024 * 1024;
/** `artefactos.vista` admite 5 millones de caracteres, y la app aún envuelve el HTML en su página. */
const MAX_HTML = 4_800_000;
/** Base64 de las imágenes que se incrustan en la vista; las que no caben se cambian por un aviso. */
const MAX_IMAGENES = 3_500_000;

/** Lee un documento para el visor: .md (y .markdown, .txt) como markdown; .docx convertido a HTML (sin <html> ni <body>). */
export async function leerDocumento(ruta: string): Promise<DocumentoLeido> {
  if (!isAbsolute(ruta)) throw new Error(`La ruta del documento tiene que ser absoluta: ${ruta}`);
  const nombre = basename(ruta);
  const ext = extname(ruta).toLowerCase();
  const markdown = EXTENSIONES_MARKDOWN.includes(ext);
  if (!markdown && ext !== ".docx") throw new Error(`${nombre} no es un documento que se pueda ver (.md o .docx)`);
  const info = await stat(ruta).catch(() => undefined);
  if (!info) throw new Error(`No existe ${ruta}`);
  if (!info.isFile()) throw new Error(`${ruta} no es un fichero`);
  if (info.size > MAX_BYTES_DOCUMENTO) throw new Error(`${nombre} ocupa ${Math.round(info.size / 1024 / 1024)} MB; demasiado para verlo aquí`);
  const bytes = await readFile(ruta);
  // TextDecoder quita el BOM.
  if (markdown) return { nombre, formato: "markdown", contenido: new TextDecoder().decode(bytes) };
  return { nombre, formato: "html", contenido: await docxAHtml(bytes) };
}

/** Escribe el markdown como .docx en la carpeta de trabajo (como `guardarArtefacto`: si existe y no hay `sobrescribir`, FicheroYaExiste). */
export async function exportarDocumento(cwd: string, nombre: string, markdown: string, sobrescribir = false): Promise<string> {
  const limpio = nombre.trim();
  const conExtension = /\.docx$/i.test(limpio) ? limpio : `${limpio}.docx`;
  return guardarArtefacto(cwd, conExtension, await markdownADocx(markdown), sobrescribir);
}

/* ── .docx → HTML ─────────────────────────────────── */

/** Además del mapa por defecto de mammoth (títulos, listas, tablas…): los estilos que pone `markdownADocx`. */
const MAPA_ESTILOS = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='HTML Preformatted'] => pre:fresh",
  "r[style-name='HTML Code'] => code",
];

const IMAGEN_OMITIDA = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="64"><rect width="100%" height="100%" fill="#f2f2f2" stroke="#bfbfbf"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#666">Imagen omitida en la vista</text></svg>',
)}`;

export async function docxAHtml(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import("mammoth")).default;
  let usado = 0;
  const imagenes = mammoth.images.imgElement(async (imagen) => {
    const base64 = await imagen.readAsBase64String();
    if (usado + base64.length > MAX_IMAGENES) return { src: IMAGEN_OMITIDA };
    usado += base64.length;
    return { src: `data:${imagen.contentType};base64,${base64}` };
  });
  let html: string;
  try {
    // mammoth no escribe en la consola: sus avisos vuelven en `messages`, que aquí no interesan.
    html = (await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, { styleMap: MAPA_ESTILOS, convertImage: imagenes })).value;
  } catch (e) {
    throw new Error(`No se pudo leer el documento de Word: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (html.length > MAX_HTML) throw new Error("El documento es demasiado grande para verlo aquí");
  return html;
}

/* ── markdown → .docx ─────────────────────────────── */

/** Convierte markdown (con tablas, tachado, casillas y notas al pie de GFM) en los bytes de un .docx. */
export async function markdownADocx(markdown: string): Promise<Uint8Array> {
  const [d, { fromMarkdown }, { gfm }, { gfmFromMarkdown }] = await Promise.all([
    import("docx"),
    import("mdast-util-from-markdown"),
    import("micromark-extension-gfm"),
    import("mdast-util-gfm"),
  ]);
  const arbol = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return d.Packer.toBuffer(new ConversorWord(d, arbol).documento());
}

type Libreria = typeof Docx;
type Bloque = Docx.Paragraph | Docx.Table;

interface Formato {
  negrita?: boolean;
  cursiva?: boolean;
  tachado?: boolean;
  enlace?: boolean;
}

/** Dónde cae un bloque: nivel de lista (-1 fuera de listas) y si está dentro de una cita. */
interface Lugar {
  nivel: number;
  cita: boolean;
}

type Numeracion = { numbering: { reference: string; level: number; instance?: number } };

const FUERA: Lugar = { nivel: -1, cita: false };
const VINETAS = ["•", "◦", "▪"];
const BORDE_GRIS = "BFBFBF";
/** Sangría izquierda de un nivel de lista, en veinteavos de punto (como Word: media pulgada por nivel). */
const sangria = (nivel: number) => 720 * (nivel + 1);
const esExterno = (url: string) => /^(https?|mailto|ftp|file):/i.test(url);

function textoPlano(n: Nodes): string {
  if ("value" in n && typeof n.value === "string") return n.value;
  if ("children" in n) return (n.children as Nodes[]).map(textoPlano).join("");
  return "";
}

class ConversorWord {
  private readonly definiciones = new Map<string, string>();
  private readonly notas = new Map<string, FootnoteDefinition>();
  /** Notas al pie ya usadas: identificador → número en el documento. */
  private readonly numeroNota = new Map<string, number>();
  private readonly piesDePagina: Record<string, { children: Docx.Paragraph[] }> = {};
  /** Cada lista numerada es una instancia propia, para que empiece a contar de nuevo. */
  private instancias = 0;
  /** Listas numeradas que no empiezan en 1 («3. …»): una definición de numeración por cada inicio. */
  private readonly inicios = new Set<number>();

  constructor(
    private readonly d: Libreria,
    private readonly arbol: Root,
  ) {
    const recoger = (n: Nodes) => {
      if (n.type === "definition") this.definiciones.set(n.identifier, n.url);
      else if (n.type === "footnoteDefinition") this.notas.set(n.identifier, n);
      if ("children" in n) for (const h of n.children as Nodes[]) recoger(h);
    };
    recoger(arbol);
  }

  documento(): Docx.Document {
    const { d } = this;
    const cuerpo = this.bloques(this.arbol.children, FUERA);
    const titulo = this.arbol.children.find((n) => n.type === "heading");
    return new d.Document({
      creator: "Aquiles",
      ...(titulo ? { title: textoPlano(titulo).slice(0, 200) } : {}),
      styles: this.estilos(),
      numbering: { config: this.numeraciones() },
      footnotes: this.piesDePagina,
      sections: [{ children: cuerpo.length ? cuerpo : [new d.Paragraph({})] }],
    });
  }

  /* Bloques */

  private bloques(nodos: readonly RootContent[], lugar: Lugar): Bloque[] {
    return nodos.flatMap((n) => this.bloque(n, lugar));
  }

  private bloque(n: RootContent, lugar: Lugar): Bloque[] {
    const { d } = this;
    switch (n.type) {
      case "heading":
        return [new d.Paragraph({ heading: TITULOS[n.depth - 1], children: this.enLinea(n.children, {}) })];
      case "paragraph":
        return [this.parrafo(this.enLinea(n.children, {}), lugar)];
      case "blockquote":
        return this.bloques(n.children, { ...lugar, cita: true });
      case "list":
        return this.lista(n, lugar);
      case "code":
        return [this.codigo(n.value, lugar)];
      case "table":
        // Un párrafo detrás separa la tabla de lo que siga (dos tablas seguidas se juntarían en una).
        return [this.tabla(n), new d.Paragraph({})];
      case "thematicBreak":
        return [new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: BORDE_GRIS, space: 1 } }, children: [] })];
      case "html":
        return /^\s*<!--[\s\S]*-->\s*$/.test(n.value) ? [] : [this.parrafo([this.texto(n.value, {})], lugar)];
      default:
        // definition y footnoteDefinition se resuelven donde se usan.
        return [];
    }
  }

  private parrafo(hijos: Docx.ParagraphChild[], lugar: Lugar, numeracion?: Numeracion): Docx.Paragraph {
    return new this.d.Paragraph({
      children: hijos,
      ...(lugar.cita ? { style: "Quote" } : {}),
      ...(numeracion ?? (lugar.nivel >= 0 ? { indent: { left: sangria(lugar.nivel) } } : {})),
    });
  }

  private lista(n: List, lugar: Lugar): Bloque[] {
    const nivel = Math.min(lugar.nivel + 1, 8);
    let numeracion: Numeracion;
    if (n.ordered) {
      const inicio = n.start ?? 1;
      if (inicio !== 1) this.inicios.add(inicio);
      numeracion = { numbering: { reference: inicio === 1 ? "numerada" : `numerada-${inicio}`, level: nivel, instance: ++this.instancias } };
    } else {
      numeracion = { numbering: { reference: "vinetas", level: nivel } };
    }
    return n.children.flatMap((item) => this.elemento(item, { ...lugar, nivel }, numeracion));
  }

  /** El primer párrafo del elemento lleva la viñeta o el número; lo demás (más párrafos, código, sublistas) va sangrado. */
  private elemento(item: ListItem, lugar: Lugar, numeracion: Numeracion): Bloque[] {
    const casilla = item.checked === true ? [this.texto("☑ ", {})] : item.checked === false ? [this.texto("☐ ", {})] : [];
    const salida: Bloque[] = [];
    let numerado = false;
    for (const hijo of item.children) {
      if (!numerado && hijo.type === "paragraph") {
        salida.push(this.parrafo([...casilla, ...this.enLinea(hijo.children, {})], lugar, numeracion));
        numerado = true;
      } else {
        salida.push(...this.bloque(hijo, lugar));
      }
    }
    if (!numerado) salida.unshift(this.parrafo(casilla, lugar, numeracion));
    return salida;
  }

  private codigo(texto: string, lugar: Lugar): Docx.Paragraph {
    const { d } = this;
    const lineas = texto.replace(/\t/g, "    ").split(/\r?\n/);
    return new d.Paragraph({
      style: "HTMLPreformatted",
      children: lineas.map((l, i) => new d.TextRun({ text: l, ...(i > 0 ? { break: 1 } : {}) })),
      ...(lugar.nivel >= 0 ? { indent: { left: sangria(lugar.nivel) } } : {}),
    });
  }

  private tabla(n: Table): Docx.Table {
    const { d } = this;
    const columnas = Math.max(1, ...n.children.map((f) => f.children.length));
    const alineacion = (j: number) => {
      const a = n.align?.[j];
      return a === "center" ? d.AlignmentType.CENTER : a === "right" ? d.AlignmentType.RIGHT : undefined;
    };
    const borde = { style: d.BorderStyle.SINGLE, size: 4, color: BORDE_GRIS };
    return new d.Table({
      width: { size: 100, type: d.WidthType.PERCENTAGE },
      borders: { top: borde, bottom: borde, left: borde, right: borde, insideHorizontal: borde, insideVertical: borde },
      rows: n.children.map(
        (fila, i) =>
          new d.TableRow({
            // La primera fila es la cabecera: se repite en cada página y mammoth la lee como <thead>. En las demás no
            // va ni `false`: mammoth solo mira si el elemento está.
            ...(i === 0 ? { tableHeader: true } : {}),
            children: Array.from({ length: columnas }, (_, j) => {
              const celda = fila.children[j];
              const a = alineacion(j);
              return new d.TableCell({
                ...(i === 0 ? { shading: { type: d.ShadingType.CLEAR, color: "auto", fill: "F2F2F2" } } : {}),
                margins: { top: 60, bottom: 60, left: 100, right: 100 },
                children: [
                  new d.Paragraph({
                    spacing: { after: 0 },
                    ...(a ? { alignment: a } : {}),
                    children: celda ? this.enLinea(celda.children, i === 0 ? { negrita: true } : {}) : [],
                  }),
                ],
              });
            }),
          }),
      ),
    });
  }

  /* En línea */

  private enLinea(nodos: readonly PhrasingContent[], f: Formato): Docx.ParagraphChild[] {
    return nodos.flatMap((n) => this.trozo(n, f));
  }

  private trozo(n: PhrasingContent, f: Formato): Docx.ParagraphChild[] {
    const { d } = this;
    switch (n.type) {
      case "text":
        // Un salto de línea dentro de un párrafo de markdown es un espacio.
        return [this.texto(n.value.replace(/[ \t]*\r?\n[ \t]*/g, " "), f)];
      case "strong":
        return this.enLinea(n.children, { ...f, negrita: true });
      case "emphasis":
        return this.enLinea(n.children, { ...f, cursiva: true });
      case "delete":
        return this.enLinea(n.children, { ...f, tachado: true });
      case "inlineCode":
        return [this.texto(n.value, f, "HTMLCode")];
      case "break":
        return [new d.TextRun({ break: 1 })];
      case "link":
        return this.enlace(n.url, n.children, f);
      case "linkReference":
        return this.enlace(this.definiciones.get(n.identifier), n.children, f);
      case "image":
        return this.imagen(n.alt, n.url, f);
      case "imageReference":
        return this.imagen(n.alt, this.definiciones.get(n.identifier), f);
      case "footnoteReference":
        return [this.nota(n.identifier, n.label ?? n.identifier, f)];
      case "html":
        return [this.texto(n.value, f)];
      default:
        return [];
    }
  }

  private texto(text: string, f: Formato, estilo?: string): Docx.TextRun {
    const style = estilo ?? (f.enlace ? "Hyperlink" : undefined);
    return new this.d.TextRun({
      text,
      ...(f.negrita ? { bold: true } : {}),
      ...(f.cursiva ? { italics: true } : {}),
      ...(f.tachado ? { strike: true } : {}),
      ...(style ? { style } : {}),
    });
  }

  /** Solo se enlazan las direcciones completas (https:, mailto:…); un ancla o una ruta relativa se queda en texto. */
  private enlace(url: string | undefined, hijos: readonly PhrasingContent[], f: Formato): Docx.ParagraphChild[] {
    if (!url || !esExterno(url)) return this.enLinea(hijos, f);
    return [new this.d.ExternalHyperlink({ link: url, children: this.enLinea(hijos, { ...f, enlace: true }) })];
  }

  /** Las imágenes no se incrustan: queda su texto alternativo, enlazado a la imagen si es una dirección completa. */
  private imagen(alt: string | null | undefined, url: string | undefined, f: Formato): Docx.ParagraphChild[] {
    const texto = this.texto(alt ? `[Imagen: ${alt}]` : "[Imagen]", { ...f, cursiva: true, enlace: !!url && esExterno(url) });
    return url && esExterno(url) ? [new this.d.ExternalHyperlink({ link: url, children: [texto] })] : [texto];
  }

  private nota(identificador: string, etiqueta: string, f: Formato): Docx.ParagraphChild {
    const definicion = this.notas.get(identificador);
    if (!definicion) return this.texto(`[^${etiqueta}]`, f);
    let numero = this.numeroNota.get(identificador);
    if (numero === undefined) {
      numero = this.numeroNota.size + 1;
      // Se apunta antes de convertirla, por si la nota se cita a sí misma.
      this.numeroNota.set(identificador, numero);
      const parrafos = this.bloques(definicion.children, FUERA).filter((b): b is Docx.Paragraph => b instanceof this.d.Paragraph);
      this.piesDePagina[String(numero)] = { children: parrafos.length ? parrafos : [new this.d.Paragraph({})] };
    }
    return new this.d.FootnoteReferenceRun(numero);
  }

  /* Estilos y numeración */

  private estilos(): Docx.IStylesOptions {
    const { d } = this;
    const titulo = (size: number, extra: { italics?: boolean } = {}) => ({
      run: { font: "Calibri", size, bold: true, color: "1A1A1A", ...extra },
      paragraph: { spacing: { before: 280, after: 120 }, keepNext: true, keepLines: true },
    });
    return {
      default: {
        document: { run: { font: "Calibri", size: 22, language: { value: "es-ES" } }, paragraph: { spacing: { after: 160, line: 276 } } },
        heading1: titulo(36),
        heading2: titulo(30),
        heading3: titulo(26),
        heading4: titulo(24),
        heading5: titulo(22),
        heading6: titulo(22, { italics: true }),
        hyperlink: { run: { color: "0563C1", underline: { type: d.UnderlineType.SINGLE } } },
        listParagraph: { paragraph: { spacing: { after: 60 } } },
      },
      // Nombres de estilos de Word (Quote, HTML Preformatted, HTML Code): Word los reconoce y los traduce.
      paragraphStyles: [
        {
          id: "Quote",
          name: "Quote",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { italics: true, color: "595959" },
          paragraph: { indent: { left: 567 }, border: { left: { style: d.BorderStyle.SINGLE, size: 12, color: BORDE_GRIS, space: 8 } } },
        },
        {
          id: "HTMLPreformatted",
          name: "HTML Preformatted",
          basedOn: "Normal",
          run: { font: "Consolas", size: 19 },
          paragraph: { spacing: { after: 160, line: 240 }, shading: { type: d.ShadingType.CLEAR, color: "auto", fill: "F3F3F3" } },
        },
      ],
      characterStyles: [
        {
          id: "HTMLCode",
          name: "HTML Code",
          basedOn: "DefaultParagraphFont",
          run: { font: "Consolas", size: 20, shading: { type: d.ShadingType.CLEAR, color: "auto", fill: "F3F3F3" } },
        },
      ],
    };
  }

  private numeraciones(): Docx.INumberingOptions["config"] {
    const { d } = this;
    const formatos = [d.LevelFormat.DECIMAL, d.LevelFormat.LOWER_LETTER, d.LevelFormat.LOWER_ROMAN];
    const niveles = (vineta: boolean, inicio = 1) =>
      Array.from({ length: 9 }, (_, n) => ({
        level: n,
        format: vineta ? d.LevelFormat.BULLET : formatos[n % 3]!,
        text: vineta ? VINETAS[n % 3]! : `%${n + 1}.`,
        start: inicio,
        alignment: d.AlignmentType.LEFT,
        style: { paragraph: { indent: { left: sangria(n), hanging: 360 } } },
      }));
    return [
      { reference: "vinetas", levels: niveles(true) },
      { reference: "numerada", levels: niveles(false) },
      ...[...this.inicios].map((s) => ({ reference: `numerada-${s}`, levels: niveles(false, s) })),
    ];
  }
}

const TITULOS = ["Heading1", "Heading2", "Heading3", "Heading4", "Heading5", "Heading6"] as const;
