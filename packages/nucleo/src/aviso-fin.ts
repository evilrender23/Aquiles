/**
 * Aviso al acabar una tarea larga: una frase corta, escrita por el modelo de la sesión, que dice qué se ha hecho
 * («He acabado de traducir el informe»). Va en la notificación y, si se quiere, se lee en voz alta.
 */
import type { Mensaje, Proveedor } from "./tipos";

/** Solo las tareas que duran al menos esto: con una respuesta rápida, el usuario ya está mirando. */
export const AVISO_DESDE_MS = 30_000;

const PROMPT =
  "Acabas de terminar una tarea para el usuario. Escribe una sola frase en español, en primera persona, que empiece por " +
  "«He acabado» y diga en concreto qué has hecho, en menos de 15 palabras. Sin comillas, sin emojis y sin nada más.";

/** «He acabado: …» con lo que pidió el usuario, para cuando el modelo no contesta o contesta otra cosa. */
function fraseDeRespaldo(pedido: string): string {
  const corto = pedido.replace(/\s+/g, " ").trim();
  if (!corto) return "He acabado la tarea.";
  return `He acabado: ${corto.length > 80 ? `${corto.slice(0, 80).replace(/\s+\S*$/, "")}…` : corto}`;
}

/** Limpia lo que devuelve el modelo; undefined si no es una frase de fin. */
export function limpiarFrase(texto: string): string | undefined {
  const linea = texto
    .trim()
    .split(/\r?\n/)[0]!
    .replace(/^[«"'“”*\s]+|[»"'“”*\s]+$/g, "")
    .trim();
  if (!/^He (acabado|terminado)\b/i.test(linea) || linea.length > 200) return undefined;
  return /[.!…]$/.test(linea) ? linea : `${linea}.`;
}

export async function fraseDeFin(o: { proveedor: Proveedor; mensajes: readonly Mensaje[]; cwd: string; senal?: AbortSignal }): Promise<string> {
  const pedido = [...o.mensajes].reverse().find((m) => m.rol === "usuario");
  const final = [...o.mensajes].reverse().find((m) => m.rol === "asistente");
  const textoPedido = pedido?.rol === "usuario" ? pedido.texto : "";
  const sesionId = `aviso-${crypto.randomUUID()}`;
  try {
    const r = await o.proveedor.responder(
      {
        sesionId,
        sistema: PROMPT,
        mensajes: [
          {
            rol: "usuario",
            texto:
              `Lo que pidió el usuario:\n${textoPedido.slice(0, 2000) || "(nada)"}\n\n` +
              `Tu respuesta final:\n${final?.rol === "asistente" ? final.texto.slice(-2000) : "(nada)"}`,
          },
        ],
        herramientas: [],
        cwd: o.cwd,
        senal: AbortSignal.any([o.senal ?? new AbortController().signal, AbortSignal.timeout(30_000)]),
        maxTokensSalida: 80,
      },
      () => {},
    );
    return limpiarFrase(r.texto) ?? fraseDeRespaldo(textoPedido);
  } catch {
    return fraseDeRespaldo(textoPedido);
  } finally {
    await o.proveedor.cerrar?.(sesionId);
  }
}
