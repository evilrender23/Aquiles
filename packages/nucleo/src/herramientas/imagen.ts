import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { z } from "zod";
import { ErrorImagen, extensionDe, generarImagen, SERVICIOS_IMAGEN, serviciosDisponibles, type OpcionesImagen } from "../imagenes";
import { rutaAbsoluta, rutaVisible } from "./ficheros";
import { definir, ErrorHerramienta } from "./herramienta";

/** La ruta con la extensión del tipo que llegó y, si ya existe, con -2, -3… para no pisar nada. */
export function rutaLibre(abs: string, ext: string): string {
  const sin = extname(abs) ? abs.slice(0, -extname(abs).length) : abs;
  let ruta = `${sin}.${ext}`;
  for (let i = 2; existsSync(ruta); i++) ruta = `${sin}-${i}.${ext}`;
  return ruta;
}

/** `opciones` es para los tests (servicios falsos). */
export function herramientaGenerarImagen(opciones: Omit<OpcionesImagen, "servicio" | "modelo" | "senal"> = {}) {
  return definir({
    nombre: "generar_imagen",
    descripcion:
      "Genera una imagen a partir de una descripción con un modelo de imagen: Gemini, OpenAI u OpenRouter con clave, o sin clave " +
      "con agy (Antigravity, Nano Banana) o Codex, el primero disponible. " +
      "y la guarda en 'ruta'. Describe con detalle qué debe verse: sujeto, estilo, composición, colores y el texto exacto si lleva. " +
      "El usuario la ve en el panel. No sirve para editar una imagen que ya existe.",
    nivel: "escritura",
    parametros: z.object({
      descripcion: z.string().min(3).describe("Qué debe verse en la imagen, con detalle"),
      ruta: z.string().min(1).describe("Dónde guardarla, p. ej. imagenes/portada.png (la extensión se ajusta al formato que llegue)"),
      servicio: z.enum(SERVICIOS_IMAGEN).optional().describe("gemini, openai, openrouter, agy o codex; sin él, el primero disponible"),
      modelo: z.string().optional().describe("Otro modelo de imagen del servicio, si el usuario lo pide"),
    }),
    resumen: ({ ruta }) => ruta,
    rutas: ({ ruta }, cwd) => [rutaAbsoluta(ruta, cwd)],
    async ejecutar({ descripcion, ruta, servicio, modelo }, ctx) {
      if (!servicio && serviciosDisponibles(opciones.entorno, opciones.clis).length === 0) {
        throw new ErrorHerramienta(
          "No hay ningún servicio de imágenes. Dile al usuario que inicie sesión en agy (Antigravity) o Codex, o que ponga una clave " +
            "de Gemini (Google AI Studio), OpenAI u OpenRouter en Ajustes → Modelos → Claves de API.",
        );
      }
      ctx.progreso("Generando la imagen…\n");
      let imagen: Awaited<ReturnType<typeof generarImagen>>;
      try {
        imagen = await generarImagen(descripcion, { ...opciones, servicio, modelo, senal: ctx.senal });
      } catch (e) {
        if (e instanceof ErrorImagen) throw new ErrorHerramienta(e.message);
        throw e;
      }
      const abs = rutaLibre(rutaAbsoluta(ruta, ctx.cwd), extensionDe(imagen.mime));
      const visible = rutaVisible(abs, ctx.cwd);
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, imagen.bytes);
      } catch (e) {
        throw new ErrorHerramienta(`No se pudo guardar ${visible}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const kb = Math.round(imagen.bytes.length / 1024);
      return `Imagen guardada en ${visible} (${kb} KB, ${imagen.servicio} ${imagen.modelo}).${imagen.texto ? `\nEl modelo añadió: ${imagen.texto.slice(0, 500)}` : ""}`;
    },
  });
}
