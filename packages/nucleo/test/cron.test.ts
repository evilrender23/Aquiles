import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ajustes, EjecucionCron, Evento, IdCanal } from "@aquiles/protocolo";
import type { ResultadoTurno } from "../src/bucle";
import { ErrorCron } from "../src/cron-expresiones";
import { Programador } from "../src/cron";
import type { Motor, PeticionTurno } from "../src/motor";

/** Jueves 29 de octubre de 2026, 10:00 (hora local). */
const T = new Date(2026, 9, 29, 10, 0);
const local = (mes: number, dia: number, h = 0, m = 0) => new Date(2026, mes - 1, dia, h, m).toISOString();

/** Motor falso: apunta lo que se le pide y responde con `responder`. */
class MotorFalso implements Motor {
  turnos: PeticionTurno[] = [];
  eventos: Evento[] = [];
  notificaciones: { titulo: string; texto: string; sesionId?: string }[] = [];
  logs: string[] = [];
  responder: (p: PeticionTurno) => Promise<ResultadoTurno> = async (p) => ({ motivo: "fin", texto: `hecho: ${p.texto}`, uso: { entrada: 0, salida: 0 } });
  private n = 0;

  async turno(p: PeticionTurno) {
    this.turnos.push(p);
    const sesionId = p.sesionId ?? `s${++this.n}`;
    return { sesionId, resultado: await this.responder(p) };
  }
  existeSesion = () => true;
  trabajando = () => false;
  steer = () => false;
  parar = () => false;
  notificar(n: { titulo: string; texto: string; sesionId?: string }) {
    this.notificaciones.push(n);
  }
  emitir(e: Evento) {
    this.eventos.push(e);
  }
  /** Solo lo que leen el programador y la pasarela. */
  ajustes(): Ajustes {
    return { proveedor: "simulado", modoAprobacion: "preguntar-ejecutar", carpeta: "C:/trabajo" } as Ajustes;
  }
  log(m: string) {
    this.logs.push(m);
  }
}

/** Pasarela falsa: falla las `fallos` primeras entregas. */
function pasarelaFalsa(fallos = 0) {
  const entregas: { canal: IdCanal; destino?: string; texto: string }[] = [];
  return {
    entregas,
    async entregar(canal: IdCanal, destino: string | undefined, texto: string) {
      entregas.push({ canal, ...(destino ? { destino } : {}), texto });
      if (fallos-- > 0) throw new Error("sin red");
    },
  };
}

function preparar(o: { dir?: string | null; ahora?: () => Date; fallos?: number } = {}) {
  const motor = new MotorFalso();
  const pasarela = pasarelaFalsa(o.fallos);
  const reloj = { ahora: o.ahora ?? (() => T) };
  const p = new Programador({ dir: o.dir ?? null, motor, pasarela, cwdPorDefecto: "C:/defecto", reloj, esperasReintento: [5, 5] });
  return { motor, pasarela, p };
}

async function hasta<R>(f: () => R | undefined | false, ms = 3000): Promise<R> {
  const limite = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > limite) throw new Error("no llegó a tiempo");
    await Bun.sleep(5);
  }
}

const terminada = (p: Programador, id: string) => () => {
  const e = p.ejecuciones().find((x) => x.id === id);
  return e && e.estado !== "en-curso" ? e : undefined;
};

test("crear, editar y borrar, con datos en tareas.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "aquiles-cron-"));
  const { motor, p } = preparar({ dir });
  const t = p.crear({ nombre: " Resumen ", prompt: "Resume el correo", cuando: "cada lunes 9:00", entrega: [{ canal: "telegram" }] });
  expect(t).toMatchObject({
    nombre: "Resumen", cuando: "cada lunes 9:00", descripcion: "cada lunes a las 9:00", proxima: local(11, 2, 9), activa: true,
    cwd: "C:/trabajo", modoAprobacion: "preguntar-ejecutar", entrega: [{ canal: "telegram" }], creada: T.toISOString(),
  });
  expect(t.proveedor).toBeUndefined();
  expect(motor.eventos).toEqual([{ tipo: "cron.actualizado" }]);
  expect(JSON.parse(readFileSync(join(dir, "tareas.json"), "utf8"))[0].id).toBe(t.id);

  const diaria = p.editar({ id: t.id, cuando: "cada día 9:00", proveedor: "claude", modelo: "haiku" });
  expect(diaria).toMatchObject({ descripcion: "cada día a las 9:00", proxima: local(10, 30, 9), proveedor: "claude", modelo: "haiku" });
  expect(p.editar({ id: t.id, modelo: "" }).modelo).toBeUndefined();
  const pausada = p.editar({ id: t.id, activa: false });
  expect(pausada.activa).toBe(false);
  expect(pausada.proxima).toBeUndefined();
  expect(p.editar({ id: t.id, activa: true }).proxima).toBe(local(10, 30, 9));
  // Un «cuando» que no vale no cambia nada.
  expect(() => p.editar({ id: t.id, cuando: "cuando pueda" })).toThrow(ErrorCron);
  expect(p.listar()[0]!.cuando).toBe("cada día 9:00");

  // Otra instancia lee lo guardado.
  expect(preparar({ dir }).p.listar().map((x) => x.id)).toEqual([t.id]);
  p.borrar(t.id);
  expect(p.listar()).toEqual([]);
  expect(() => p.borrar(t.id)).toThrow(ErrorCron);
  expect(() => p.crear({ nombre: "x", prompt: "y", cuando: "hoy 9:00" })).toThrow("ya ha pasado");
  expect(motor.eventos.filter((e) => e.tipo === "cron.actualizado")).toHaveLength(6);
});

test("sin entrega elegida, se entrega en el escritorio", () => {
  const { p } = preparar();
  expect(p.crear({ nombre: "x", prompt: "y", cuando: "cada hora" }).entrega).toEqual([{ canal: "escritorio" }]);
});

test("ejecutar ahora: sesión nueva sin aprobar, entrega y eventos", async () => {
  const { motor, pasarela, p } = preparar();
  const t = p.crear({ nombre: "Resumen", prompt: "Resume", cuando: "cada día 9:00", entrega: [{ canal: "telegram" }, { canal: "correo", destino: "a@b.es" }] });
  const id = p.ejecutar(t.id);
  const e = await hasta(terminada(p, id));
  expect(motor.turnos).toHaveLength(1);
  const turno = motor.turnos[0]!;
  expect(turno.texto).toBe("Resume");
  expect(turno.aprobar).toBeUndefined();
  expect(turno.nueva).toEqual({
    cwd: "C:/trabajo", proveedor: undefined, modelo: undefined, modoAprobacion: "preguntar-ejecutar",
    titulo: "Programada · Resumen", origen: { tipo: "cron", tareaId: t.id },
  });
  expect(e).toMatchObject({
    tareaId: t.id, nombre: "Resumen", estado: "ok", sesionId: "s1", resumen: "hecho: Resume",
    entregas: [{ canal: "telegram", ok: true, intentos: 1 }, { canal: "correo", destino: "a@b.es", ok: true, intentos: 1 }],
  });
  expect(e.error).toBeUndefined();
  expect(pasarela.entregas).toEqual([
    { canal: "telegram", texto: "Resumen\n\nhecho: Resume" },
    { canal: "correo", destino: "a@b.es", texto: "Resumen\n\nhecho: Resume" },
  ]);
  const estados = motor.eventos.flatMap((x) => (x.tipo === "cron.ejecucion" ? [x.ejecucion.estado] : []));
  expect(estados).toEqual(["en-curso", "ok"]);
  // Ejecutar a mano no mueve la programación.
  expect(p.listar()[0]).toMatchObject({ proxima: local(10, 30, 9), ultima: { id, estado: "ok" } });
  expect(motor.notificaciones).toEqual([]);
});

test("si la ejecución anterior sigue en marcha, no se lanza otra", async () => {
  const { motor, p } = preparar();
  let soltar = () => {};
  motor.responder = () => new Promise((ok) => (soltar = () => ok({ motivo: "fin", texto: "listo", uso: { entrada: 0, salida: 0 } })));
  const t = p.crear({ nombre: "Lenta", prompt: "x", cuando: "cada 15m", entrega: [] });
  const primera = p.ejecutar(t.id);
  const segunda = p.ejecutar(t.id);
  expect(p.ejecuciones(t.id).find((e) => e.id === segunda)).toMatchObject({ estado: "error", error: expect.stringContaining("sigue en marcha") });
  expect(motor.turnos).toHaveLength(1);
  soltar();
  expect((await hasta(terminada(p, primera))).estado).toBe("ok");
  // Ya terminada, se puede volver a lanzar.
  p.ejecutar(t.id);
  expect(motor.turnos).toHaveLength(2);
  soltar();
});

test("al iniciar, una ejecución perdida se hace una vez y la siguiente se calcula desde ahora", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aquiles-cron-"));
  const t = preparar({ dir }).p.crear({ nombre: "Diaria", prompt: "x", cuando: "cada día 9:00", entrega: [] });
  expect(t.proxima).toBe(local(10, 30, 9));
  // Aquiles estuvo cerrado hasta el lunes 2 a mediodía: se perdieron cuatro.
  const { motor, p } = preparar({ dir, ahora: () => new Date(2026, 10, 2, 12) });
  p.iniciar();
  await hasta(() => p.ejecuciones().find((e) => e.estado === "ok"));
  p.detener();
  expect(motor.turnos).toHaveLength(1);
  expect(p.listar()[0]!.proxima).toBe(local(11, 3, 9));
  expect(motor.eventos).toContainEqual({ tipo: "cron.actualizado" });
  // Y queda guardado.
  expect(JSON.parse(readFileSync(join(dir, "tareas.json"), "utf8"))[0].proxima).toBe(local(11, 3, 9));
});

test("una tarea de una vez se desactiva al ejecutarse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aquiles-cron-"));
  const t = preparar({ dir }).p.crear({ nombre: "Recordatorio", prompt: "x", cuando: "en 30m", entrega: [] });
  expect(t.proxima).toBe(local(10, 29, 10, 30));
  const { motor, p } = preparar({ dir, ahora: () => new Date(2026, 9, 29, 12) });
  p.iniciar();
  await hasta(() => p.ejecuciones().find((e) => e.estado === "ok"));
  p.detener();
  expect(motor.turnos).toHaveLength(1);
  const despues = p.listar()[0]!;
  expect(despues.activa).toBe(false);
  expect(despues.proxima).toBeUndefined();
  // Reactivarla la vuelve a programar desde ahora.
  expect(p.editar({ id: t.id, activa: true }).proxima).toBe(local(10, 29, 12, 30));
});

test("el temporizador lanza la tarea a su hora", async () => {
  // Reloj que avanza con el real, colocado a 100 ms de la hora de la tarea.
  const objetivo = new Date(2026, 9, 29, 10, 30).getTime();
  const desfase = objetivo - 100 - Date.now();
  const { motor, p } = preparar({ ahora: () => new Date(Date.now() + desfase) });
  p.crear({ nombre: "Pronto", prompt: "x", cuando: "2026-10-29 10:30", entrega: [] });
  p.iniciar();
  expect(motor.turnos).toHaveLength(0);
  await hasta(() => motor.turnos.length === 1);
  p.detener();
  expect(p.listar()[0]).toMatchObject({ activa: false });
});

test("entrega con reintentos: al tercer intento llega", async () => {
  const { motor, pasarela, p } = preparar({ fallos: 2 });
  const t = p.crear({ nombre: "Resumen", prompt: "x", cuando: "cada hora", entrega: [{ canal: "telegram" }] });
  const e = await hasta(terminada(p, p.ejecutar(t.id)));
  expect(e).toMatchObject({ estado: "ok", entregas: [{ canal: "telegram", ok: true, intentos: 3 }] });
  expect(pasarela.entregas).toHaveLength(3);
  expect(motor.notificaciones).toEqual([]);
});

test("si una entrega falla las tres veces, queda en error y se notifica", async () => {
  const { motor, p } = preparar({ fallos: 99 });
  const t = p.crear({ nombre: "Resumen", prompt: "x", cuando: "cada hora", entrega: [{ canal: "telegram" }] });
  const e = await hasta(terminada(p, p.ejecutar(t.id)));
  expect(e).toMatchObject({
    estado: "error", resumen: "hecho: x", error: "No se pudo entregar en telegram: sin red",
    entregas: [{ canal: "telegram", ok: false, intentos: 3, error: "sin red" }],
  });
  expect(motor.notificaciones).toEqual([{ titulo: "Resumen", texto: "No se pudo entregar en telegram: sin red", sesionId: "s1" }]);
});

test("si falla la ejecución, se entrega el error y se notifica", async () => {
  const { motor, pasarela, p } = preparar();
  motor.responder = async () => ({ motivo: "error", texto: "", error: "cuota agotada", uso: { entrada: 0, salida: 0 } });
  const t = p.crear({ nombre: "Resumen", prompt: "x", cuando: "cada hora", entrega: [{ canal: "telegram" }] });
  const e = await hasta(terminada(p, p.ejecutar(t.id)));
  expect(e).toMatchObject({ estado: "error", error: "No se pudo completar: cuota agotada", entregas: [{ canal: "telegram", ok: true }] });
  expect(pasarela.entregas[0]!.texto).toBe("Resumen\n\nNo se pudo completar: cuota agotada");
  expect(motor.notificaciones).toEqual([{ titulo: "Resumen", texto: "No se pudo completar: cuota agotada", sesionId: "s1" }]);

  // Si el error ya llegó como notificación de escritorio, no se avisa otra vez.
  motor.responder = () => Promise.reject(new Error("la sesión no existe"));
  const escritorio = p.crear({ nombre: "Otra", prompt: "x", cuando: "cada hora", entrega: [{ canal: "escritorio" }] });
  const e2 = await hasta(terminada(p, p.ejecutar(escritorio.id)));
  expect(e2).toMatchObject({ estado: "error", error: "No se pudo completar: la sesión no existe" });
  expect(e2.sesionId).toBeUndefined();
  expect(motor.notificaciones).toHaveLength(1);
});

test("historial en ejecuciones.jsonl: gana la última línea y lo cortado queda en error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aquiles-cron-"));
  const { p } = preparar({ dir });
  const t = p.crear({ nombre: "A", prompt: "x", cuando: "cada hora", entrega: [] });
  const primera = p.ejecutar(t.id);
  await hasta(terminada(p, primera));
  const segunda = p.ejecutar(t.id);
  await hasta(terminada(p, segunda));
  const ruta = join(dir, "ejecuciones.jsonl");
  expect(readFileSync(ruta, "utf8").trim().split("\n")).toHaveLength(4);
  // Una ejecución que se quedó a medias porque el núcleo se cerró.
  const cortada: EjecucionCron = { id: "cortada", tareaId: t.id, nombre: "A", inicio: T.toISOString(), estado: "en-curso", entregas: [] };
  appendFileSync(ruta, `${JSON.stringify(cortada)}\n`);

  const otra = preparar({ dir }).p;
  const lista = otra.ejecuciones();
  expect(lista.map((e) => e.id)).toEqual(["cortada", segunda, primera]);
  expect(lista[0]).toMatchObject({ estado: "error", error: "Se cortó al cerrarse Aquiles." });
  expect(lista[1]!.estado).toBe("ok");
  expect(otra.ejecuciones(t.id, 1).map((e) => e.id)).toEqual(["cortada"]);
  expect(otra.listar()[0]!.ultima?.id).toBe("cortada");
  // Se reescribe con una línea por ejecución.
  expect(readFileSync(ruta, "utf8").trim().split("\n")).toHaveLength(3);
});
