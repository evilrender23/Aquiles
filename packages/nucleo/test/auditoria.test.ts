import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUTA_RPC } from "@aquiles/protocolo";
import { Auditoria } from "../src/auditoria";
import { escribir } from "../src/herramientas/escribir";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { iniciarServidor } from "../src/servidor";
import { herramientaEco } from "./turno-prueba";

const carpetas = async () => ({ dir: await mkdtemp(join(tmpdir(), "aquiles-aud-")), trabajo: await mkdtemp(join(tmpdir(), "aquiles-aud-trabajo-")) });

test("cambios de un turno: creado y modificado; deshacer los deja como estaban, una sola vez", async () => {
  const { dir, trabajo } = await carpetas();
  const a = new Auditoria(dir);
  const viejo = join(trabajo, "viejo.txt");
  const nuevo = join(trabajo, "nuevo.txt");
  await writeFile(viejo, "antes");
  a.empezarTurno("s1", "t1", "cambia los ficheros");
  a.antes("s1", "t1", [viejo, nuevo]);
  await writeFile(viejo, "después");
  await writeFile(nuevo, "nuevo");
  a.despues("s1", "t1", [viejo, nuevo]);
  // Una segunda escritura en el mismo turno no cambia la copia de antes.
  a.antes("s1", "t1", [viejo]);
  await writeFile(viejo, "después 2");
  a.despues("s1", "t1", [viejo]);

  expect(a.cambios("s1")).toEqual([
    {
      turno: "t1", fecha: expect.any(String), pedido: "cambia los ficheros", deshecho: false,
      ficheros: [
        { ruta: viejo, accion: "modificado", deshacible: true },
        { ruta: nuevo, accion: "creado", deshacible: true },
      ],
    },
  ]);
  expect(a.deshacer("s1", "t1")).toEqual({ restaurados: [viejo, nuevo], conflictos: [] });
  expect(await readFile(viejo, "utf8")).toBe("antes");
  expect(existsSync(nuevo)).toBe(false);
  expect(a.cambios("s1")[0]?.deshecho).toBe(true);
  expect(() => a.deshacer("s1", "t1")).toThrow("ya se deshizo");
});

test("un fichero que cambió después del turno no se pisa; uno que no cambió no aparece", async () => {
  const { dir, trabajo } = await carpetas();
  const a = new Auditoria(dir);
  const f = join(trabajo, "f.txt");
  const igual = join(trabajo, "igual.txt");
  await writeFile(f, "uno");
  await writeFile(igual, "igual");
  a.empezarTurno("s1", "t1", "x");
  a.antes("s1", "t1", [f, igual]);
  await writeFile(f, "dos");
  a.despues("s1", "t1", [f, igual]);
  await writeFile(f, "tres, a mano");
  expect(a.cambios("s1")[0]?.ficheros.map((x) => x.ruta)).toEqual([f]);
  expect(a.deshacer("s1", "t1")).toEqual({ restaurados: [], conflictos: [{ ruta: f, motivo: "ha cambiado después de este turno; no se toca" }] });
  expect(await readFile(f, "utf8")).toBe("tres, a mano");
});

test("registro: una línea por herramienta; borrar la sesión se lleva registro, cambios y copias", async () => {
  const { dir, trabajo } = await carpetas();
  const a = new Auditoria(dir);
  const e = { fecha: "2026-11-03T10:00:00Z", turno: "t1", herramienta: "terminal", resumen: "ls", nivel: "ejecucion" as const, aprobacion: "usuario" as const, ok: true, ms: 12, rutas: [] };
  a.registrar("s1", e);
  expect(a.leer("s1")).toEqual([e]);
  a.empezarTurno("s1", "t1", "x");
  await writeFile(join(trabajo, "a.txt"), "a");
  a.antes("s1", "t1", [join(trabajo, "a.txt")]);
  a.borrar("s1");
  expect(a.leer("s1")).toEqual([]);
  expect(a.cambios("s1")).toEqual([]);
  expect(existsSync(join(dir, "s1"))).toBe(false);
});

test("servidor: el turno queda en el registro (con quién lo aprobó), sus cambios se listan y se deshacen", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "aquiles-aud-srv-"));
  await writeFile(join(cwd, "nota.txt"), "original\n");
  const proveedor = new ProveedorSimulado([
    (p) => {
      const ultimo = p.mensajes.at(-1);
      if (ultimo?.rol === "herramienta") return { texto: "hecho", llamadas: [] };
      const pedido = ultimo?.rol === "usuario" ? ultimo.texto : "";
      if (pedido.startsWith("eco")) return { texto: "", llamadas: [{ id: "e1", nombre: "eco", argumentos: { texto: "hola" } }] };
      return { texto: "", llamadas: [{ id: "w1", nombre: "escribir", argumentos: { ruta: "nuevo.txt", contenido: "creado por el agente\n" } }] };
    },
  ]);
  const servidor = iniciarServidor({
    puerto: 0, token: "token-auditoria-0123456789", proveedor: "simulado", fabrica: () => proveedor, herramientas: [escribir, herramientaEco()],
    cwdPorDefecto: cwd, version: "0.0.0", perfil: await mkdtemp(join(tmpdir(), "aquiles-aud-perfil-")),
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=token-auditoria-0123456789`);
    const eventos: any[] = [];
    const pendientes = new Map<number, (r: any) => void>();
    let n = 0;
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id && pendientes.has(d.id)) pendientes.get(d.id)!(d);
      else if (d.method === "evento") eventos.push(d.params);
      // Permisos: el de eco (ejecución) se concede desde «la app».
      else if (d.method === "aprobacion.pedir") ws.send(JSON.stringify({ jsonrpc: "2.0", id: d.id, result: { respuesta: "permitir" } }));
    };
    await new Promise((r) => (ws.onopen = r));
    const llamar = (method: string, params: unknown) =>
      new Promise<any>((ok) => {
        pendientes.set(++n, ok);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
      });
    const esperarFin = async () => {
      for (let i = 0; i < 200 && !eventos.some((e) => e.tipo === "turno.fin"); i++) await Bun.sleep(10);
      eventos.length = 0;
    };

    const { result: s } = await llamar("sesion.crear", {});
    await llamar("prompt.enviar", { sesionId: s.sesionId, texto: "crea un fichero" });
    await esperarFin();
    await llamar("prompt.enviar", { sesionId: s.sesionId, texto: "eco" });
    await esperarFin();

    const { entradas } = (await llamar("auditoria.leer", { sesionId: s.sesionId })).result;
    expect(entradas.map((e: any) => [e.herramienta, e.aprobacion, e.ok])).toEqual([
      ["escribir", "automatica", true],
      ["eco", "usuario", true],
    ]);
    expect(entradas[0].rutas).toEqual([join(cwd, "nuevo.txt")]);

    const { turnos } = (await llamar("cambios.listar", { sesionId: s.sesionId })).result;
    expect(turnos).toHaveLength(1);
    expect(turnos[0]).toMatchObject({ pedido: "crea un fichero", ficheros: [{ ruta: join(cwd, "nuevo.txt"), accion: "creado" }] });
    expect(existsSync(join(cwd, "nuevo.txt"))).toBe(true);
    expect((await llamar("cambios.deshacer", { sesionId: s.sesionId, turno: turnos[0].turno })).result).toEqual({ restaurados: [join(cwd, "nuevo.txt")], conflictos: [] });
    expect(existsSync(join(cwd, "nuevo.txt"))).toBe(false);
    expect((await llamar("cambios.deshacer", { sesionId: s.sesionId, turno: turnos[0].turno })).error.message).toContain("ya se deshizo");
    ws.close();
  } finally {
    servidor.detener();
  }
});
