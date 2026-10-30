import { expect, test } from "bun:test";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { ErrorProveedor, type Proveedor } from "../src/tipos";
import { herramientaEco, turno } from "./turno-prueba";

test("pide una herramienta, recibe el resultado y contesta", async () => {
  const p = new ProveedorSimulado([
    () => ({ texto: "Lo miro.", llamadas: [{ id: "h1", nombre: "leer", argumentos: { ruta: "nota.txt" } }], uso: { entrada: 10, salida: 2 } }),
    (pet) => {
      const res = pet.mensajes.at(-1);
      return { texto: res?.rol === "herramienta" && res.resultado.includes("4471") ? "Pone 4471." : "No lo sé.", llamadas: [], uso: { entrada: 20, salida: 3 } };
    },
  ]);
  const { r, eventos, mensajes, anadidos } = await turno(p);
  expect(r).toMatchObject({ motivo: "fin", texto: "Pone 4471.", uso: { entrada: 30, salida: 5 } });
  expect(mensajes.map((m) => m.rol)).toEqual(["usuario", "asistente", "herramienta", "asistente"]);
  expect(anadidos.length).toBe(3);
  const tipos = eventos.map((e) => e.tipo).filter((t) => t !== "contexto.uso");
  expect(tipos.filter((t, i, a) => t !== a[i - 1])).toEqual(["mensaje.delta", "herramienta.inicio", "herramienta.fin", "mensaje.delta", "turno.fin"]);
  expect(p.peticiones[0]?.herramientas[0]?.esquema).toMatchObject({ type: "object", required: ["ruta"] });
});

test("herramienta desconocida y argumentos malos vuelven al modelo como error", async () => {
  const p = new ProveedorSimulado([
    () => ({ texto: "", llamadas: [{ id: "a", nombre: "borrar_todo", argumentos: {} }, { id: "b", nombre: "leer", argumentos: { ruta: 5 } }] }),
    () => ({ texto: "Vale.", llamadas: [] }),
  ]);
  const { mensajes } = await turno(p);
  const res = mensajes.filter((m) => m.rol === "herramienta");
  expect(res.every((m) => m.rol === "herramienta" && m.error)).toBe(true);
  expect(res[0]?.rol === "herramienta" && res[0].resultado).toContain("desconocida");
  expect(res[1]?.rol === "herramienta" && res[1].resultado).toContain("ruta");
});

const pideEco = (texto = "git status") =>
  new ProveedorSimulado([() => ({ texto: "", llamadas: [{ id: "e1", nombre: "eco", argumentos: { texto } }] }), () => ({ texto: "listo", llamadas: [] })]);

test("ejecutar pregunta; denegar no ejecuta y se lo dice al modelo", async () => {
  const eco = herramientaEco();
  const { aprobaciones, mensajes } = await turno(pideEco(), { herramientas: [eco], decision: "denegar" });
  expect(aprobaciones[0]).toMatchObject({ herramienta: "eco", nivel: "ejecucion", resumen: "eco git status", motivo: "ejecuta comandos" });
  expect(eco.usos).toBe(0);
  const res = mensajes.find((m) => m.rol === "herramienta");
  expect(res?.rol === "herramienta" && res.error && res.resultado).toContain("no ha permitido");
});

test("'siempre' guarda el permiso por clave y no vuelve a preguntar", async () => {
  const eco = herramientaEco();
  const { entorno } = await turno(pideEco(), { herramientas: [eco], decision: "siempre" });
  expect([...entorno.permitidos]).toEqual(["eco:git"]);
  const segunda = await turno(pideEco("git log"), { herramientas: [eco], entorno, decision: "denegar" });
  expect(segunda.aprobaciones.length).toBe(0);
  expect(eco.usos).toBe(2);
});

test("libre-proyecto no pregunta", async () => {
  const eco = herramientaEco();
  const entorno = { lecturas: new Map(), estado: new Map(), permitidos: new Set<string>(), modoAprobacion: "libre-proyecto" as const, steer: [] };
  const { aprobaciones } = await turno(pideEco(), { herramientas: [eco], entorno });
  expect(aprobaciones.length).toBe(0);
  expect(eco.usos).toBe(1);
});

test("steer entra antes de la siguiente llamada al modelo", async () => {
  const entorno = { lecturas: new Map(), estado: new Map(), permitidos: new Set<string>(), modoAprobacion: "preguntar-ejecutar" as const, steer: [] as string[] };
  const p = new ProveedorSimulado([
    () => {
      entorno.steer.push("mejor en inglés");
      return { texto: "", llamadas: [{ id: "h1", nombre: "leer", argumentos: { ruta: "nota.txt" } }] };
    },
    () => ({ texto: "ok", llamadas: [] }),
  ]);
  await turno(p, { entorno });
  const ultimo = p.peticiones[1]?.mensajes.at(-1);
  expect(ultimo).toEqual({ rol: "usuario", texto: "[Mensaje del usuario mientras trabajabas]\nmejor en inglés" });
});

test("reintenta errores pasajeros y luego cambia al proveedor de reserva", async () => {
  let llamadas = 0;
  const caido: Proveedor = {
    nombre: "caido",
    async responder() {
      llamadas += 1;
      throw new ErrorProveedor("sobrecarga", "529 overloaded");
    },
  };
  const reserva = new ProveedorSimulado([() => ({ texto: "desde la reserva", llamadas: [] })]);
  const { r, eventos } = await turno(caido, { proveedorReserva: reserva, reintentos: 2 });
  expect(llamadas).toBe(3);
  expect(r).toMatchObject({ motivo: "fin", texto: "desde la reserva" });
  expect(eventos.filter((e) => e.tipo === "turno.reintento").length).toBe(3);
});

test("contexto lleno: compacta y reintenta una vez", async () => {
  let n = 0;
  const p: Proveedor = {
    nombre: "pequeño",
    async responder(pet) {
      n += 1;
      if (pet.sesionId.endsWith(":resumen")) return { texto: "resumen de lo anterior", llamadas: [] };
      if (n === 1) throw new ErrorProveedor("contexto", "prompt is too long");
      return { texto: `vi ${pet.mensajes[0]?.rol}`, llamadas: [] };
    },
  };
  const largo = Array.from({ length: 20 }, (_, i) => ({ rol: "usuario" as const, texto: `mensaje ${i}` }));
  const { r, eventos, mensajes } = await turno(p, { mensajes: largo });
  expect(r.texto).toBe("vi resumen");
  expect(mensajes[0]).toEqual({ rol: "resumen", texto: "resumen de lo anterior" });
  expect(eventos.some((e) => e.tipo === "contexto.compactado" && e.metodo === "resumen")).toBe(true);
});

test("salida larga: se guarda aparte y el modelo recibe cabeza, aviso y cola", async () => {
  const eco = herramientaEco();
  const p = new ProveedorSimulado([
    () => ({ texto: "", llamadas: [{ id: "e1", nombre: "eco", argumentos: { texto: "x", repetir: 50_000 } }] }),
    () => ({ texto: "ok", llamadas: [] }),
  ]);
  const guardadas: string[] = [];
  const { mensajes } = await turno(p, {
    herramientas: [eco],
    guardarSalida: async (id, texto) => (guardadas.push(texto), `C:/salidas/${id}.txt`),
  });
  expect(guardadas[0]?.length).toBe(50_000);
  const res = mensajes.find((m) => m.rol === "herramienta");
  expect(res?.rol === "herramienta" && res.resultado.length).toBeLessThan(13_000);
  expect(res?.rol === "herramienta" && res.resultado).toContain("salida completa en C:/salidas/e1.txt");
});

test("límite de iteraciones y fallo del proveedor", async () => {
  const bucle = new ProveedorSimulado([() => ({ texto: "otra vez", llamadas: [{ id: "h", nombre: "leer", argumentos: { ruta: "nota.txt" } }] })]);
  expect((await turno(bucle, { maxIteraciones: 3 })).r.motivo).toBe("limite");
  const roto = new ProveedorSimulado([() => {
    throw new ErrorProveedor("autenticacion", "clave no válida");
  }]);
  expect((await turno(roto)).r).toMatchObject({ motivo: "error", error: "clave no válida" });
});
