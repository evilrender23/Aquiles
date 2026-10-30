/**
 * Protocolo de herramientas en texto, para modelos a los que no se les pueden
 * pasar herramientas nativas (p. ej. a través de un CLI como agy).
 *
 * Llamada:   <herramienta nombre="leer">{"ruta":"a.txt"}</herramienta>
 * Resultado: <resultado herramienta="leer" id="h1">…</resultado>
 */
import type { EspecHerramienta, LlamadaHerramienta, Mensaje } from "../tipos";

const ETIQUETA = "<herramienta";
const BLOQUE = /<herramienta\s+nombre="([^"]+)"\s*>([\s\S]*?)<\/herramienta>/g;

export function instrucciones(herramientas: readonly EspecHerramienta[]): string {
  const lista = herramientas
    .map((h) => `- ${h.nombre}: ${h.descripcion}\n  Argumentos (JSON Schema): ${JSON.stringify(h.esquema)}`)
    .join("\n");
  return [
    "No uses ninguna de tus herramientas propias: no están disponibles en este entorno.",
    "Las únicas herramientas son estas, y las ejecuta Aquiles:",
    lista,
    "",
    "Para usar una, escribe un bloque así (los argumentos en JSON) y termina tu mensaje ahí:",
    '<herramienta nombre="NOMBRE">{"arg":"valor"}</herramienta>',
    "Puedes poner varios bloques seguidos. Aquiles responderá con bloques <resultado> en el siguiente mensaje.",
    "Si no necesitas ninguna herramienta, responde normalmente.",
  ].join("\n");
}

export function extraerLlamadas(texto: string, prefijoId: string): { texto: string; llamadas: LlamadaHerramienta[] } {
  const llamadas: LlamadaHerramienta[] = [];
  let n = 0;
  for (const m of texto.matchAll(BLOQUE)) {
    n += 1;
    const bruto = (m[2] ?? "").trim();
    let argumentos: unknown;
    try {
      argumentos = bruto ? JSON.parse(bruto) : {};
    } catch {
      argumentos = { __json_invalido: bruto };
    }
    llamadas.push({ id: `${prefijoId}-${n}`, nombre: m[1] ?? "", argumentos });
  }
  const limpio = texto.replace(BLOQUE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { texto: limpio, llamadas };
}

/** Texto visible de una respuesta en curso: oculta los bloques de herramienta, incluso a medio llegar. */
export function textoVisible(acumulado: string): string {
  const inicio = acumulado.indexOf(ETIQUETA);
  if (inicio >= 0) return acumulado.slice(0, inicio);
  // Retener un posible comienzo de etiqueta al final ("<her…").
  for (let k = Math.min(ETIQUETA.length - 1, acumulado.length); k > 0; k--) {
    if (ETIQUETA.startsWith(acumulado.slice(-k))) return acumulado.slice(0, -k);
  }
  return acumulado;
}

export function renderizarMensaje(m: Mensaje): string {
  switch (m.rol) {
    case "usuario":
      return m.texto;
    case "herramienta":
      return `<resultado herramienta="${m.nombre}" id="${m.id}"${m.error ? ' error="si"' : ""}>\n${m.resultado}\n</resultado>`;
    case "asistente":
      return m.texto;
    case "resumen":
      return `[Resumen de la conversación anterior]\n${m.texto}`;
  }
}
