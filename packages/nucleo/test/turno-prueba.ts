import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Evento } from "@aquiles/protocolo";
import { ejecutarTurno, type OpcionesTurno, type PeticionAprobacion } from "../src/bucle";
import type { Herramienta } from "../src/herramientas/herramienta";
import { leer } from "../src/herramientas/leer";
import type { Mensaje, Proveedor } from "../src/tipos";

/** Herramienta de ejecución falsa: devuelve lo que se le pide y cuenta sus usos. */
export function herramientaEco(): Herramienta<{ texto: string; repetir?: number }> & { usos: number } {
  const h: Herramienta<{ texto: string; repetir?: number }> & { usos: number } = {
    usos: 0,
    nombre: "eco",
    descripcion: "Devuelve el texto",
    nivel: "ejecucion",
    parametros: z.object({ texto: z.string(), repetir: z.number().int().optional() }),
    resumen: (a) => `eco ${a.texto}`,
    clavePermiso: (a) => a.texto.split(" ")[0] ?? "",
    async ejecutar(a) {
      h.usos += 1;
      return a.texto.repeat(a.repetir ?? 1);
    },
  };
  return h;
}

export async function turno(
  proveedor: Proveedor,
  extra: Partial<OpcionesTurno> & { decision?: "permitir" | "siempre" | "denegar" } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "aquiles-bucle-"));
  await writeFile(join(cwd, "nota.txt"), "El código es 4471.");
  const eventos: Evento[] = [];
  const aprobaciones: PeticionAprobacion[] = [];
  const mensajes: Mensaje[] = extra.mensajes ?? [{ rol: "usuario", texto: "¿Qué pone en nota.txt?" }];
  const anadidos: Mensaje[] = [];
  const entorno = extra.entorno ?? {
    lecturas: new Map(), estado: new Map(), permitidos: new Set<string>(), modoAprobacion: "preguntar-ejecutar" as const, steer: [],
  };
  const r = await ejecutarTurno({
    sesionId: "s1",
    cwd,
    sistema: "sistema de prueba",
    mensajes,
    proveedor,
    herramientas: [leer],
    emitir: (e) => eventos.push(e),
    senal: new AbortController().signal,
    entorno,
    aprobar: async (p) => {
      aprobaciones.push(p);
      return extra.decision ?? "permitir";
    },
    preguntar: async () => "sí",
    alAnadir: (m) => anadidos.push(m),
    esperaBaseMs: 1,
    ...extra,
  });
  return { r, eventos, mensajes, aprobaciones, anadidos, entorno, cwd };
}
