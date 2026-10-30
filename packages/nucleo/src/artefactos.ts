/**
 * Artefactos en el núcleo: las instrucciones para el modelo, la vista aislada de HTML y SVG y el guardado en la carpeta de
 * trabajo. El formato y el análisis del bloque están en `@aquiles/protocolo` (artefactos.ts), compartidos con la app.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const INSTRUCCIONES_ARTEFACTOS = `# Artefactos
Cuando el usuario pida algo autónomo para ver o reutilizar (una página o un juego en HTML, un SVG, un documento largo, un fichero de código suelto), escríbelo como artefacto dentro de tu respuesta, y la app lo enseñará aparte mientras lo escribes:
<artefacto id="identificador-corto" tipo="html|svg|markdown|codigo" titulo="Título breve" lenguaje="python">
…contenido completo, sin vallas de código…
</artefacto>
- \`lenguaje\` solo con tipo="codigo". HTML: un único fichero con su CSS y su JS dentro; puede cargar librerías de cdnjs.cloudflare.com o cdn.jsdelivr.net por https.
- Para cambiar un artefacto, vuelve a escribirlo entero con el mismo id: es una versión nueva.
- No uses artefactos para respuestas cortas, fragmentos de explicación ni cambios en ficheros del proyecto: eso va en el texto o con tus herramientas de ficheros.`;

const CSP_VISTA = [
  "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "media-src https: data: blob:",
  // Solo https: un artefacto no puede hablar con los servicios de este equipo (núcleo, Ollama, llama.cpp…).
  "connect-src https:",
  "frame-src https: data: blob:",
  "worker-src blob: data:",
].join("; ");

const MAX_VISTAS = 50;
const DURACION_MS = 60 * 60_000;

/** Vistas publicadas de artefactos HTML y SVG, en memoria, servidas en `/vista/<clave>` con CSP `sandbox`. */
export class VistasArtefactos {
  private vistas = new Map<string, { html: string; hasta: number }>();

  publicar(tipo: "html" | "svg", contenido: string): string {
    const ahora = Date.now();
    for (const [clave, v] of this.vistas) if (v.hasta < ahora) this.vistas.delete(clave);
    while (this.vistas.size >= MAX_VISTAS) this.vistas.delete(this.vistas.keys().next().value as string);
    const clave = randomBytes(18).toString("base64url");
    const html =
      tipo === "svg"
        ? `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh}</style></head><body>${contenido}</body></html>`
        : contenido;
    this.vistas.set(clave, { html, hasta: ahora + DURACION_MS });
    return `/vista/${clave}`;
  }

  /** Respuesta para una petición HTTP a `/vista/…`, o undefined si la ruta no es de vistas. */
  responder(ruta: string): Response | undefined {
    if (!ruta.startsWith("/vista/")) return undefined;
    const v = this.vistas.get(ruta.slice("/vista/".length));
    if (!v || v.hasta < Date.now()) return new Response("No encontrado", { status: 404 });
    return new Response(v.html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP_VISTA,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      },
    });
  }
}

export class FicheroYaExiste extends Error {
  constructor(readonly ruta: string) {
    super(`Ya existe ${ruta}`);
  }
}

/** Guarda un artefacto en la carpeta de trabajo. El nombre es solo un nombre de fichero, sin carpetas. */
export async function guardarArtefacto(cwd: string, nombre: string, contenido: string, sobrescribir = false): Promise<string> {
  const limpio = nombre.trim();
  const conControl = [...limpio].some((c) => c.charCodeAt(0) < 32);
  if (!limpio || conControl || basename(limpio) !== limpio || /[<>:"/\\|?*]/.test(limpio) || /^\.+$/.test(limpio))
    throw new Error(`Nombre de fichero no válido: ${nombre}`);
  const ruta = join(cwd, limpio);
  if (!sobrescribir && existsSync(ruta)) throw new FicheroYaExiste(ruta);
  await writeFile(ruta, contenido, "utf8");
  return ruta;
}
