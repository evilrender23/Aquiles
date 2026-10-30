import { z } from "zod";
import { cancelado } from "./entornos";
import { definir, ErrorHerramienta } from "./herramienta";
import { type EstadoTerminal, elegirShell, estadoTerminal, type ResultadoComando } from "./shell";

const TIEMPO_DEFECTO = 120;
const TIEMPO_MAX = 600;

const shell = elegirShell();

export const terminal = definir({
  nombre: "terminal",
  descripcion:
    `Ejecuta un comando en un shell persistente de la sesión (${shell.nombre}, salvo que los ajustes lo lleven a Docker o SSH; ` +
    "entonces lo dice el primer resultado): cd, variables y funciones se mantienen entre llamadas. " +
    "Devuelve stdout y stderr juntos y termina con '[código de salida N]'. " +
    `Límite: timeout_s (${TIEMPO_DEFECTO} s por defecto, máximo ${TIEMPO_MAX}); al superarlo se mata el proceso y el shell se reinicia. ` +
    "No es interactivo (stdin vacío): usa opciones no interactivas (-y, --no-pager…). " +
    "Para servidores o procesos largos usa segundo_plano: true y consulta su salida con procesos. " +
    "Para ver o buscar ficheros prefiere leer, buscar_texto y buscar_ficheros.",
  nivel: "ejecucion",
  parametros: z.object({
    comando: z.string().min(1).describe(`Comando de ${shell.nombre}; puede tener varias líneas`),
    timeout_s: z.number().int().min(1).max(TIEMPO_MAX).optional().describe(`Segundos antes de matarlo (${TIEMPO_DEFECTO} por defecto)`),
    segundo_plano: z
      .boolean()
      .optional()
      .describe("Lo lanza aparte (en la carpeta actual del shell, sin sus variables) y devuelve enseguida un id para procesos"),
    nombre: z.string().min(1).max(40).optional().describe("Nombre corto para el proceso en segundo plano"),
  }),
  resumen: ({ comando, segundo_plano }) => (segundo_plano ? `${comando.trim()} (en segundo plano)` : comando.trim()),
  // "Permitir siempre" vale para el programa (`git …`), salvo si el comando encadena o redirige:
  // entonces solo para ese comando exacto, para que `git status && rm -rf x` no herede el permiso de git.
  clavePermiso: ({ comando }) => (/[;&|<>`\n]|\$\(/.test(comando) ? `exacto:${comando.trim()}` : primerToken(comando)),
  async ejecutar({ comando, timeout_s = TIEMPO_DEFECTO, segundo_plano = false, nombre }, ctx) {
    const estado = estadoTerminal(ctx.estado);
    if (segundo_plano) {
      if (nombre && estado.buscar(nombre)?.enMarcha) {
        throw new ErrorHerramienta(`Ya hay un proceso en marcha llamado "${nombre}"; páralo con procesos o usa otro nombre.`);
      }
      const remoto = estado.entorno(ctx);
      // En remoto, sin shell abierto, arranca donde lo haría el shell (el -w del contenedor o el home remoto).
      const cwd = estado.shell?.vivo ? estado.shell.cwd : remoto ? undefined : ctx.cwd;
      const p = await arrancar(() => estado.lanzar(comando, nombre, cwd, ctx));
      // En remoto el pid local es el del cliente (docker o ssh), que no le sirve de nada al modelo.
      const donde = remoto
        ? `en ${cwd ?? remoto.carpeta ?? "la carpeta del usuario"} de ${remoto.nombre}`
        : `pid ${p.proc.pid}, en ${cwd}`;
      return conAviso(
        `Lanzado en segundo plano con id ${p.id}${nombre ? ` (${nombre})` : ""}, ${donde}. ` +
          `Mira su salida con procesos (accion "salida", id "${p.id}") y páralo con accion "parar".`,
        estado,
      );
    }
    if (ctx.senal.aborted) throw cancelado();
    return estado.enCola(async () => {
      const r = await (await arrancar(() => estado.shellVivo(ctx))).ejecutar(comando, {
        timeoutMs: timeout_s * 1000,
        senal: ctx.senal,
        progreso: (t) => ctx.progreso(t),
      });
      return conAviso(conPie(r, timeout_s), estado);
    });
  },
});

/** Los errores de Docker y SSH ya vienen explicados; los demás son de no poder lanzar el shell local. */
async function arrancar<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ErrorHerramienta) throw e;
    throw new ErrorHerramienta(`No se pudo iniciar ${shell.nombre} (${shell.ejecutable}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

function conPie(r: ResultadoComando, timeout: number): string {
  const salida = r.salida.replace(/\n+$/, "");
  const reinicio = "se reiniciará en la siguiente llamada (se pierden cd y variables)";
  const pie =
    r.motivo === "tiempo"
      ? `[detenido: superó el límite de ${timeout} s; se mató el proceso y el shell ${reinicio}. Para procesos largos usa segundo_plano]`
      : r.motivo === "cancelado"
        ? `[cancelado por el usuario; se mató el proceso y el shell ${reinicio}]`
        : r.motivo === "terminado"
          ? `[el shell terminó${r.codigo !== undefined ? ` con código ${r.codigo}` : ""}; ${reinicio}]`
          : `[código de salida ${r.codigo}]`;
  return salida ? `${salida}\n${pie}` : pie;
}

/** El primer resultado de una sesión en Docker o SSH acaba con una línea que dice dónde corre. */
function conAviso(texto: string, estado: EstadoTerminal): string {
  const aviso = estado.aviso();
  return aviso ? `${texto}\n${aviso}` : texto;
}

/** Primer token del comando (sin comillas), para "permitir siempre". */
export function primerToken(comando: string): string {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(comando);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? "";
}
