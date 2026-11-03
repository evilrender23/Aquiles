import { expect, test } from "bun:test";
import { herramientaInstalarDocker } from "../src/herramientas/docker";
import type { ContextoHerramienta, Pregunta } from "../src/herramientas/herramienta";

function contexto(respuesta: string) {
  const preguntas: Pregunta[] = [];
  const ctx: ContextoHerramienta = {
    cwd: ".", senal: new AbortController().signal, sesionId: "s", lecturas: new Map(), estado: new Map(),
    preguntar: async (p) => {
      preguntas.push(p);
      return respuesta;
    },
    notificar: () => {},
    progreso: () => {},
  };
  return { ctx, preguntas };
}

/** Simula winget y docker: `instalado` cambia cuando winget termina. */
function sistema(o: { instalado: boolean; motor: boolean; plataforma?: string; hayBrew?: boolean }) {
  const ordenes: string[][] = [];
  const ejecutar = async (orden: string[]) => {
    ordenes.push(orden);
    if (orden[0] === "winget" || orden[0] === "brew") {
      o.instalado = true;
      return { codigo: 0, salida: "Successfully installed" };
    }
    if (orden[1] === "info") return { codigo: o.motor ? 0 : 1, salida: o.motor ? "29.0.0" : "error" };
    return { codigo: 0, salida: "" };
  };
  const h = herramientaInstalarDocker({ ejecutar, esperaMotorMs: 0, plataforma: o.plataforma ?? "win32", hayBrew: o.hayBrew ?? false, ruta: () => (o.instalado ? "C:/docker.exe" : undefined) });
  return { h, ordenes };
}

test("sin Docker pregunta antes y solo instala si el usuario acepta", async () => {
  const no = sistema({ instalado: false, motor: false });
  const c1 = contexto("No instalar");
  expect(await no.h.ejecutar({ motivo: "Para la terminal en contenedor." }, c1.ctx)).toContain("no ha querido");
  expect(c1.preguntas[0]?.opciones).toEqual(["Instalar Docker Desktop", "No instalar"]);
  expect(no.ordenes.some((o) => o[0] === "winget")).toBe(false);

  // Una tarea sin nadie delante recibe otra respuesta: tampoco instala.
  const sinNadie = sistema({ instalado: false, motor: false });
  await sinNadie.h.ejecutar({ motivo: "x" }, contexto("No hay nadie para responder; decide tú.").ctx);
  expect(sinNadie.ordenes.some((o) => o[0] === "winget")).toBe(false);

  const si = sistema({ instalado: false, motor: false });
  const r = await si.h.ejecutar({ motivo: "x" }, contexto("Instalar Docker Desktop").ctx);
  expect(si.ordenes.find((o) => o[0] === "winget")).toEqual([
    "winget", "install", "-e", "--id", "Docker.DockerDesktop", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
  ]);
  expect(r).toContain("aceptar sus términos");
});

test("con Docker funcionando no pregunta ni instala", async () => {
  const s = sistema({ instalado: true, motor: true });
  const c = contexto("Instalar Docker Desktop");
  expect(await s.h.ejecutar({ motivo: "x" }, c.ctx)).toBe("Docker ya está instalado y el motor responde.");
  expect(c.preguntas).toHaveLength(0);
});

test("la descripción y la instalación dependen del sistema: winget, Homebrew o a mano", async () => {
  expect(sistema({ instalado: false, motor: false }).h.descripcion).toContain("con winget");
  const mac = sistema({ instalado: false, motor: false, plataforma: "darwin", hayBrew: true });
  expect(mac.h.descripcion).toContain("con Homebrew");
  expect(mac.h.descripcion).not.toContain("winget");
  await mac.h.ejecutar({ motivo: "x" }, contexto("Instalar Docker Desktop").ctx);
  expect(mac.ordenes.find((o) => o[0] === "brew")).toEqual(["brew", "install", "--cask", "docker"]);
  expect(mac.ordenes).toContainEqual(["open", "-a", "Docker"]);

  const sinBrew = sistema({ instalado: false, motor: false, plataforma: "darwin", hayBrew: false });
  expect(sinBrew.h.descripcion).toContain("aquí no se instala solo");
  await expect(sinBrew.h.ejecutar({ motivo: "x" }, contexto("Instalar Docker Desktop").ctx)).rejects.toThrow("docker.com");
  const linux = sistema({ instalado: false, motor: false, plataforma: "linux" });
  await expect(linux.h.ejecutar({ motivo: "x" }, contexto("Instalar Docker Desktop").ctx)).rejects.toThrow("gestor de paquetes");
});
