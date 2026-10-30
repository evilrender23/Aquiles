import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cerrarEstadoSesion, herramientasPorDefecto } from "../src/herramientas/index";
import { procesos } from "../src/herramientas/procesos";
import { elegirShell, estadoTerminal, formatearSalida, MAX_SALIDA } from "../src/herramientas/shell";
import { primerToken, terminal } from "../src/herramientas/terminal";
import { carpetaTemporal, contextoPrueba, vivo, type ContextoPrueba } from "./contexto-prueba";

const bash = elegirShell().tipo === "bash";
const bun = JSON.stringify(process.execPath.replace(/\\/g, "/"));

let dir = "";
let borrar = async () => {};
const abiertos: ContextoPrueba[] = [];
const nuevoCtx = () => {
  const c = contextoPrueba(dir);
  abiertos.push(c);
  return c;
};

beforeAll(async () => {
  ({ dir, borrar } = await carpetaTemporal("terminal"));
  await mkdir(join(dir, "sub"));
  // Escribe su pid y espera: sirve para comprobar que se mata el árbol entero.
  await writeFile(join(dir, "espera.js"), "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
});
afterAll(async () => {
  await Promise.all(abiertos.map((c) => c.cerrar()));
  await borrar();
});

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

describe.skipIf(!bash)("terminal (bash)", () => {
  test("código de salida, stderr y salida", async () => {
    const ctx = nuevoCtx();
    expect(await terminal.ejecutar({ comando: "echo hola; echo error >&2" }, ctx)).toBe("hola\nerror\n[código de salida 0]");
    expect(await terminal.ejecutar({ comando: "false" }, ctx)).toBe("[código de salida 1]");
    expect(await terminal.ejecutar({ comando: "printf sin-salto; exit_code_no_existe 2>/dev/null; (exit 7)" }, ctx)).toBe(
      "sin-salto\n[código de salida 7]",
    );
    expect(ctx.progresos.join("")).toContain("hola");
    expect(ctx.progresos.join("")).not.toContain("__AQ");
  });

  test("cd y variables persisten; comillas y varias líneas", async () => {
    const ctx = nuevoCtx();
    await terminal.ejecutar({ comando: "cd sub && export X='it'\"'\"'s'" }, ctx);
    expect(await terminal.ejecutar({ comando: 'basename "$PWD"\necho "$X"' }, ctx)).toBe("sub\nit's\n[código de salida 0]");
    expect(estadoTerminal(ctx.estado).shell?.cwd.toLowerCase()).toBe(join(dir, "sub").toLowerCase());
  });

  test("errores de sintaxis no rompen el shell", async () => {
    const ctx = nuevoCtx();
    const r = await terminal.ejecutar({ comando: 'echo "sin cerrar' }, ctx);
    expect(r).toMatch(/\[código de salida 2\]$/);
    expect(await terminal.ejecutar({ comando: "echo sigue" }, ctx)).toBe("sigue\n[código de salida 0]");
  });

  test("stdin vacío: un comando que lee stdin no se cuelga", async () => {
    const ctx = nuevoCtx();
    expect(await terminal.ejecutar({ comando: "cat; echo fin", timeout_s: 10 }, ctx)).toBe("fin\n[código de salida 0]");
  });

  test("entorno sin colores ni paginador", async () => {
    const ctx = nuevoCtx();
    expect(await terminal.ejecutar({ comando: 'echo "$NO_COLOR $TERM $PAGER $GIT_PAGER"' }, ctx)).toBe("1 dumb cat cat\n[código de salida 0]");
  });

  test("exit cierra el shell y la siguiente llamada lo reinicia", async () => {
    const ctx = nuevoCtx();
    await terminal.ejecutar({ comando: "cd sub" }, ctx);
    expect(await terminal.ejecutar({ comando: "exit 3" }, ctx)).toContain("el shell terminó con código 3");
    expect(await terminal.ejecutar({ comando: 'basename "$PWD"' }, ctx)).toMatch(/^aquiles-terminal-/);
  });

  test("timeout mata el árbol y el shell se recupera", async () => {
    const ctx = nuevoCtx();
    const pidFichero = join(dir, "pid-timeout.txt");
    const inicio = Date.now();
    const r = await terminal.ejecutar({ comando: `echo antes; ${bun} espera.js pid-timeout.txt`, timeout_s: 2 }, ctx);
    expect(Date.now() - inicio).toBeLessThan(8000);
    expect(r).toStartWith("antes\n");
    expect(r).toContain("superó el límite de 2 s");
    const pid = await leerPid(pidFichero);
    expect(await esperarMuerto(pid)).toBe(true);
    const shellViejo = estadoTerminal(ctx.estado).shell!;
    expect(shellViejo.vivo).toBe(false);
    expect(await terminal.ejecutar({ comando: "echo de nuevo" }, ctx)).toBe("de nuevo\n[código de salida 0]");
    expect(estadoTerminal(ctx.estado).shell).not.toBe(shellViejo);
    expect(vivo(shellViejo.proc.pid)).toBe(false);
  });

  test("cancelar con la señal mata el comando", async () => {
    const ctx = nuevoCtx();
    setTimeout(() => ctx.controlador.abort(), 500);
    const r = await terminal.ejecutar({ comando: `${bun} espera.js pid-cancelado.txt` }, ctx);
    expect(r).toContain("cancelado por el usuario");
    expect(await esperarMuerto(await leerPid(join(dir, "pid-cancelado.txt")))).toBe(true);
  });

  test("salida enorme: cabeza + cola con aviso", async () => {
    const ctx = nuevoCtx();
    const r = await terminal.ejecutar({ comando: "seq 1 20000" }, ctx);
    expect(r.length).toBeLessThan(MAX_SALIDA + 500);
    expect(r).toStartWith("1\n2\n3\n");
    expect(r).toContain("caracteres omitidos");
    expect(r).toEndWith("19999\n20000\n[código de salida 0]");
  });

  test("segundo plano + procesos listar/salida/parar", async () => {
    const ctx = nuevoCtx();
    await terminal.ejecutar({ comando: "cd sub" }, ctx);
    const r = await terminal.ejecutar(
      { comando: `echo "inicio en $(basename "$PWD")"; ${bun} ../espera.js ../pid-fondo.txt`, segundo_plano: true, nombre: "espera" },
      ctx,
    );
    expect(r).toContain("id p1 (espera)");
    const pid = await leerPid(join(dir, "pid-fondo.txt"));
    expect(vivo(pid)).toBe(true);
    expect(await procesos.ejecutar({ accion: "listar" }, ctx)).toMatch(/^p1 \(espera\) \[en marcha desde hace \d+ s\] echo/);
    expect(await procesos.ejecutar({ accion: "salida", id: "espera" }, ctx)).toMatch(/^inicio en sub\n\[p1: en marcha/);
    await expect(terminal.ejecutar({ comando: "sleep 1", segundo_plano: true, nombre: "espera" }, ctx)).rejects.toThrow("Ya hay un proceso");
    expect(await procesos.ejecutar({ accion: "parar", id: "p1" }, ctx)).toBe("[p1 parado]");
    expect(await esperarMuerto(pid)).toBe(true);
  });
});

describe.skipIf(!bash)("procesos", () => {
  test("salida incremental y parar mata el árbol", async () => {
    const ctx = nuevoCtx();
    await terminal.ejecutar({ comando: `echo uno; sleep 1; echo dos; ${bun} espera.js pid-p.txt`, segundo_plano: true }, ctx);
    const pid = await leerPid(join(dir, "pid-p.txt"));
    const primera = await procesos.ejecutar({ accion: "salida", id: "p1" }, ctx);
    expect(primera).toMatch(/^uno\ndos\n\[p1: en marcha/);
    expect(await procesos.ejecutar({ accion: "salida", id: "p1" }, ctx)).toMatch(/^\(sin salida nueva\)/);
    expect(await procesos.ejecutar({ accion: "parar", id: "p1" }, ctx)).toBe("[p1 parado]");
    expect(await esperarMuerto(pid)).toBe(true);
    expect(await procesos.ejecutar({ accion: "listar" }, ctx)).toMatch(/^p1 \[parado tras \d+ s\]/);
    expect(await procesos.ejecutar({ accion: "parar", id: "p1" }, ctx)).toContain("ya había terminado");
  });

  test("procesos que terminan solos y errores", async () => {
    const ctx = nuevoCtx();
    expect(await procesos.ejecutar({ accion: "listar" }, ctx)).toContain("No hay procesos");
    await terminal.ejecutar({ comando: "echo listo; exit 4", segundo_plano: true, nombre: "corto" }, ctx);
    const p = estadoTerminal(ctx.estado).buscar("corto")!;
    await p.proc.exited;
    await Bun.sleep(100);
    expect(await procesos.ejecutar({ accion: "salida", id: "corto" }, ctx)).toMatch(/^listo\n\[p1: terminó con código 4/);
    await expect(procesos.ejecutar({ accion: "salida", id: "p9" }, ctx)).rejects.toThrow('No hay ningún proceso "p9"');
    await expect(procesos.ejecutar({ accion: "parar" }, ctx)).rejects.toThrow("Falta 'id'");
  });

  test("cerrarEstadoSesion mata shell (con un comando en curso) y procesos en segundo plano", async () => {
    const ctx = contextoPrueba(dir);
    await terminal.ejecutar({ comando: `${bun} espera.js pid-cierre-fondo.txt`, segundo_plano: true }, ctx);
    const enCurso = terminal.ejecutar({ comando: `${bun} espera.js pid-cierre-shell.txt` }, ctx);
    const pidFondo = await leerPid(join(dir, "pid-cierre-fondo.txt"));
    const pidShell = await leerPid(join(dir, "pid-cierre-shell.txt"));
    const shell = estadoTerminal(ctx.estado).shell!;
    await cerrarEstadoSesion(ctx.estado);
    expect(ctx.estado.size).toBe(0);
    expect(await enCurso).toContain("el shell terminó");
    expect(await esperarMuerto(pidFondo)).toBe(true);
    expect(await esperarMuerto(pidShell)).toBe(true);
    expect(await esperarMuerto(shell.proc.pid)).toBe(true);
  });
});

test("resumen, clave de permiso y formato de salida", () => {
  expect(terminal.resumen?.({ comando: "git status" })).toBe("git status");
  expect(terminal.clavePermiso?.({ comando: "  git status --short" })).toBe("git");
  expect(primerToken('"C:/Program Files/x.exe" -v')).toBe("C:/Program Files/x.exe");
  expect(terminal.parametros.safeParse({ comando: "ls", timeout_s: 601 }).success).toBe(false);
  expect(formatearSalida("\x1b[31mrojo\x1b[0m\r\n10%\r50%\r100%\n")).toBe("rojo\n100%\n");
  expect(herramientasPorDefecto().map((h) => h.nombre)).toEqual([
    "leer",
    "buscar_ficheros",
    "buscar_texto",
    "escribir",
    "editar",
    "escribir_documento",
    "terminal",
    "procesos",
    "tareas",
    "preguntar",
    "leer_web",
    "buscar_web",
    "instalar_docker",
  ]);
});
