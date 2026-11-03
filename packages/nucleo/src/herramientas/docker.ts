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
/** En Mac, el docker que trae Docker.app (por si no está enlazado en /usr/local/bin). */
const RUTA_DOCKER_MAC = "/Applications/Docker.app/Contents/Resources/bin/docker";
const ACEPTAR = "Instalar Docker Desktop";

export function rutaDocker(): string | undefined {
  const enPath = Bun.which("docker");
  if (enPath) return enPath;
  if (process.platform === "darwin" && existsSync(RUTA_DOCKER_MAC)) return RUTA_DOCKER_MAC;
  if (process.platform !== "win32" || !existsSync(RUTA_DOCKER_WINDOWS)) return undefined;
  // docker.exe llama a sus ayudantes (docker-credential-desktop…) por el PATH: sin su carpeta, hasta un pull público falla.
  const carpeta = dirname(RUTA_DOCKER_WINDOWS);
  if (!(process.env.PATH ?? "").split(";").includes(carpeta)) process.env.PATH = `${carpeta};${process.env.PATH ?? ""}`;
  return RUTA_DOCKER_WINDOWS;
}

/** Cómo se instala y se arranca Docker Desktop en cada sistema. */
interface PlanDocker {
  /** «con winget», «con Homebrew»; sin él, no se instala solo. */
  con?: string;
  instalar?: string[];
  arrancar?: string[];
  /** Lo que se le dice al usuario si no se puede instalar solo. */
  aMano: string;
  /** Tras instalar, si el motor no responde. */
  despues: string;
}

export function planDocker(plataforma: string, hayBrew: boolean): PlanDocker {
  if (plataforma === "win32") {
    return {
      con: "con winget",
      instalar: ["winget", "install", "-e", "--id", "Docker.DockerDesktop", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
      arrancar: existsSync(DOCKER_DESKTOP) ? ["powershell", "-NoProfile", "-Command", `Start-Process '${DOCKER_DESKTOP}'`] : undefined,
      aMano: "Pide al usuario que instale Docker Desktop.",
      despues: "puede que pida reiniciar Windows",
    };
  }
  if (plataforma === "darwin") {
    return {
      ...(hayBrew ? { con: "con Homebrew", instalar: ["brew", "install", "--cask", "docker"] } : {}),
      arrancar: ["open", "-a", "Docker"],
      aMano: "Sin Homebrew no se instala solo: pide al usuario que descargue Docker Desktop de https://www.docker.com/products/docker-desktop/ (o que instale Homebrew).",
      despues: "macOS puede pedir la contraseña para instalar sus componentes",
    };
  }
  return { aMano: "Aquí no se instala solo: pide al usuario que instale Docker con el gestor de paquetes de su sistema.", despues: "" };
}

function descripcion(plan: PlanDocker): string {
  const instalar = plan.con
    ? `si falta, ofrece instalar Docker Desktop ${plan.con} preguntando antes al usuario`
    : "si falta, explica al usuario cómo instalarlo (aquí no se instala solo)";
  return (
    `Comprueba si Docker está disponible y, ${instalar}. ` +
    "Úsala cuando una tarea necesite contenedores (por ejemplo, la terminal en modo Docker dice que Docker no está instalado). " +
    "Si está instalado pero parado, arranca Docker Desktop y espera a que responda."
  );
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

export function herramientaInstalarDocker(
  o: { ejecutar?: Ejecutar; esperaMotorMs?: number; ruta?: () => string | undefined; plataforma?: string; hayBrew?: boolean } = {},
) {
  const ejecutar = o.ejecutar ?? ejecutarPorDefecto;
  const ruta = o.ruta ?? rutaDocker;
  const plataforma = o.plataforma ?? process.platform;
  // La descripción ya dice cómo se instala en este sistema (winget, Homebrew o a mano).
  const plan = () => planDocker(plataforma, o.hayBrew ?? Bun.which("brew") !== null);
  return definir({
    nombre: "instalar_docker",
    descripcion: descripcion(plan()),
    nivel: "ejecucion",
    parametros: z.object({ motivo: z.string().min(1).describe("Para qué hace falta Docker, en una frase para el usuario") }),
    resumen: ({ motivo }) => `Docker: ${motivo}`,
    async ejecutar({ motivo }, ctx) {
      let docker = ruta();
      if (docker && (await motorListo(docker, ctx.senal, ejecutar))) return "Docker ya está instalado y el motor responde.";

      const p = plan();
      if (!docker) {
        if (!p.instalar) throw new ErrorHerramienta(`Docker no está instalado. ${p.aMano}`);
        const respuesta = await ctx.preguntar({
          texto:
            `Docker no está instalado. ${motivo}\n¿Instalo Docker Desktop ${p.con}? Pedirá permisos de administrador, ` +
            "la primera vez hay que aceptar sus términos y puede pedir reiniciar.",
          opciones: [ACEPTAR, "No instalar"],
        });
        if (respuesta.trim() !== ACEPTAR) return "El usuario no ha querido instalar Docker. No lo vuelvas a proponer en esta tarea.";
        ctx.progreso(`Instalando Docker Desktop ${p.con}…\n`);
        const r = await ejecutar(p.instalar, ctx.senal, (t) => ctx.progreso(t));
        if (r.codigo !== 0) throw new ErrorHerramienta(`No se pudo instalar Docker Desktop ${p.con} (código ${r.codigo}):\n${r.salida.slice(-1500)}`);
        docker = ruta();
        if (!docker) return `Docker Desktop se ha instalado, pero aún no se encuentra docker. ${p.despues ? `Puede que haga falta reiniciar (${p.despues}).` : ""}`.trim();
      }

      // Instalado pero parado: se arranca Docker Desktop y se espera al motor.
      if (p.arrancar) {
        ctx.progreso("Arrancando Docker Desktop…\n");
        await ejecutar(p.arrancar, ctx.senal).catch(() => undefined);
      }
      const limite = Date.now() + (o.esperaMotorMs ?? 180_000);
      while (Date.now() < limite) {
        if (await motorListo(docker, ctx.senal, ejecutar)) return "Docker está instalado y el motor responde.";
        if (ctx.senal.aborted) throw new ErrorHerramienta("Parado.");
        await Bun.sleep(5000);
      }
      return (
        "Docker Desktop está instalado pero su motor aún no responde. Si es la primera vez, el usuario tiene que abrir Docker Desktop " +
        `y aceptar sus términos${plan().despues ? `; ${plan().despues}` : ""}. Díselo y prueba de nuevo después.`
      );
    },
  });
}
