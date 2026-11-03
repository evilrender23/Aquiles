/**
 * Mantener la conversación dentro de la ventana de contexto, en escalones:
 *   1. podar: sustituir resultados de herramientas antiguos por un aviso (sin llamar al modelo);
 *   2. resumir: pedir al modelo un resumen de la parte antigua y quedarse con lo reciente.
 * No aplica a proveedores que guardan su propia conversación (agy).
 */
import type { Mensaje, Proveedor } from "./tipos";
import { ErrorAbortado } from "./tipos";

const VENTANA_POR_DEFECTO = 128_000;
const UMBRAL = 0.6;
/** Resultados de herramienta recientes que nunca se podan. */
const CONSERVAR_RESULTADOS = 6;
/** Mensajes recientes que se conservan tal cual al resumir. */
const CONSERVAR_MENSAJES = 12;

/**
 * Con secciones fijas, no en prosa libre: así un resumen que se vuelve a resumir (compactar varias veces) pierde
 * menos, y lo que importa para seguir (ficheros, pendientes) no se diluye.
 */
const INSTRUCCIONES_RESUMEN = [
  "Resume la conversación anterior para que otro asistente pueda continuar el trabajo sin ella.",
  "Usa exactamente estas secciones, en este orden, con viñetas cortas y concretas (rutas, nombres, valores):",
  "## Objetivo y preferencias — qué pidió el usuario y cómo lo quiere.",
  "## Ficheros — cada fichero leído o cambiado: ruta — en qué estado queda.",
  "## Decisiones — lo decidido y por qué.",
  "## Hecho — comandos y resultados importantes.",
  "## Errores resueltos — qué falló y cómo se arregló, para no repetirlo.",
  "## Pendiente — lo que falta por hacer, en orden.",
  "Si en la conversación ya hay un resumen anterior, intégralo en estas secciones sin perder nada de él.",
  "Deja vacía (con «—») la sección que no tenga nada. No inventes nada. Escribe solo el resumen.",
].join("\n");

/** Lo que cuesta una imagen, más o menos, en caracteres equivalentes (~1.600 tokens). */
const CARACTERES_IMAGEN = 5600;

/** Estimación barata: ~3,5 caracteres por token. */
export function estimarTokens(sistema: string, mensajes: readonly Mensaje[]): number {
  let c = sistema.length;
  for (const m of mensajes) {
    c += m.rol === "herramienta" ? m.resultado.length + m.nombre.length : m.texto.length;
    if (m.rol === "asistente") c += JSON.stringify(m.llamadas).length;
    if (m.rol === "usuario") for (const a of m.adjuntos ?? []) c += a.clase === "imagen" ? CARACTERES_IMAGEN : (a.texto?.length ?? 0) + 300;
  }
  return Math.ceil(c / 3.5);
}

/** Qué fue esa llamada, en pocas palabras, para que el aviso de la poda diga qué volver a pedir. */
function queFue(nombre: string, args: unknown): string | undefined {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const corto = (v: unknown) => (typeof v === "string" ? (v.length > 120 ? `${v.slice(0, 120)}…` : v) : undefined);
  const clave = { leer: "ruta", escribir: "ruta", editar: "ruta", terminal: "comando", buscar_texto: "patron", buscar_ficheros: "patron", leer_web: "url", buscar_web: "consulta" }[nombre];
  return clave ? corto(a[clave]) : undefined;
}

/**
 * Sustituye los resultados grandes y antiguos (no los 6 últimos) por un aviso que dice qué eran y cómo recuperarlos:
 * «[leer src/a.ts: 400 líneas, podado; vuelve a pedirlo si lo necesitas]». De la terminal se guarda la última línea
 * (el código de salida).
 */
export function podar(mensajes: readonly Mensaje[]): Mensaje[] {
  const indices = mensajes.flatMap((m, i) => (m.rol === "herramienta" ? [i] : []));
  const podables = new Set(indices.slice(0, Math.max(0, indices.length - CONSERVAR_RESULTADOS)));
  const argumentos = new Map<string, unknown>();
  for (const m of mensajes) if (m.rol === "asistente") for (const l of m.llamadas) argumentos.set(l.id, l.argumentos);
  return mensajes.map((m, i) => {
    if (!podables.has(i) || m.rol !== "herramienta" || m.resultado.length < 600) return m;
    const lineas = m.resultado.split("\n");
    const que = queFue(m.nombre, argumentos.get(m.id));
    const ultima = m.nombre === "terminal" ? lineas.filter((l) => l.trim()).at(-1) : undefined;
    return {
      ...m,
      resultado:
        `[${m.nombre}${que ? ` ${que}` : ""}: ${lineas.length} líneas, podado para ahorrar contexto; vuelve a pedirlo si lo necesitas]` +
        (ultima ? `\n${ultima.slice(0, 200)}` : ""),
    };
  });
}

/** Índice desde el que se conserva: nunca empieza en un resultado de herramienta (quedaría sin su llamada). */
export function puntoDeCorte(mensajes: readonly Mensaje[], conservar = CONSERVAR_MENSAJES): number {
  let i = Math.max(0, mensajes.length - conservar);
  while (i > 0 && mensajes[i]?.rol === "herramienta") i--;
  return i;
}

export async function resumir(
  proveedor: Proveedor,
  sistema: string,
  mensajes: readonly Mensaje[],
  senal: AbortSignal,
  sesionId: string,
): Promise<Mensaje[]> {
  const corte = puntoDeCorte(mensajes);
  if (corte === 0) return [...mensajes];
  const antiguos = podar(mensajes.slice(0, corte));
  const r = await proveedor.responder(
    {
      sesionId: `${sesionId}:resumen`,
      sistema,
      mensajes: [...antiguos, { rol: "usuario", texto: INSTRUCCIONES_RESUMEN }],
      herramientas: [],
      cwd: "",
      senal,
      maxTokensSalida: 4000,
    },
    () => {},
  );
  if (senal.aborted) throw new ErrorAbortado();
  return [{ rol: "resumen", texto: r.texto.trim() }, ...mensajes.slice(corte)];
}

export interface Compactacion {
  mensajes: Mensaje[];
  metodo: "poda" | "resumen";
  antes: number;
  despues: number;
  /** El resumen nuevo, si se resumió: la app lo enseña. */
  resumen?: string;
}

export async function compactarSiHaceFalta(o: {
  proveedor: Proveedor;
  sistema: string;
  mensajes: readonly Mensaje[];
  senal: AbortSignal;
  sesionId: string;
  /** Tokens de entrada que dio la última llamada real, si se conocen. */
  tokensReales?: number;
  forzar?: boolean;
}): Promise<Compactacion | undefined> {
  if (o.proveedor.conversacionPropia) return undefined;
  const limite = (o.proveedor.ventanaContexto ?? VENTANA_POR_DEFECTO) * UMBRAL;
  const antes = Math.max(estimarTokens(o.sistema, o.mensajes), o.tokensReales ?? 0);
  if (!o.forzar && antes < limite) return undefined;

  const podados = podar(o.mensajes);
  const trasPoda = estimarTokens(o.sistema, podados);
  if (!o.forzar && trasPoda < limite * 0.8) return { mensajes: podados, metodo: "poda", antes, despues: trasPoda };

  const resumidos = await resumir(o.proveedor, o.sistema, podados, o.senal, o.sesionId);
  const resumen = resumidos[0]?.rol === "resumen" ? resumidos[0].texto : undefined;
  return { mensajes: resumidos, metodo: "resumen", antes, despues: estimarTokens(o.sistema, resumidos), ...(resumen ? { resumen } : {}) };
}
