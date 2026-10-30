/**
 * Menciones de ficheros con `@` en un mensaje. La app busca aquí los ficheros de la carpeta de trabajo para su
 * desplegable, y al enviar, cada `@ruta` que es un fichero se convierte en un adjunto: el modelo recibe su contenido
 * (texto extraído, imagen…) igual que si se hubiera adjuntado con el clip.
 */
import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { MAX_ADJUNTOS, MAX_BYTES_ADJUNTO } from "@aquiles/protocolo";
import type { AdjuntoEntrante } from "./adjuntos";
import { recorrer, reglasPara } from "./herramientas/recorrer";

/** Más allá, una carpeta enorme (el perfil del usuario, un disco) no deja de responder: se busca en lo recorrido. */
const MAX_RECORRIDO = 20_000;
const VIGENCIA_MS = 15_000;

const listados = new Map<string, { hasta: number; rutas: Promise<string[]> }>();

/** Ficheros de `cwd` (rutas relativas con `/`), sin las carpetas excluidas ni lo del .gitignore; en caché 15 s. */
function listado(cwd: string): Promise<string[]> {
  const clave = cwd.toLowerCase();
  const previo = listados.get(clave);
  if (previo && previo.hasta > Date.now()) return previo.rutas;
  const rutas = (async () => {
    const lista: string[] = [];
    for await (const e of recorrer(cwd, await reglasPara(cwd, cwd))) {
      lista.push(e.rel);
      if (lista.length >= MAX_RECORRIDO) break;
    }
    return lista;
  })();
  listados.set(clave, { hasta: Date.now() + VIGENCIA_MS, rutas });
  return rutas;
}

/**
 * Ficheros cuyo nombre o ruta contienen la consulta: primero los que empiezan por ella, luego los que la llevan en el
 * nombre y luego en la ruta; a igualdad, los menos profundos y los más cortos.
 */
export async function buscarFicheros(cwd: string, consulta: string, limite = 30): Promise<string[]> {
  const q = consulta.trim().toLowerCase().replace(/\\/g, "/");
  const puntuados: { rel: string; puntos: number; nivel: number }[] = [];
  for (const rel of await listado(cwd)) {
    const r = rel.toLowerCase();
    const nombre = r.slice(r.lastIndexOf("/") + 1);
    const puntos = !q ? 0 : nombre.startsWith(q) ? 0 : nombre.includes(q) ? 1 : r.includes(q) ? 2 : -1;
    if (puntos >= 0) puntuados.push({ rel, puntos, nivel: rel.split("/").length });
  }
  return puntuados
    .sort((a, b) => a.puntos - b.puntos || a.nivel - b.nivel || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel))
    .slice(0, limite)
    .map((p) => p.rel);
}

/** `@ruta` o `@"ruta con espacios"`, al principio o tras un espacio (así no cuenta un correo como a@b.com). */
const MENCION = /(?:^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g;

/** Rutas absolutas de los ficheros que existen entre las menciones del texto, sin repetir. */
export async function ficherosMencionados(texto: string, cwd: string): Promise<string[]> {
  const rutas: string[] = [];
  for (const m of texto.matchAll(MENCION)) {
    // Sin comillas, la puntuación del final es de la frase: «mira @a.ts, por favor».
    const escrita = m[1] ?? (m[2] ?? "").replace(/[.,;:!?)\]}]+$/, "");
    if (!escrita) continue;
    const abs = isAbsolute(escrita) ? escrita : resolve(cwd, escrita);
    if (rutas.some((r) => r.toLowerCase() === abs.toLowerCase())) continue;
    const info = await stat(abs).catch(() => undefined);
    if (info?.isFile()) rutas.push(abs);
  }
  return rutas;
}

/**
 * Los adjuntos del mensaje más los ficheros mencionados que no estén ya, hasta el máximo por mensaje. Los que pasan
 * del tamaño máximo se quedan como texto: el modelo puede leerlos con sus herramientas.
 */
export async function conMenciones(texto: string, cwd: string, adjuntos: readonly AdjuntoEntrante[]): Promise<AdjuntoEntrante[]> {
  const lista = [...adjuntos];
  for (const ruta of await ficherosMencionados(texto, cwd)) {
    if (lista.length >= MAX_ADJUNTOS) break;
    if (lista.some((a) => a.ruta?.toLowerCase() === ruta.toLowerCase())) continue;
    if ((await stat(ruta)).size > MAX_BYTES_ADJUNTO) continue;
    lista.push({ nombre: basename(ruta), ruta });
  }
  return lista;
}
