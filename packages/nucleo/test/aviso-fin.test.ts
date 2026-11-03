import { expect, test } from "bun:test";
import { fraseDeFin, limpiarFrase } from "../src/aviso-fin";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import type { Mensaje } from "../src/tipos";

const conversacion: Mensaje[] = [
  { rol: "usuario", texto: "Traduce el informe trimestral al inglés y guárdalo como informe-en.docx" },
  { rol: "asistente", texto: "Hecho: informe-en.docx está en la carpeta.", llamadas: [] },
];

test("limpiarFrase: una línea que empieza por «He acabado», sin comillas y con punto", () => {
  expect(limpiarFrase("«He acabado de traducir el informe»\nY algo más")).toBe("He acabado de traducir el informe.");
  expect(limpiarFrase("He terminado la migración!")).toBe("He terminado la migración!");
  expect(limpiarFrase("Claro, aquí tienes: He acabado")).toBeUndefined();
  expect(limpiarFrase(`He acabado ${"muy ".repeat(60)}bien`)).toBeUndefined();
});

test("fraseDeFin: la escribe el modelo con lo pedido y la respuesta final, sin herramientas", async () => {
  const p = new ProveedorSimulado([() => ({ texto: "He acabado de traducir el informe trimestral al inglés", llamadas: [] })]);
  expect(await fraseDeFin({ proveedor: p, mensajes: conversacion, cwd: "/tmp" })).toBe("He acabado de traducir el informe trimestral al inglés.");
  const pedida = p.peticiones[0]!;
  expect(pedida.herramientas).toEqual([]);
  expect(pedida.sistema).toContain("«He acabado»");
  expect(pedida.mensajes[0]).toMatchObject({ rol: "usuario" });
  expect((pedida.mensajes[0] as { texto: string }).texto).toContain("informe-en.docx está en la carpeta");
});

test("fraseDeFin: si el modelo falla o contesta otra cosa, «He acabado: <lo pedido>»", async () => {
  const roto = new ProveedorSimulado([
    () => {
      throw new Error("sin cuota");
    },
  ]);
  expect(await fraseDeFin({ proveedor: roto, mensajes: conversacion, cwd: "/tmp" })).toBe(
    "He acabado: Traduce el informe trimestral al inglés y guárdalo como informe-en.docx",
  );
  const charlatan = new ProveedorSimulado([() => ({ texto: "Claro, te cuento lo que he hecho…", llamadas: [] })]);
  const larga: Mensaje[] = [{ rol: "usuario", texto: "palabra ".repeat(40) }];
  expect(await fraseDeFin({ proveedor: charlatan, mensajes: larga, cwd: "/tmp" })).toMatch(/^He acabado: (palabra ){9}palabra…$/);
});

test("servidor: al acabar un turno de la app, notificación «He acabado …»; con «nada», ninguna", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RUTA_RPC } = await import("@aquiles/protocolo");
  const { iniciarServidor } = await import("../src/servidor");
  const proveedor = new ProveedorSimulado([
    (p) => ({ texto: p.sistema.includes("«He acabado»") ? "He acabado de saludar" : "hola", llamadas: [] }),
  ]);
  const servidor = iniciarServidor({
    puerto: 0, token: "token-aviso-0123456789", proveedor: "simulado", fabrica: () => proveedor, herramientas: [],
    cwdPorDefecto: await mkdtemp(join(tmpdir(), "aquiles-aviso-")), version: "0.0.0",
    perfil: await mkdtemp(join(tmpdir(), "aquiles-aviso-perfil-")), avisoFinDesdeMs: 0,
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=token-aviso-0123456789`);
    const eventos: any[] = [];
    const pendientes = new Map<number, (r: any) => void>();
    let n = 0;
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id && pendientes.has(d.id)) pendientes.get(d.id)!(d);
      else if (d.method === "evento") eventos.push(d.params);
    };
    await new Promise((r) => (ws.onopen = r));
    const llamar = (method: string, params: unknown) =>
      new Promise<any>((ok) => {
        pendientes.set(++n, ok);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
      });
    const notificaciones = async (espera = 300) => {
      await Bun.sleep(espera);
      return eventos.filter((e) => e.tipo === "notificacion");
    };

    // Solo la notificación: con «voz», en Mac leería la frase con say de verdad.
    await llamar("ajustes.guardar", { voz: { alAcabar: "notificacion" } });
    const { result: s } = await llamar("sesion.crear", {});
    await llamar("prompt.enviar", { sesionId: s.sesionId, texto: "saluda" });
    expect(await notificaciones()).toEqual([{ tipo: "notificacion", titulo: "Aquiles", texto: "He acabado de saludar.", sesionId: s.sesionId }]);

    eventos.length = 0;
    await llamar("ajustes.guardar", { voz: { alAcabar: "nada" } });
    await llamar("prompt.enviar", { sesionId: s.sesionId, texto: "otra vez" });
    expect(await notificaciones()).toEqual([]);
    ws.close();
  } finally {
    servidor.detener();
  }
});
