import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evento } from "@aquiles/protocolo";
import { ejecutarTurno } from "../src/bucle";
import { leer } from "../src/herramientas/leer";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import type { Mensaje } from "../src/tipos";

async function turno(proveedor: ProveedorSimulado, opciones: { senal?: AbortSignal; max?: number } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "aquiles-bucle-"));
  await writeFile(join(cwd, "nota.txt"), "El código es 4471.");
  const eventos: Evento[] = [];
  const mensajes: Mensaje[] = [{ rol: "usuario", texto: "¿Qué pone en nota.txt?" }];
  const r = await ejecutarTurno({
    sesionId: "s1",
    cwd,
    sistema: "sistema de prueba",
    mensajes,
    proveedor,
    herramientas: [leer],
    emitir: (e) => eventos.push(e),
    senal: opciones.senal ?? new AbortController().signal,
    maxIteraciones: opciones.max,
  });
  return { r, eventos, mensajes };
}

test("pide una herramienta, recibe el resultado y contesta", async () => {
  const p = new ProveedorSimulado([
    () => ({ texto: "Lo miro.", llamadas: [{ id: "h1", nombre: "leer", argumentos: { ruta: "nota.txt" } }], uso: { entrada: 10, salida: 2 } }),
    (pet) => {
      const res = pet.mensajes.at(-1);
      return { texto: res?.rol === "herramienta" && res.resultado.includes("4471") ? "Pone 4471." : "No lo sé.", llamadas: [], uso: { entrada: 20, salida: 3 } };
    },
  ]);
  const { r, eventos, mensajes } = await turno(p);
  expect(r).toMatchObject({ motivo: "fin", texto: "Pone 4471.", uso: { entrada: 30, salida: 5 } });
  expect(mensajes.map((m) => m.rol)).toEqual(["usuario", "asistente", "herramienta", "asistente"]);
  expect(eventos.map((e) => e.tipo).filter((t, i, a) => t !== a[i - 1])).toEqual([
    "mensaje.delta", "herramienta.inicio", "herramienta.fin", "mensaje.delta", "turno.fin",
  ]);
  expect(p.peticiones[0]?.herramientas[0]?.esquema).toMatchObject({ type: "object", required: ["ruta"] });
});

test("herramienta desconocida y argumentos malos vuelven al modelo como error", async () => {
  const p = new ProveedorSimulado([
    () => ({
      texto: "",
      llamadas: [
        { id: "a", nombre: "borrar_todo", argumentos: {} },
        { id: "b", nombre: "leer", argumentos: { ruta: 5 } },
      ],
    }),
    () => ({ texto: "Vale.", llamadas: [] }),
  ]);
  const { mensajes } = await turno(p);
  const resultados = mensajes.filter((m) => m.rol === "herramienta");
  expect(resultados.every((m) => m.rol === "herramienta" && m.error)).toBe(true);
  expect(resultados[0]?.rol === "herramienta" && resultados[0].resultado).toContain("desconocida");
  expect(resultados[1]?.rol === "herramienta" && resultados[1].resultado).toContain("ruta");
});

test("parar corta el turno", async () => {
  const control = new AbortController();
  const p = new ProveedorSimulado([() => ({ texto: "x".repeat(400), llamadas: [] })], 5);
  setTimeout(() => control.abort(), 30);
  const { r } = await turno(p, { senal: control.signal });
  expect(r.motivo).toBe("parado");
});

test("límite de iteraciones", async () => {
  const p = new ProveedorSimulado([() => ({ texto: "otra vez", llamadas: [{ id: "h", nombre: "leer", argumentos: { ruta: "nota.txt" } }] })]);
  const { r } = await turno(p, { max: 3 });
  expect(r.motivo).toBe("limite");
  expect(p.peticiones.length).toBe(3);
});

test("un fallo del proveedor termina el turno con error", async () => {
  const p = new ProveedorSimulado([() => {
    throw new Error("cuota agotada");
  }]);
  const { r } = await turno(p);
  expect(r).toMatchObject({ motivo: "error", error: "cuota agotada" });
});
