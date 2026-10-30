import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAVE_ENTORNO, nombreContenedor } from "../src/herramientas/entornos";
import { cerrarEstadoSesion } from "../src/herramientas/index";
import { procesos } from "../src/herramientas/procesos";
import { elegirShell, estadoTerminal } from "../src/herramientas/shell";
import { terminal } from "../src/herramientas/terminal";
import { type ContextoPrueba, carpetaTemporal, contextoPrueba, vivo } from "./contexto-prueba";

// Los falsos de docker y ssh lanzan Git Bash como si fuera el shell del contenedor o de la otra máquina.
const bash = elegirShell().tipo === "bash";
const barras = (ruta: string) => ruta.replace(/\\/g, "/");
const bun = JSON.stringify(barras(process.execPath));
const falsoDocker = join(import.meta.dir, "docker-falso.ts");

let dir = "";
let registro = "";
let borrar = async () => {};
let borrarRegistro = async () => {};
const abiertos: ContextoPrueba[] = [];
const variables: Record<string, string> = {};

beforeAll(async () => {
  ({ dir, borrar } = await carpetaTemporal("entornos"));
  ({ dir: registro, borrar: borrarRegistro } = await carpetaTemporal("entornos-registro"));
  await mkdir(join(dir, "sub"));
  await mkdir(join(dir, "remoto", "sub"), { recursive: true });
  await writeFile(join(dir, "espera.js"), "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
  Object.assign(variables, {
    AQUILES_DOCKER: `${bun} ${JSON.stringify(barras(falsoDocker))}`,
    AQUILES_SSH: `${bun} ${JSON.stringify(barras(join(import.meta.dir, "ssh-falso.ts")))}`,
    AQUILES_FALSO_BASH: elegirShell().ejecutable,
    AQUILES_FALSO_DIR: registro,
    AQUILES_FALSO_HOME: join(dir, "remoto"),
  });
  Object.assign(process.env, variables);
});
afterAll(async () => {
  await Promise.all(abiertos.map((c) => c.cerrar()));
  for (const clave of Object.keys(variables)) delete process.env[clave];
  await Promise.all([borrar(), borrarRegistro()]);
});

const DOCKER = { entorno: "docker", imagen: "debian:prueba" };
const ssh = (destino: string) => ({ entorno: "ssh", imagen: "debian:prueba", ssh: destino });

const nuevoCtx = (ajuste: object) => {
  const c = contextoPrueba(dir, { sesionId: crypto.randomUUID() });
  c.estado.set(CLAVE_ENTORNO, ajuste);
  abiertos.push(c);
  return c;
};

interface Apunte {
  orden?: string[];
  fin?: string[];
  codigo?: number;
}
/** Lo que recibieron los falsos y que menciona `clave` (el contenedor o el destino del test). */
const ordenes = async (clave: string): Promise<Apunte[]> =>
  (await readFile(join(registro, "ordenes.log"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Apunte)
    .filter((a) => (a.orden ?? a.fin)?.includes(clave));

const leerPid = async (fichero: string) => {
  for (let i = 0; i < 100; i++) {
    const t = await readFile(fichero, "utf8").catch(() => "");
    if (t) return Number(t);
    await Bun.sleep(50);
  }
  throw new Error(`no apareció ${fichero}`);
};

const esperarMuerto = async (pid: number) => {
  for (let i = 0; i < 40 && vivo(pid); i++) await Bun.sleep(50);
  return !vivo(pid);
};

const esKill = (args: string[] | undefined) => /kill -9 -\d+'?$/.test(args?.at(-1) ?? "");

test("nombre del contenedor: 12 caracteres de la sesión, saneados", () => {
  expect(nombreContenedor("3f2a9c1e-77b0-4d1e-9a2b-000000000000")).toBe("aquiles-3f2a9c1e-77b");
  expect(nombreContenedor("ab/cd ef:0123456789")).toBe("aquiles-ab-cd-ef-012");
});

describe.skipIf(!bash)("terminal en Docker", () => {
  test("crea el contenedor endurecido, mantiene cd y variables y avisa una sola vez", async () => {
    const ctx = nuevoCtx(DOCKER);
    const nombre = nombreContenedor(ctx.sesionId);
    expect(await terminal.ejecutar({ comando: "echo hola" }, ctx)).toBe(
      `hola\n[código de salida 0]\n[terminal en Docker: contenedor ${nombre} (debian:prueba) con la carpeta de trabajo montada en /trabajo; ` +
        "leer, escribir y editar usan las rutas de este equipo]",
    );
    await terminal.ejecutar({ comando: "cd sub && export X='it'\"'\"'s'" }, ctx);
    expect(await terminal.ejecutar({ comando: 'basename "$PWD"\necho "$X"' }, ctx)).toBe("sub\nit's\n[código de salida 0]");
    expect(estadoTerminal(ctx.estado).shell?.cwd).toEndWith("/sub");
    expect(ctx.progresos.join("")).toContain(`[creando el contenedor ${nombre} con debian:prueba]`);

    const apuntes = await ordenes(nombre);
    expect(apuntes.find((a) => a.orden?.[0] === "run")?.orden).toEqual([
      "run", "-d", "--rm", "--name", nombre,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "256", "--memory", "2g", "--cpus", "2",
      "-v", `${dir}:/trabajo`, "-w", "/trabajo", "debian:prueba", "sleep", "infinity",
    ]);
    // Un solo shell persistente para los tres comandos.
    expect(apuntes.filter((a) => a.orden?.[0] === "exec" && a.orden[1] === "-i")).toHaveLength(1);
  }, 30_000);

  test("reutiliza el contenedor si ya existe", async () => {
    const ctx = nuevoCtx(DOCKER);
    const nombre = nombreContenedor(ctx.sesionId);
    // Como si quedara de antes de reiniciar el núcleo.
    Bun.spawnSync([process.execPath, falsoDocker, "run", "-d", "--rm", "--name", nombre, "-v", `${dir}:/trabajo`, "vieja", "sleep", "infinity"]);
    expect(await terminal.ejecutar({ comando: "echo sigue" }, ctx)).toStartWith("sigue\n[código de salida 0]");
    expect((await ordenes(nombre)).filter((a) => a.orden?.[0] === "run")).toHaveLength(1);
  }, 30_000);

  test("timeout y cancelar matan el proceso dentro del contenedor", async () => {
    const ctx = nuevoCtx(DOCKER);
    const nombre = nombreContenedor(ctx.sesionId);
    const r = await terminal.ejecutar({ comando: `echo antes; ${bun} espera.js pid-docker-tiempo.txt`, timeout_s: 2 }, ctx);
    expect(r).toStartWith("antes\n");
    expect(r).toContain("superó el límite de 2 s");
    expect(await esperarMuerto(await leerPid(join(dir, "pid-docker-tiempo.txt")))).toBe(true);
    // El kill fue al grupo de dentro y el exec terminó por eso, no porque se matara el cliente local.
    const apuntes = await ordenes(nombre);
    expect(apuntes.some((a) => a.orden?.[0] === "exec" && a.orden[1] === nombre && esKill(a.orden))).toBe(true);
    expect(apuntes.some((a) => a.fin?.[0] === "exec" && a.fin[1] === "-i")).toBe(true);
    expect(await terminal.ejecutar({ comando: "echo de nuevo" }, ctx)).toBe("de nuevo\n[código de salida 0]");

    setTimeout(() => ctx.controlador.abort(), 1500);
    const c = await terminal.ejecutar({ comando: `${bun} espera.js pid-docker-cancelado.txt` }, ctx);
    expect(c).toContain("cancelado por el usuario");
    expect(await esperarMuerto(await leerPid(join(dir, "pid-docker-cancelado.txt")))).toBe(true);
  }, 40_000);

  test("segundo plano dentro del contenedor: salida y parar", async () => {
    const ctx = nuevoCtx(DOCKER);
    const nombre = nombreContenedor(ctx.sesionId);
    await terminal.ejecutar({ comando: "cd sub" }, ctx);
    const r = await terminal.ejecutar(
      { comando: `echo "inicio en $(basename "$PWD")"; ${bun} ../espera.js ../pid-docker-fondo.txt`, segundo_plano: true, nombre: "espera" },
      ctx,
    );
    expect(r).toMatch(new RegExp(`^Lanzado en segundo plano con id p1 \\(espera\\), en \\S+/sub de Docker \\(${nombre}\\)\\.`));
    const pid = await leerPid(join(dir, "pid-docker-fondo.txt"));
    expect(await procesos.ejecutar({ accion: "salida", id: "espera" }, ctx)).toMatch(/^inicio en sub\n\[p1: en marcha/);
    expect(await procesos.ejecutar({ accion: "parar", id: "p1" }, ctx)).toBe("[p1 parado]");
    expect(await esperarMuerto(pid)).toBe(true);
    expect((await ordenes(nombre)).filter((a) => a.orden?.[0] === "exec" && esKill(a.orden))).toHaveLength(1);
  }, 30_000);

  test("cerrar la sesión hace docker rm -f y mata lo que corría dentro", async () => {
    const ctx = nuevoCtx(DOCKER);
    const nombre = nombreContenedor(ctx.sesionId);
    await terminal.ejecutar({ comando: `${bun} espera.js pid-dcierre-fondo.txt`, segundo_plano: true }, ctx);
    const enCurso = terminal.ejecutar({ comando: `${bun} espera.js pid-dcierre-shell.txt` }, ctx);
    const pidFondo = await leerPid(join(dir, "pid-dcierre-fondo.txt"));
    const pidShell = await leerPid(join(dir, "pid-dcierre-shell.txt"));
    await cerrarEstadoSesion(ctx.estado);
    expect(await enCurso).toContain("el shell terminó");
    expect(await esperarMuerto(pidFondo)).toBe(true);
    expect(await esperarMuerto(pidShell)).toBe(true);
    const apuntes = await ordenes(nombre);
    expect(apuntes).toContainEqual({ orden: ["rm", "-f", nombre] });
    // rm -f ya lo mata todo: no hace falta un kill por proceso.
    expect(apuntes.filter((a) => esKill(a.orden))).toHaveLength(0);
  }, 30_000);

  test("sin Docker o sin demonio: error claro y sin colgarse", async () => {
    const inicio = Date.now();
    try {
      process.env.AQUILES_DOCKER = join(dir, "no-existe", "docker.exe");
      await expect(terminal.ejecutar({ comando: "echo x" }, nuevoCtx(DOCKER))).rejects.toThrow(
        "Docker no está instalado o no responde: no se pudo ejecutar",
      );
      process.env.AQUILES_DOCKER = variables.AQUILES_DOCKER;
      process.env.AQUILES_FALSO_CAIDO = "1";
      const caido = "Docker no está instalado o no responde: Cannot connect to the Docker daemon";
      await expect(terminal.ejecutar({ comando: "echo x" }, nuevoCtx(DOCKER))).rejects.toThrow(caido);
      await expect(terminal.ejecutar({ comando: "sleep 1", segundo_plano: true }, nuevoCtx(DOCKER))).rejects.toThrow(caido);
    } finally {
      process.env.AQUILES_DOCKER = variables.AQUILES_DOCKER;
      delete process.env.AQUILES_FALSO_CAIDO;
    }
    expect(Date.now() - inicio).toBeLessThan(5000);
  }, 10_000);

  test("ajustes incompletos o local", async () => {
    await expect(terminal.ejecutar({ comando: "echo x" }, nuevoCtx({ entorno: "docker", imagen: " " }))).rejects.toThrow("Falta una imagen de Docker");
    await expect(terminal.ejecutar({ comando: "echo x" }, nuevoCtx({ entorno: "ssh", imagen: "x" }))).rejects.toThrow("Falta un destino SSH");
    await expect(terminal.ejecutar({ comando: "echo x" }, nuevoCtx(ssh("-oProxyCommand=calc")))).rejects.toThrow("Falta un destino SSH válido");
    expect(await terminal.ejecutar({ comando: "echo local" }, nuevoCtx({ entorno: "local", imagen: "x" }))).toBe("local\n[código de salida 0]");
  });
});

describe.skipIf(!bash)("terminal por SSH", () => {
  // El «home» remoto es otra carpeta: espera.js va con ruta absoluta.
  const espera = (pid: string) => `${bun} "${barras(dir)}/espera.js" "${barras(dir)}/${pid}"`;

  test("shell remoto persistente y aviso de ficheros locales una sola vez", async () => {
    const destino = `yo@maquina-${crypto.randomUUID().slice(0, 8)}`;
    const ctx = nuevoCtx(ssh(destino));
    expect(await terminal.ejecutar({ comando: 'echo "hola desde $(basename "$PWD")"' }, ctx)).toBe(
      `hola desde remoto\n[código de salida 0]\n[terminal por SSH en ${destino}: los comandos corren allí, ` +
        "pero leer, escribir y editar siguen trabajando con los ficheros de este equipo]",
    );
    await terminal.ejecutar({ comando: "cd sub && export X=valor" }, ctx);
    expect(await terminal.ejecutar({ comando: 'basename "$PWD"; echo "$X"' }, ctx)).toBe("sub\nvalor\n[código de salida 0]");
    const apuntes = (await ordenes(destino)).filter((a) => a.orden);
    expect(apuntes).toHaveLength(1);
    expect(apuntes[0]?.orden?.slice(0, 8)).toEqual(["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=15", destino]);
    expect(apuntes[0]?.orden?.[8]).toStartWith("sh -c '");
  }, 30_000);

  test("sin clave: error claro, también en segundo plano", async () => {
    const error = "No se pudo conectar por SSH a yo@sin-clave: yo@sin-clave: Permission denied (publickey). Solo se usan claves (BatchMode=yes)";
    await expect(terminal.ejecutar({ comando: "echo x" }, nuevoCtx(ssh("yo@sin-clave")))).rejects.toThrow(error);
    const ctx = nuevoCtx(ssh("yo@sin-clave"));
    await expect(terminal.ejecutar({ comando: "sleep 1", segundo_plano: true }, ctx)).rejects.toThrow(error);
    expect(estadoTerminal(ctx.estado).procesos.size).toBe(0);
  }, 20_000);

  test("timeout y segundo plano matan lo que corre al otro lado", async () => {
    const destino = `yo@maquina-${crypto.randomUUID().slice(0, 8)}`;
    const ctx = nuevoCtx(ssh(destino));
    const r = await terminal.ejecutar({ comando: `echo antes; ${espera("pid-ssh-tiempo.txt")}`, timeout_s: 2 }, ctx);
    expect(r).toStartWith("antes\n");
    expect(r).toContain("superó el límite de 2 s");
    expect(await esperarMuerto(await leerPid(join(dir, "pid-ssh-tiempo.txt")))).toBe(true);
    let apuntes = await ordenes(destino);
    expect(apuntes.filter((a) => esKill(a.orden))).toHaveLength(1);
    expect(apuntes.some((a) => a.fin?.at(-1)?.includes("exec bash"))).toBe(true);

    const lanzado = await terminal.ejecutar({ comando: `echo "en $(basename "$PWD")"; ${espera("pid-ssh-fondo.txt")}`, segundo_plano: true }, ctx);
    expect(lanzado).toContain(`id p1, en la carpeta del usuario de SSH (${destino})`);
    const pid = await leerPid(join(dir, "pid-ssh-fondo.txt"));
    expect(await procesos.ejecutar({ accion: "salida", id: "p1" }, ctx)).toMatch(/^en remoto\n\[p1: en marcha/);
    expect(await procesos.ejecutar({ accion: "parar", id: "p1" }, ctx)).toBe("[p1 parado]");
    expect(await esperarMuerto(pid)).toBe(true);
    apuntes = await ordenes(destino);
    expect(apuntes.filter((a) => esKill(a.orden))).toHaveLength(2);
  }, 40_000);
});
