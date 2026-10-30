/** Versiones semánticas (https://semver.org/lang/es/). */

const NUM = String.raw`0|[1-9]\d*`;
const PRE_ID = String.raw`(?:${NUM}|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const META_ID = "[0-9A-Za-z-]+";
const SEMVER = new RegExp(
  String.raw`^v?(${NUM})\.(${NUM})\.(${NUM})(?:-(${PRE_ID}(?:\.${PRE_ID})*))?(?:\+(${META_ID}(?:\.${META_ID})*))?$`,
);

interface Version {
  numeros: [number, number, number];
  pre: string[];
}

function analizar(v: string): Version | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  return { numeros: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function analizarOLanzar(v: string): Version {
  const r = analizar(v);
  if (!r) throw new Error(`Versión no válida: ${v}`);
  return r;
}

export function esVersionValida(version: string): boolean {
  return typeof version === "string" && analizar(version) !== null;
}

const signo = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

function compararIdentificador(a: string, b: string): -1 | 0 | 1 {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return signo(Number(a) - Number(b));
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparar(a: Version, b: Version): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    const d = signo(a.numeros[i]! - b.numeros[i]!);
    if (d) return d;
  }
  if (!a.pre.length || !b.pre.length) return signo(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const d = compararIdentificador(a.pre[i]!, b.pre[i]!);
    if (d) return d;
  }
  return signo(a.pre.length - b.pre.length);
}

export function compararVersiones(a: string, b: string): -1 | 0 | 1 {
  return comparar(analizarOLanzar(a), analizarOLanzar(b));
}

export function ordenarVersiones(versiones: readonly string[]): string[] {
  const analizadas = versiones.map((v) => ({ v, a: analizarOLanzar(v) }));
  return analizadas.sort((x, y) => comparar(x.a, y.a)).map((x) => x.v);
}
