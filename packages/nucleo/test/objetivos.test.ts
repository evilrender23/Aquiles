import { expect, test } from "bun:test";
import type { Evento } from "@aquiles/protocolo";
import type { Motor, PeticionTurno } from "../src/motor";
import { interpretarVeredicto, Objetivos } from "../src/objetivos";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import type { Mensaje, PeticionModelo, Proveedor } from "../src/tipos";

const conversacion: Mensaje[] = [
  { rol: "usuario", texto: "Haz que pasen los tests de la API" },
  { rol: "asistente", texto: "", llamadas: [{ id: "t1", nombre: "terminal", argumentos: { comando: "bun test" } }] },
  { rol: "herramienta", id: "t1", nombre: "terminal", resultado: "3 pass, 1 fail", error: false },
  { rol: "asistente", texto: "Queda un test fallando.", llamadas: [] },
];
const sesion = { id: "s1", cwd: "C:\\api", mensajes: conversacion };

/** Juez simulado que responde, en orden, lo que se le pase (el último se repite). */
function juez(...respuestas: string[]): ProveedorSimulado {
  return new ProveedorSimulado(respuestas.map((texto) => () => ({ texto, llamadas: [] })));
}

function montar(proveedor: Proveedor, o: { trabajando?: boolean; alTurno?: (p: PeticionTurno) => void } = {}) {
  const eventos: Evento[] = [];
  const turnos: PeticionTurno[] = [];
  const motor = {
    async turno(p: PeticionTurno) {
      turnos.push(p);
      o.alTurno?.(p);
      return { sesionId: p.sesionId!, resultado: { motivo: "fin" as const, texto: "", uso: { entrada: 0, salida: 0 } } };
    },
    trabajando: () => o.trabajando ?? false,
  } as unknown as Motor;
  const objetivos = new Objetivos({ motor, proveedorJuez: () => proveedor, emitir: (e) => eventos.push(e) });
  return { objetivos, eventos, turnos };
}

test("fijar, consultar, quitar, exportar y cargar", () => {
  const { objetivos } = montar(juez("{}"));
  expect(objetivos.fijar({ id: "s1" }, "  Que pasen los tests  ")).toEqual({ texto: "Que pasen los tests", estado: "activo", intentos: 0, maxIntentos: 5 });
  objetivos.fijar({ id: "s2" }, "Otro", 2);
  expect(objetivos.de("s2")).toMatchObject({ maxIntentos: 2 });
  expect(objetivos.fijar({ id: "s2" }, "   ")).toBeUndefined();
  expect(objetivos.de("s2")).toBeUndefined();
  objetivos.fijar({ id: "s3" }, "Tercero");
  expect(objetivos.fijar({ id: "s3" }, null)).toBeUndefined();

  const guardado = objetivos.exportar();
  expect(guardado).toEqual({ s1: { texto: "Que pasen los tests", estado: "activo", intentos: 0, maxIntentos: 5 } });
  const otro = montar(juez("{}")).objetivos;
  otro.cargar({ ...guardado, s4: { texto: "Hecho", estado: "cumplido", intentos: 2, maxIntentos: 3, motivo: "ok" }, roto: { estado: "x" }, nulo: null });
  expect(otro.exportar()).toEqual({ ...guardado, s4: { texto: "Hecho", estado: "cumplido", intentos: 2, maxIntentos: 3, motivo: "ok" } });
});

test("cumplido: el juez ve el objetivo y el final de la conversación, sin herramientas", async () => {
  const proveedor = juez('Veredicto: {"cumplido": true, "motivo": "Los 4 tests pasan"}');
  const { objetivos, eventos, turnos } = montar(proveedor);
  objetivos.fijar(sesion, "Que pasen todos los tests");
  await objetivos.alTerminarTurno(sesion, { motivo: "fin", texto: "Todo verde." });
  expect(objetivos.de("s1")).toEqual({ texto: "Que pasen todos los tests", estado: "cumplido", intentos: 0, maxIntentos: 5, motivo: "Los 4 tests pasan" });
  expect(eventos).toEqual([{ tipo: "objetivo.evaluado", sesionId: "s1", objetivo: objetivos.de("s1")! }]);
  expect(turnos).toEqual([]);

  const p = proveedor.peticiones[0] as PeticionModelo;
  expect(p.herramientas).toEqual([]);
  expect(p.sistema).toContain("juez");
  expect(p.maxTokensSalida).toBeGreaterThan(0);
  const texto = p.mensajes[0]?.rol === "usuario" ? p.mensajes[0].texto : "";
  expect(texto).toContain("Que pasen todos los tests");
  expect(texto).toContain("3 pass, 1 fail");
  expect(texto).toContain("Todo verde.");

  // Ya cumplido: los turnos siguientes no se juzgan.
  await objetivos.alTerminarTurno(sesion, { motivo: "fin", texto: "" });
  expect(proveedor.peticiones).toHaveLength(1);
});

test("no cumplido: cuenta el intento y relanza el turno con lo que falta", async () => {
  const { objetivos, eventos, turnos } = montar(juez('{"cumplido": false, "motivo": "Falla el test de login."}'));
  objetivos.fijar(sesion, "Que pasen todos los tests");
  await objetivos.alTerminarTurno(sesion, { motivo: "fin", texto: "Queda un test fallando." });
  expect(objetivos.de("s1")).toMatchObject({ estado: "activo", intentos: 1, motivo: "Falla el test de login." });
  expect(eventos).toHaveLength(1);
  expect(turnos).toEqual([
    { sesionId: "s1", texto: "El objetivo aún no se cumple: Falla el test de login. Sigue trabajando hasta cumplirlo: Que pasen todos los tests" },
  ]);
});

test("el bucle sigue solo hasta agotar los intentos", async () => {
  let pendiente: Promise<void> | undefined;
  const ref: { o?: Objetivos } = {};
  // Hace de servidor: cada turno relanzado acaba y vuelve a avisar a los objetivos.
  const m = montar(juez('{"cumplido": false, "motivo": "aún no"}'), {
    alTurno: (p) => {
      pendiente = ref.o!.alTerminarTurno({ ...sesion, id: p.sesionId! }, { motivo: "fin", texto: "sigo" });
    },
  });
  ref.o = m.objetivos;
  m.objetivos.fijar(sesion, "Algo difícil", 3);
  await m.objetivos.alTerminarTurno(sesion, { motivo: "fin", texto: "primer intento" });
  for (let i = 0; i < 10 && pendiente; i++) {
    const p = pendiente;
    pendiente = undefined;
    await p;
  }
  expect(m.objetivos.de("s1")).toMatchObject({ estado: "agotado", intentos: 3 });
  expect(m.turnos).toHaveLength(2);
  expect(m.eventos.map((e) => (e.tipo === "objetivo.evaluado" ? e.objetivo.estado : ""))).toEqual(["activo", "activo", "agotado"]);
});

test("parado o error no se juzgan; sin objetivo no hace nada", async () => {
  const proveedor = juez('{"cumplido": true, "motivo": "ok"}');
  const { objetivos, eventos } = montar(proveedor);
  await objetivos.alTerminarTurno(sesion, { motivo: "fin", texto: "" });
  objetivos.fijar(sesion, "X");
  await objetivos.alTerminarTurno(sesion, { motivo: "parado", texto: "" });
  await objetivos.alTerminarTurno(sesion, { motivo: "error", texto: "" });
  expect(proveedor.peticiones).toHaveLength(0);
  expect(eventos).toHaveLength(0);
  // limite sí: el agente se quedó sin pasos a medias y el juez decide si seguir.
  await objetivos.alTerminarTurno(sesion, { motivo: "limite", texto: "" });
  expect(objetivos.de("s1")?.estado).toBe("cumplido");
});

test("si el juez falla, el objetivo sigue activo con el error y no se relanza", async () => {
  const roto: Proveedor = {
    nombre: "roto",
    async responder() {
      throw new Error("sin cuota");
    },
  };
  const a = montar(roto);
  a.objetivos.fijar(sesion, "X");
  await a.objetivos.alTerminarTurno(sesion, { motivo: "fin", texto: "" });
  expect(a.objetivos.de("s1")).toMatchObject({ estado: "activo", intentos: 0, motivo: "El juez falló: sin cuota" });
  expect(a.eventos).toHaveLength(1);
  expect(a.turnos).toHaveLength(0);

  const b = montar(juez("No sé qué decir"));
  b.objetivos.fijar(sesion, "X");
  await b.objetivos.alTerminarTurno(sesion, { motivo: "fin", texto: "" });
  expect(b.objetivos.de("s1")?.motivo).toStartWith("El juez falló: respuesta del juez no válida");
  expect(b.turnos).toHaveLength(0);
});

test("un veredicto que llega tarde no pisa un objetivo nuevo ni relanza si la sesión ya trabaja", async () => {
  const lento = new ProveedorSimulado([() => ({ texto: '{"cumplido": false, "motivo": "falta"}', llamadas: [] })], 5);
  const a = montar(lento);
  a.objetivos.fijar(sesion, "Viejo");
  const evaluando = a.objetivos.alTerminarTurno(sesion, { motivo: "fin", texto: "" });
  a.objetivos.fijar(sesion, "Nuevo");
  await evaluando;
  expect(a.objetivos.de("s1")).toEqual({ texto: "Nuevo", estado: "activo", intentos: 0, maxIntentos: 5 });
  expect(a.eventos).toHaveLength(0);
  expect(a.turnos).toHaveLength(0);

  const b = montar(juez('{"cumplido": false, "motivo": "falta"}'), { trabajando: true });
  b.objetivos.fijar(sesion, "X");
  await b.objetivos.alTerminarTurno(sesion, { motivo: "fin", texto: "" });
  expect(b.objetivos.de("s1")?.intentos).toBe(1);
  expect(b.turnos).toHaveLength(0);
});

test("interpretarVeredicto", () => {
  expect(interpretarVeredicto('```json\n{"cumplido":false,"motivo":"  falta el README  "}\n```')).toEqual({ cumplido: false, motivo: "falta el README" });
  expect(interpretarVeredicto('{"cumplido":true}')).toEqual({ cumplido: true, motivo: "Cumplido" });
  expect(() => interpretarVeredicto('{"cumplido":"sí"}')).toThrow("sin «cumplido»");
  expect(() => interpretarVeredicto("nada")).toThrow("no válida");
});
