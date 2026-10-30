/**
 * Docker en este equipo: dónde está y cómo instalarlo si falta.
 * `instalar_docker` pide consentimiento con una pregunta explícita aunque el modo de permisos lo deje todo libre:
 * instala software del sistema con permisos de administrador. Sin nadie que conteste (tareas programadas), no instala.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { definir, ErrorHerramienta } from "./herramienta";

/** Donde lo deja Docker Desktop; el PATH de un proceso que ya estaba abierto no lo tiene hasta reiniciarlo. */
export const RUTA_DOCKER_WINDOWS = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const DOCKER_DESKTOP = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
const ACEPTAR = "Instalar Docker Desktop";

export function rutaDocker(): string | undefined {
  const enPath = Bun.which("docker");
  if (enPath) return enPath;
  if (process.platform !== "win32" || !existsSync(RUTA_DOCKER_WINDOWS)) return undefined;
  // docker.exe llama a sus ayudantes (docker-credential-desktop…) por el PATH: sin su carpeta, hasta un pull público falla.
  const carpeta = dirname(RUTA_DOCKER_WINDOWS);
  if (!(process.env.PATH ?? "").split(";").includes(carpeta)) process.env.PATH = `${carpeta};${process.env.PATH ?? ""}`;
  return RUTA_DOCKER_WINDOWS;
}

type Ejecutar = (orden: string[], senal: AbortSignal, alSalida?: (t: string) => void) => Promise<{ codigo: number; salida: string }>;

const ejecutarPorDefecto: Ejecutar = async (orden, senal, alSalida) => {
  const p = Bun.spawn(orden, { stdout: "pipe", stderr: "pipe", signal: senal });
  let salida = "";
  const leer = async (flujo: ReadableStream<Uint8Array>) => {
    const d = new TextDecoder();
    for await (const trozo of flujo) {
      const t = d.decode(trozo, { stream: true });
      salida += t;
      alSalida?.(t);
    }
  };
  await Promise.all([leer(p.stdout), leer(p.stderr)]);
  return { codigo: await p.exited, salida };
};

/** El motor responde (Docker instalado y Docker Desktop arrancado). */
async function motorListo(docker: string, senal: AbortSignal, ejecutar: Ejecutar): Promise<boolean> {
  const r = await ejecutar([docker, "info", "--format", "{{.ServerVersion}}"], AbortSignal.any([senal, AbortSignal.timeout(20_000)])).catch(() => undefined);
  return r?.codigo === 0;
}

export function herramientaInstalarDocker(o: { ejecutar?: Ejecutar; esperaMotorMs?: number; ruta?: () => string | undefined } = {}) {
  const ejecutar = o.ejecutar ?? ejecutarPorDefecto;
  const ruta = o.ruta ?? rutaDocker;
  return definir({
    nombre: "instalar_docker",
    descripcion:
      "Comprueba si Docker está disponible y, si falta, ofrece instalar Docker Desktop (winget) preguntando antes al usuario. " +
      "Úsala cuando una tarea necesite contenedores (por ejemplo, la terminal en modo Docker dice que Docker no está instalado). " +
      "Si está instalado pero parado, arranca Docker Desktop y espera a que responda.",
    nivel: "ejecucion",
    parametros: z.object({ motivo: z.string().min(1).describe("Para qué hace falta Docker, en una frase para el usuario") }),
    resumen: ({ motivo }) => `Docker: ${motivo}`,
    async ejecutar({ motivo }, ctx) {
      let docker = ruta();
      if (docker && (await motorListo(docker, ctx.senal, ejecutar))) return "Docker ya está instalado y el motor responde.";

      if (!docker) {
        if (process.platform !== "win32") throw new ErrorHerramienta("Instalar Docker solo está automatizado en Windows; pide al usuario que lo instale.");
        const respuesta = await ctx.preguntar({
          texto:
            `Docker no está instalado. ${motivo}\n¿Instalo Docker Desktop con winget? Pedirá permisos de administrador, ` +
            "la primera vez hay que aceptar sus términos y puede pedir reiniciar.",
          opciones: [ACEPTAR, "No instalar"],
        });
        if (respuesta.trim() !== ACEPTAR) return "El usuario no ha querido instalar Docker. No lo vuelvas a proponer en esta tarea.";
        ctx.progreso("Instalando Docker Desktop con winget…\n");
        const r = await ejecutar(
          ["winget", "install", "-e", "--id", "Docker.DockerDesktop", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
          ctx.senal,
          (t) => ctx.progreso(t),
        );
        if (r.codigo !== 0) throw new ErrorHerramienta(`winget no pudo instalar Docker Desktop (código ${r.codigo}):\n${r.salida.slice(-1500)}`);
        docker = ruta();
        if (!docker) return "Docker Desktop se ha instalado, pero aún no se encuentra docker.exe. Puede que haga falta reiniciar Windows.";
      }

      // Instalado pero parado: se arranca Docker Desktop y se espera al motor.
      if (process.platform === "win32" && existsSync(DOCKER_DESKTOP)) {
        ctx.progreso("Arrancando Docker Desktop…\n");
        await ejecutar(["powershell", "-NoProfile", "-Command", `Start-Process '${DOCKER_DESKTOP}'`], ctx.senal).catch(() => undefined);
      }
      const limite = Date.now() + (o.esperaMotorMs ?? 180_000);
      while (Date.now() < limite) {
        if (await motorListo(docker, ctx.senal, ejecutar)) return "Docker está instalado y el motor responde.";
        if (ctx.senal.aborted) throw new ErrorHerramienta("Parado.");
        await Bun.sleep(5000);
      }
      return (
        "Docker Desktop está instalado pero su motor aún no responde. Si es la primera vez, el usuario tiene que abrir Docker Desktop " +
        "y aceptar sus términos; puede que pida reiniciar Windows. Díselo y prueba de nuevo después."
      );
    },
  });
}
