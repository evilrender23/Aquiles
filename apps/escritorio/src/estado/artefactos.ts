/** Artefactos de una sesión: los bloques `<artefacto>` de las respuestas, con sus versiones (mismo id, en orden). */
import { type Artefacto, type TipoArtefacto, separarArtefactos } from "@aquiles/protocolo";
import type { Elemento } from "./tipos";

export type TrozoHilo = { tipo: "texto"; texto: string } | { tipo: "artefacto"; artefacto: Artefacto; version: number; clave: string };

export interface ArtefactoVisto {
  artefacto: Artefacto;
  /** 0 = la primera. */
  version: number;
  /** Este bloque en concreto: id del mensaje y su posición en él. */
  clave: string;
}

export interface ArtefactosSesion {
  /** Versiones de cada artefacto, en el orden en que aparecen en la sesión. */
  porId: Map<string, Artefacto[]>;
  /** Trozos de los mensajes que tienen artefactos (los demás se pintan enteros). */
  porElemento: Map<string, TrozoHilo[]>;
  porClave: Map<string, ArtefactoVisto>;
  /** El que se está escribiendo ahora: sin cerrar, en un mensaje que sigue llegando. */
  vivo?: ArtefactoVisto;
}

type Asistente = Extract<Elemento, { tipo: "asistente" }>;

/** Un mensaje que no ha cambiado (mismo objeto) no se vuelve a partir. */
const partidos = new WeakMap<Asistente, ReturnType<typeof separarArtefactos>>();
function partir(e: Asistente) {
  let t = partidos.get(e);
  if (!t) {
    t = separarArtefactos(e.texto, { enCurso: e.abierto });
    partidos.set(e, t);
  }
  return t;
}

export function recogerArtefactos(elementos: Elemento[]): ArtefactosSesion {
  const r: ArtefactosSesion = { porId: new Map(), porElemento: new Map(), porClave: new Map() };
  for (const e of elementos) {
    if (e.tipo !== "asistente" || !e.texto.includes("<artefacto")) continue;
    const trozos = partir(e);
    if (!trozos.some((t) => t.tipo === "artefacto")) continue;
    let n = 0;
    const hilo = trozos.map((t): TrozoHilo => {
      if (t.tipo === "texto") return t;
      const versiones = r.porId.get(t.artefacto.id) ?? [];
      versiones.push(t.artefacto);
      r.porId.set(t.artefacto.id, versiones);
      const visto = { artefacto: t.artefacto, version: versiones.length - 1, clave: `${e.id}:${n++}` };
      r.porClave.set(visto.clave, visto);
      if (e.abierto && !t.artefacto.completo) r.vivo = visto;
      return { tipo: "artefacto", ...visto };
    });
    r.porElemento.set(e.id, hilo);
  }
  return r;
}

/** Los que tienen pestaña Vista. */
export const renderizable = (tipo: TipoArtefacto) => tipo !== "codigo";

export function contarLineas(texto: string): number {
  if (!texto) return 0;
  let n = 1;
  for (let i = texto.indexOf("\n"); i >= 0; i = texto.indexOf("\n", i + 1)) n++;
  return n;
}

const POR_TIPO: Record<Exclude<TipoArtefacto, "codigo">, string> = { html: "html", svg: "svg", markdown: "md" };

/** Nombres de lenguaje → extensión. Lo que ya parece una extensión (py, rs, gd…) se usa tal cual. */
const POR_LENGUAJE: Record<string, string> = {
  python: "py",
  javascript: "js",
  typescript: "ts",
  rust: "rs",
  golang: "go",
  csharp: "cs",
  "c#": "cs",
  "c++": "cpp",
  ruby: "rb",
  kotlin: "kt",
  shell: "sh",
  bash: "sh",
  zsh: "sh",
  powershell: "ps1",
  yaml: "yml",
  markdown: "md",
  text: "txt",
  plaintext: "txt",
  gdscript: "gd",
  haskell: "hs",
  elixir: "ex",
  perl: "pl",
  objectivec: "m",
  dockerfile: "dockerfile",
};

export function extension(a: Pick<Artefacto, "tipo" | "lenguaje">): string {
  if (a.tipo !== "codigo") return POR_TIPO[a.tipo];
  const l = a.lenguaje?.toLowerCase();
  if (!l) return "txt";
  return POR_LENGUAJE[l] ?? (/^[a-z0-9]{1,6}$/.test(l) ? l : "txt");
}

export const nombreFichero = (a: Pick<Artefacto, "id" | "tipo" | "lenguaje">) => `${a.id}.${extension(a)}`;

/* ── Documentos (visor de .md y .docx) ────────────── */

/** Lo que se abre en el visor: markdown (Vista y Código) o Word (Vista). */
export type ClaseDocumento = "markdown" | "word";

export function claseDocumento(ruta: string): ClaseDocumento | undefined {
  const ext = /\.([^.\\/]+)$/.exec(ruta)?.[1]?.toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "docx") return "word";
  return undefined;
}

/**
 * Ruta absoluta: las relativas cuelgan de la carpeta de la sesión. Con una carpeta de Windows, `/c/…` (estilo Git Bash)
 * pasa a `C:\…`, como hace el núcleo.
 */
export function rutaAbsoluta(cwd: string, ruta: string): string {
  const msys = /^[A-Za-z]:/.test(cwd) ? /^\/([a-zA-Z])(?=\/|$)/.exec(ruta) : null;
  if (msys) return `${msys[1]!.toUpperCase()}:\\${ruta.slice(3).replace(/\//g, "\\")}`;
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(ruta)) return ruta;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${ruta.replace(/^\.[\\/]/, "")}`;
}

/** Último tramo de una ruta, con barras de Windows o normales. */
export const nombreDeRuta = (ruta: string) => ruta.split(/[\\/]/).filter(Boolean).at(-1) ?? ruta;

/** Nombre del .docx de «Guardar como Word»: el id del artefacto, o el nombre del .md sin su extensión. */
export const nombreWord = (base: string) => `${base.replace(/\.(md|markdown)$/i, "")}.docx`;

const escaparHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Hoja de papel para el HTML de un .docx (el de mammoth), con los estilos que pone el núcleo al escribirlo. */
const ESTILO_HOJA = `
:root{color-scheme:light}
html{background:#e9ece7}
body{margin:0;padding:24px 16px 48px;font:15px/1.6 Calibri,Carlito,"Segoe UI",system-ui,sans-serif;color:#1a1a1a;overflow-wrap:anywhere}
.hoja{box-sizing:border-box;max-width:760px;min-height:calc(100vh - 72px);margin:0 auto;padding:56px 64px;background:#fff;border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,.1),0 8px 28px rgba(0,0,0,.08)}
@media (max-width:600px){body{padding:12px 8px 32px}.hoja{padding:28px 22px}}
.hoja>:first-child{margin-top:0}
h1,h2,h3,h4,h5,h6{margin:1.2em 0 .45em;line-height:1.25}
h1{font-size:1.75em}h2{font-size:1.45em}h3{font-size:1.2em}h4,h5,h6{font-size:1.05em}h6{font-style:italic}
p{margin:0 0 .7em}
a{color:#0563c1}
ul,ol{margin:0 0 .7em;padding-left:1.7em}
li>p{margin:0}
blockquote{margin:0 0 .7em;padding-left:14px;border-left:3px solid #bfbfbf;color:#595959;font-style:italic}
pre{margin:0 0 .7em;padding:10px 12px;background:#f3f3f3;font:13px/1.45 Consolas,ui-monospace,monospace;white-space:pre-wrap}
code{padding:0 3px;background:#f3f3f3;font-family:Consolas,ui-monospace,monospace;font-size:.92em}
pre code{padding:0;background:none}
table{width:100%;margin:0 0 1em;border-collapse:collapse}
th,td{padding:4px 8px;border:1px solid #bfbfbf;text-align:left;vertical-align:top}
th{background:#f2f2f2}
td>p,th>p{margin:0}
img{max-width:100%;height:auto}
sup>a{text-decoration:none}
`;

/** Página completa para la vista aislada; los enlaces a fuera se abren aparte y los de las notas, en la misma hoja. */
export function paginaDocumento(cuerpo: string, titulo: string): string {
  const enlaces = cuerpo.replace(/<a href="(?=(?:https?|mailto):)/gi, '<a target="_blank" rel="noreferrer noopener" href="');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escaparHtml(titulo)}</title><style>${ESTILO_HOJA}</style></head><body><main class="hoja">${enlaces}</main></body></html>`;
}
