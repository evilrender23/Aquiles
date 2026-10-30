/**
 * Adjuntos de un mensaje antes de enviarlo. La app de escritorio manda la ruta (el núcleo lee el fichero);
 * el navegador y el portapapeles, el contenido en base64. El núcleo valida lo demás.
 */
import { MAX_ADJUNTOS, MAX_BYTES_ADJUNTO, type Params } from "@aquiles/protocolo";
import type { AdjuntoVisto } from "./tipos";

export interface AdjuntoPendiente {
  clave: string;
  nombre: string;
  tipo?: string;
  /** Se sabe para los ficheros leídos aquí; no para las rutas de la app de escritorio. */
  bytes?: number;
  ruta?: string;
  datos?: string;
  /** Data URL de la imagen, para la miniatura. */
  miniatura?: string;
}

type AdjuntoProtocolo = NonNullable<Params<"prompt.enviar">["adjuntos"]>[number];

export const paraEnviar = (a: AdjuntoPendiente): AdjuntoProtocolo => ({
  nombre: a.nombre,
  ...(a.tipo ? { tipo: a.tipo } : {}),
  ...(a.ruta ? { ruta: a.ruta } : { datos: a.datos ?? "" }),
});

/** Cómo se ve en el hilo justo al enviarlo (luego el historial trae el id). */
export const visto = (a: AdjuntoPendiente): AdjuntoVisto => ({
  nombre: a.nombre,
  ...(a.tipo ? { tipo: a.tipo } : {}),
  ...(a.bytes !== undefined ? { bytes: a.bytes } : {}),
  ...(a.ruta ? { ruta: a.ruta } : {}),
  ...(a.miniatura ? { miniatura: a.miniatura, clase: "imagen" as const } : {}),
});

let siguiente = 0;
const nuevaClave = () => `adj${++siguiente}`;

export const nombreDeRuta = (ruta: string) => ruta.split(/[\\/]/).pop() || ruta;

const IMAGEN = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
export const esImagen = (a: { nombre: string; tipo?: string; clase?: string }) => a.clase === "imagen" || !!a.tipo?.startsWith("image/") || IMAGEN.test(a.nombre);

/** 312 B, 820 kB, 4,2 MB. */
export function tamanoLegible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

const MB_MAXIMO = Math.round(MAX_BYTES_ADJUNTO / (1024 * 1024));

export function desdeRutas(rutas: string[]): AdjuntoPendiente[] {
  return rutas.map((ruta) => ({ clave: nuevaClave(), nombre: nombreDeRuta(ruta), ruta }));
}

function comoDataUrl(f: Blob): Promise<string> {
  return new Promise((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => mal(r.error ?? new Error("No se pudo leer el fichero"));
    r.readAsDataURL(f);
  });
}

/** Lee ficheros del navegador (o pegados) en base64; los que pasan del límite no se leen y dan error. */
export async function desdeFicheros(ficheros: File[]): Promise<{ adjuntos: AdjuntoPendiente[]; error?: string }> {
  const adjuntos: AdjuntoPendiente[] = [];
  const grandes: string[] = [];
  for (const f of ficheros) {
    if (f.size > MAX_BYTES_ADJUNTO) {
      grandes.push(f.name);
      continue;
    }
    const url = await comoDataUrl(f);
    adjuntos.push({
      clave: nuevaClave(),
      nombre: f.name,
      ...(f.type ? { tipo: f.type } : {}),
      bytes: f.size,
      datos: url.slice(url.indexOf(",") + 1),
      ...(f.type.startsWith("image/") ? { miniatura: url } : {}),
    });
  }
  const error = grandes.length ? `${grandes.map((n) => `«${n}»`).join(", ")} ${grandes.length === 1 ? "pasa" : "pasan"} de ${MB_MAXIMO} MB` : undefined;
  return { adjuntos, ...(error ? { error } : {}) };
}

/** Añade sin pasar del máximo por mensaje; lo que no cabe se queda fuera con su error. */
export function admitir(actuales: AdjuntoPendiente[], nuevos: AdjuntoPendiente[]): { lista: AdjuntoPendiente[]; error?: string } {
  const sitio = Math.max(0, MAX_ADJUNTOS - actuales.length);
  const lista = [...actuales, ...nuevos.slice(0, sitio)];
  return nuevos.length > sitio ? { lista, error: `Máximo ${MAX_ADJUNTOS} adjuntos por mensaje` } : { lista };
}

/** Imagen pegada: «pegado-14-05-32.png». */
export function renombrarPegado(f: File): File {
  const d = new Date();
  const dos = (n: number) => String(n).padStart(2, "0");
  const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return new File([f], `pegado-${dos(d.getHours())}-${dos(d.getMinutes())}-${dos(d.getSeconds())}.${ext}`, { type: f.type });
}
