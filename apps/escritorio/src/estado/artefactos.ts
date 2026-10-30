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
