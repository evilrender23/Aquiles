import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ErrorHerramienta, type ContextoHerramienta, type Huella } from "./herramienta";

export const WINDOWS = process.platform === "win32";

/** Ruta absoluta desde cwd; en Windows acepta también el estilo de Git Bash (/c/Users/...). */
export function rutaAbsoluta(ruta: string, cwd: string): string {
  const msys = WINDOWS ? /^\/([a-zA-Z])(?=\/|$)/.exec(ruta) : null;
  const r = msys ? `${msys[1]!.toUpperCase()}:\\${ruta.slice(3)}` : ruta;
  return resolve(cwd, r);
}

/** Clave de `ctx.lecturas`: ruta absoluta normalizada (en Windows, sin distinguir mayúsculas). */
export function claveRuta(abs: string): string {
  const n = resolve(abs);
  return WINDOWS ? n.toLowerCase() : n;
}

/** Ruta para mostrar al modelo: relativa a cwd y con barras normales si está dentro; si no, absoluta. */
export function rutaVisible(abs: string, cwd: string): string {
  const rel = relative(cwd, abs);
  if (!rel) return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return abs;
  return rel.split(sep).join("/");
}

export function hashDe(bytes: Uint8Array): string {
  return Bun.hash(bytes).toString(16);
}

export async function huellaDe(ruta: string, bytes?: Uint8Array): Promise<Huella> {
  const info = await stat(ruta);
  const contenido = bytes ?? (await Bun.file(ruta).bytes());
  return { mtimeMs: info.mtimeMs, tamano: info.size, hash: hashDe(contenido) };
}

/** Guarda la huella actual del fichero tras leerlo o escribirlo (con `bytes`, sin volver a leerlo). */
export async function registrarHuella(ctx: ContextoHerramienta, abs: string, bytes?: Uint8Array): Promise<Huella> {
  const huella = await huellaDe(abs, bytes);
  ctx.lecturas.set(claveRuta(abs), huella);
  return huella;
}

/** Exige que el fichero se haya leído en la sesión y no haya cambiado desde entonces; devuelve sus bytes. */
export async function exigirLeido(ctx: ContextoHerramienta, abs: string, visible: string, accion: string): Promise<Uint8Array> {
  const previa = ctx.lecturas.get(claveRuta(abs));
  if (!previa) throw new ErrorHerramienta(`No has leído ${visible} en esta sesión; léelo antes de ${accion}.`);
  const bytes = await Bun.file(abs).bytes();
  if (hashDe(bytes) !== previa.hash) {
    throw new ErrorHerramienta(
      `${visible} ha cambiado desde que lo leíste (lo ha modificado otro proceso o el usuario); vuelve a leerlo antes de ${accion}.`,
    );
  }
  return bytes;
}

export function esBinario(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

export interface Texto {
  texto: string;
  bom: boolean;
  crlf: boolean;
}

export function decodificar(bytes: Uint8Array): Texto {
  let texto = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const bom = texto.startsWith("﻿");
  if (bom) texto = texto.slice(1);
  return { texto, bom, crlf: texto.includes("\r\n") };
}

export function codificar(texto: string, bom: boolean): Uint8Array {
  return new TextEncoder().encode(bom ? `﻿${texto}` : texto);
}

export function contarLineas(texto: string): number {
  if (!texto) return 0;
  const n = texto.split("\n").length;
  return texto.endsWith("\n") ? n - 1 : n;
}

export function lineas(n: number): string {
  return `${n} ${n === 1 ? "línea" : "líneas"}`;
}
