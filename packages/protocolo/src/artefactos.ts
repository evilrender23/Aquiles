/**
 * Artefactos: contenido autónomo (una página, un SVG, un documento, un fichero de código) que el modelo escribe dentro de su
 * respuesta como un bloque `<artefacto id="…" tipo="…" titulo="…">…</artefacto>`. La app lo enseña aparte, mientras llega,
 * y lo renderiza al cerrarse. Viaja en el texto del mensaje, así que funciona igual con todos los proveedores y el historial
 * lo reconstruye sin guardar nada más. Un bloque con el mismo `id` en un mensaje posterior es una versión nueva.
 */

export const TIPOS_ARTEFACTO = ["html", "svg", "markdown", "codigo"] as const;
export type TipoArtefacto = (typeof TIPOS_ARTEFACTO)[number];

export interface Artefacto {
  id: string;
  tipo: TipoArtefacto;
  titulo: string;
  /** Lenguaje del código (`tipo: "codigo"`), si el modelo lo dice. */
  lenguaje?: string;
  contenido: string;
  /** false mientras el modelo aún lo está escribiendo (no ha llegado `</artefacto>`). */
  completo: boolean;
}

export type TrozoMensaje = { tipo: "texto"; texto: string } | { tipo: "artefacto"; artefacto: Artefacto };

const APERTURA = /^[ \t]*<artefacto\b([^>\n]*)>[ \t]*\r?\n?/m;
const CIERRE = "</artefacto>";
const ATRIBUTO = /([a-zA-Z_]+)\s*=\s*"([^"]*)"/g;

/**
 * Parte el texto de un mensaje en trozos de texto y artefactos. Con `enCurso` (el mensaje aún está llegando) el último
 * artefacto puede estar abierto y se oculta una etiqueta de apertura a medio escribir, para que no asome en el chat.
 */
export function separarArtefactos(texto: string, opciones: { enCurso?: boolean } = {}): TrozoMensaje[] {
  const trozos: TrozoMensaje[] = [];
  let resto = texto;
  let n = 0;
  for (;;) {
    const apertura = APERTURA.exec(resto);
    if (!apertura) break;
    const antes = resto.slice(0, apertura.index);
    if (antes.trim()) trozos.push({ tipo: "texto", texto: antes });
    const atributos = leerAtributos(apertura[1] ?? "");
    const cuerpo = resto.slice(apertura.index + apertura[0].length);
    const fin = cuerpo.indexOf(CIERRE);
    const completo = fin >= 0;
    n++;
    trozos.push({
      tipo: "artefacto",
      artefacto: {
        id: limpiarId(atributos.id) || limpiarId(atributos.titulo) || `artefacto-${n}`,
        tipo: (TIPOS_ARTEFACTO as readonly string[]).includes(atributos.tipo ?? "") ? (atributos.tipo as TipoArtefacto) : "codigo",
        titulo: atributos.titulo?.trim() || atributos.id?.trim() || "Artefacto",
        ...(atributos.lenguaje?.trim() ? { lenguaje: atributos.lenguaje.trim().toLowerCase() } : {}),
        contenido: quitarValla(completo ? cuerpo.slice(0, fin) : cuerpo, completo),
        completo,
      },
    });
    if (!completo) return trozos;
    resto = cuerpo.slice(fin + CIERRE.length);
  }
  const final = opciones.enCurso ? sinAperturaAMedias(resto) : resto;
  if (final.trim()) trozos.push({ tipo: "texto", texto: final });
  return trozos;
}

/** El texto con cada artefacto cambiado por una referencia, para los sitios que no pueden enseñarlos (canales de chat). */
export function textoSinArtefactos(texto: string): string {
  return separarArtefactos(texto)
    .map((t) => (t.tipo === "texto" ? t.texto.trim() : `[Artefacto: ${t.artefacto.titulo}]`))
    .filter(Boolean)
    .join("\n\n");
}

function leerAtributos(texto: string): Record<string, string> {
  const atributos: Record<string, string> = {};
  for (const m of texto.matchAll(ATRIBUTO)) atributos[(m[1] ?? "").toLowerCase()] = m[2] ?? "";
  return atributos;
}

function limpiarId(texto: string | undefined): string {
  return (texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Muchos modelos envuelven el contenido en una valla de código aunque no haga falta: se quita. */
function quitarValla(contenido: string, completo: boolean): string {
  let c = contenido.replace(/^\r?\n/, "");
  const abre = /^[ \t]*```[\w+#.-]*[ \t]*\r?\n/.exec(c);
  if (abre) {
    const sinApertura = c.slice(abre[0].length);
    const cierra = /\r?\n?[ \t]*```[ \t]*\s*$/.exec(sinApertura);
    if (cierra) c = sinApertura.slice(0, cierra.index);
    else if (!completo) c = sinApertura;
  }
  return completo ? c.replace(/\r?\n[ \t]*$/, "") : c;
}

function sinAperturaAMedias(texto: string): string {
  const linea = texto.lastIndexOf("\n");
  const ultima = texto.slice(linea + 1).trimStart();
  if (ultima.length >= 2 && !ultima.includes(">") && (`<artefacto`.startsWith(ultima) || ultima.startsWith("<artefacto")))
    return texto.slice(0, linea + 1);
  return texto;
}
