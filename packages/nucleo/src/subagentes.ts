/**
 * Subagentes: la herramienta `delegar` lanza una sesión hija con su propio bucle para una tarea acotada y
 * devuelve su respuesta final. Las hijas son sesiones normales (con origen «subagente») que se pueden seguir,
 * reconducir (steer) y parar desde la app; no pueden delegar a su vez.
 */
import { z } from "zod";
import { definir, ErrorHerramienta, type Herramienta } from "./herramientas/herramienta";

/** Hijas a la vez por sesión padre. */
export const MAX_SUBAGENTES = 3;
const MAX_RESPUESTA = 12_000;

export interface PeticionSubagente {
  padre: string;
  cwd: string;
  nombre: string;
  tarea: string;
  soloLectura: boolean;
  senal: AbortSignal;
}

/** Lo pone el servidor: crea la sesión hija, ejecuta su turno y devuelve el texto final o lanza el error. */
export type LanzarSubagente = (p: PeticionSubagente) => Promise<{ subId: string; texto: string }>;

export function herramientaDelegar(lanzar: LanzarSubagente): Herramienta<any> {
  const enCurso = new Map<string, number>();
  const esperando = new Map<string, (() => void)[]>();

  /** Semáforo por padre: si ya hay MAX_SUBAGENTES, espera turno. */
  const entrar = async (padre: string, senal: AbortSignal) => {
    while ((enCurso.get(padre) ?? 0) >= MAX_SUBAGENTES) {
      await new Promise<void>((ok) => {
        const cola = esperando.get(padre) ?? [];
        cola.push(ok);
        esperando.set(padre, cola);
        senal.addEventListener("abort", () => ok(), { once: true });
      });
      if (senal.aborted) throw new ErrorHerramienta("Turno parado antes de lanzar el subagente.");
    }
    enCurso.set(padre, (enCurso.get(padre) ?? 0) + 1);
  };
  const salir = (padre: string) => {
    enCurso.set(padre, (enCurso.get(padre) ?? 1) - 1);
    esperando.get(padre)?.shift()?.();
  };

  return definir({
    nombre: "delegar",
    descripcion:
      "Encarga una tarea acotada a un subagente: otra instancia de Aquiles con su propia conversación y las mismas herramientas " +
      "(salvo delegar), que trabaja en la misma carpeta y te devuelve su respuesta final. Úsalo para trabajos independientes que " +
      "se pueden hacer en paralelo (varios delegar en el mismo mensaje corren a la vez, hasta 3) o para investigar algo sin llenar " +
      "tu contexto. El subagente no ve esta conversación: en 'tarea' escribe todo lo que necesita saber (objetivo, ficheros, " +
      "restricciones y qué debe devolverte). Con solo_lectura no puede escribir ni ejecutar.",
    // Delegar en sí no toca nada: cada acción del subagente pide su propio permiso. Por eso puede ir en paralelo.
    nivel: "lectura",
    parametros: z.object({
      nombre: z.string().min(1).max(40).describe("Nombre corto para seguirlo en la app, p. ej. «tests-api»"),
      tarea: z.string().min(1).describe("Instrucciones completas para el subagente"),
      solo_lectura: z.boolean().optional().describe("Solo puede leer y buscar"),
    }),
    resumen: ({ nombre, tarea }) => `${nombre}: ${tarea.replace(/\s+/g, " ").slice(0, 80)}`,
    async ejecutar({ nombre, tarea, solo_lectura }, ctx) {
      await entrar(ctx.sesionId, ctx.senal);
      try {
        const r = await lanzar({ padre: ctx.sesionId, cwd: ctx.cwd, nombre, tarea, soloLectura: solo_lectura === true, senal: ctx.senal });
        const texto = r.texto.trim() || "(el subagente terminó sin respuesta)";
        return texto.length > MAX_RESPUESTA ? `${texto.slice(0, MAX_RESPUESTA)}\n[… respuesta recortada; la completa está en la sesión ${r.subId}]` : texto;
      } finally {
        salir(ctx.sesionId);
      }
    },
  });
}
