/**
 * Estadísticas de uso de un perfil, calculadas al vuelo con los JSONL de las sesiones (ver sesiones.ts) y el
 * historial de lo aprendido. Los días van en hora local, del más antiguo al más reciente, con los vacíos incluidos.
 *
 * - sesiones: creadas ese día (línea `inicio`); el proveedor es el de su creación.
 * - mensajes: del usuario y de Aquiles, sin los resultados de herramientas.
 * - herramientas: llamadas que pidió Aquiles.
 * - tokens: de las líneas `uso` del final de cada turno.
 * Los mensajes antiguos sin `fecha` cuentan en la última fecha vista en su fichero (la de creación, si no hay otra).
 * Las skills salen del registro, que solo guarda usos totales: no es un recuento del periodo.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EntradaAprendizaje, Estadisticas } from "@aquiles/protocolo";

const DIAS_POR_DEFECTO = 30;
const MAX_HERRAMIENTAS = 20;
const MAX_SKILLS = 10;

type Dia = Estadisticas["porDia"][number];

export function calcularEstadisticas(o: {
  dirSesiones: string | null;
  historial: EntradaAprendizaje[];
  registroSkills?: Record<string, { usos?: number }>;
  dias?: number;
  ahora?: Date;
}): Estadisticas {
  const dias = o.dias ?? DIAS_POR_DEFECTO;
  const ahora = o.ahora ?? new Date();
  const porDia = new Map<string, Dia>();
  const inicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - (dias - 1));
  for (let i = 0; i < dias; i++) {
    const d = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + i);
    const dia = diaLocal(d);
    porDia.set(dia, { dia, sesiones: 0, mensajes: 0, herramientas: 0, tokensEntrada: 0, tokensSalida: 0, aprendido: 0 });
  }
  const herramientas = new Map<string, number>();
  const proveedores = new Map<string, number>();
  const sumar = (m: Map<string, number>, clave: string, n = 1) => m.set(clave, (m.get(clave) ?? 0) + n);

  for (const ruta of ficherosSesion(o.dirSesiones, inicio.getTime())) {
    let texto: string;
    try {
      texto = readFileSync(ruta, "utf8");
    } catch {
      continue;
    }
    let fecha: string | undefined;
    for (const bruto of texto.split("\n")) {
      const l = leerLinea(bruto);
      if (!l) continue;
      if (typeof l.fecha === "string") fecha = l.fecha;
      if (l.tipo === "inicio" && typeof l.creada === "string") {
        fecha = l.creada;
        const d = porDia.get(diaDe(l.creada) ?? "");
        if (!d) continue;
        d.sesiones += 1;
        sumar(proveedores, typeof l.proveedor === "string" && l.proveedor ? l.proveedor : "desconocido");
      } else if (l.tipo === "mensaje") {
        const d = porDia.get(diaDe(fecha) ?? "");
        const m = l.mensaje as { rol?: unknown; llamadas?: unknown } | undefined;
        if (!d || !m || (m.rol !== "usuario" && m.rol !== "asistente")) continue;
        d.mensajes += 1;
        if (m.rol !== "asistente" || !Array.isArray(m.llamadas)) continue;
        for (const llamada of m.llamadas as { nombre?: unknown }[]) {
          if (typeof llamada?.nombre !== "string") continue;
          d.herramientas += 1;
          sumar(herramientas, llamada.nombre);
        }
      } else if (l.tipo === "uso") {
        const d = porDia.get(diaDe(fecha) ?? "");
        const uso = l.uso as { entrada?: unknown; salida?: unknown } | undefined;
        if (!d || !uso) continue;
        d.tokensEntrada += numero(uso.entrada);
        d.tokensSalida += numero(uso.salida);
      }
    }
  }

  const aprendido = o.historial
    .filter((e) => porDia.has(diaDe(e.fecha) ?? ""))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
  for (const e of aprendido) porDia.get(diaDe(e.fecha)!)!.aprendido += 1;

  return {
    dias,
    porDia: [...porDia.values()],
    herramientas: ordenar(herramientas, MAX_HERRAMIENTAS).map(([nombre, usos]) => ({ nombre, usos })),
    skills: ordenar(
      new Map(Object.entries(o.registroSkills ?? {}).map(([nombre, r]) => [nombre, numero(r?.usos)])),
      MAX_SKILLS,
    ).map(([nombre, usos]) => ({ nombre, usos })),
    proveedores: ordenar(proveedores).map(([proveedor, sesiones]) => ({ proveedor, sesiones })),
    aprendido,
  };
}

/** JSONL de sesiones que pueden tener algo del periodo: los que se escribieron por última vez antes no lo tienen. */
function ficherosSesion(dir: string | null, desdeMs: number): string[] {
  if (!dir) return [];
  let nombres: string[];
  try {
    nombres = readdirSync(dir);
  } catch {
    return [];
  }
  return nombres
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .filter((ruta) => {
      try {
        return statSync(ruta).mtimeMs >= desdeMs;
      } catch {
        return false;
      }
    });
}

function leerLinea(bruto: string): Record<string, unknown> | undefined {
  if (!bruto.trim()) return undefined;
  try {
    const l = JSON.parse(bruto);
    return typeof l === "object" && l !== null && !Array.isArray(l) ? l : undefined;
  } catch {
    return undefined;
  }
}

/** Día local (AAAA-MM-DD) de una fecha ISO; undefined si no es una fecha. */
function diaDe(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : diaLocal(d);
}

function diaLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function numero(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

/** De más a menos usos (a igualdad, por nombre), sin los que no tienen ninguno. */
function ordenar(m: Map<string, number>, limite = Number.POSITIVE_INFINITY): [string, number][] {
  return [...m]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limite);
}
