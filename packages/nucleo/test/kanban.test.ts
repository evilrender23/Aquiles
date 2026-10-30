import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evento } from "@aquiles/protocolo";
import type { ResultadoTurno } from "../src/bucle";
import { ErrorKanban, Kanban } from "../src/kanban";
import type { Motor, PeticionTurno } from "../src/motor";

/** Motor falso: cada turno queda pendiente hasta que el test lo termina; `empezar` simula el primer evento. */
function motorFalso() {
  const eventos: Evento[] = [];
  const parados: string[] = [];
  const turnos: {
    p: PeticionTurno;
    sesionId: string;
    empezar: () => void;
    terminar: (r?: Partial<ResultadoTurno>) => void;
    fallar: (e: Error) => void;
  }[] = [];
  let n = 0;
  const motor: Motor = {
    turno(p) {
      const sesionId = `s${++n}`;
      return new Promise((ok, mal) => {
        turnos.push({
          p,
          sesionId,
          empezar: () => p.alEvento?.({ tipo: "mensaje.delta", sesionId, texto: "…" }),
          terminar: (r) => ok({ sesionId, resultado: { motivo: "fin", texto: "hecho", uso: { entrada: 1, salida: 1 }, ...r } }),
          fallar: mal,
        });
      });
    },
    existeSesion: () => true,
    trabajando: () => false,
    steer: () => false,
    parar: (id) => (parados.push(id), true),
    notificar() {},
    emitir: (e) => eventos.push(e),
    ajustes: () => {
      throw new Error("no se usa");
    },
    log() {},
  };
  return { motor, eventos, parados, turnos };
}

const esperar = () => Bun.sleep(1);
const dir = () => mkdtempSync(join(tmpdir(), "aquiles-kanban-"));

test("crea, ordena por columna y orden, edita y guarda en kanban.json", () => {
  const d = dir();
  const { motor, eventos } = motorFalso();
  const k = new Kanban({ dir: d, motor, cwdPorDefecto: "C:\\proyecto" });
  const a = k.crear({ titulo: "  Primera  " });
  const b = k.crear({ titulo: "Segunda", descripcion: "detalles", cwd: "C:\\otra" });
  const c = k.crear({ titulo: "Ya hecha", columna: "hecha" });
  expect(a).toMatchObject({ titulo: "Primera", descripcion: "", columna: "pendiente", orden: 0, cwd: "C:\\proyecto" });
  expect(b).toMatchObject({ orden: 1, cwd: "C:\\otra" });
  expect(c).toMatchObject({ columna: "hecha", orden: 0 });
  expect(eventos.filter((e) => e.tipo === "kanban.actualizado")).toHaveLength(3);

  // Cambiar de columna sin orden la pone al final; con orden, donde se diga.
  expect(k.editar({ id: a.id, columna: "hecha" })).toMatchObject({ columna: "hecha", orden: 1 });
  k.editar({ id: b.id, columna: "hecha", orden: -1, titulo: "Segunda (editada)" });
  expect(k.listar().map((t) => t.titulo)).toEqual(["Segunda (editada)", "Ya hecha", "Primera"]);
  expect(() => k.editar({ id: a.id, titulo: "   " })).toThrow(ErrorKanban);
  expect(() => k.editar({ id: "no-existe" })).toThrow(ErrorKanban);

  // Lo que devuelve es una copia: tocarla no cambia el tablero.
  k.listar()[0]!.titulo = "trampa";
  const otra = new Kanban({ dir: d, motor, cwdPorDefecto: "C:\\proyecto" });
  expect(otra.listar().map((t) => t.titulo)).toEqual(["Segunda (editada)", "Ya hecha", "Primera"]);

  otra.borrar(c.id);
  expect(otra.listar()).toHaveLength(2);
  expect(JSON.parse(readFileSync(join(d, "kanban.json"), "utf8"))).toHaveLength(2);
});

test("ejecutar: sesión nueva con origen kanban, en curso y a revisión al terminar", async () => {
  const { motor, eventos, turnos } = motorFalso();
  const k = new Kanban({ dir: null, motor, cwdPorDefecto: "C:\\proyecto" });
  const t = k.crear({ titulo: "Arreglar el login", descripcion: "Falla con tildes en el usuario." });
  const enCurso = k.ejecutar(t.id);
  expect(enCurso).toMatchObject({ columna: "en-curso", agente: "trabajando" });
  expect(enCurso.sesionId).toBeUndefined();

  const [turno] = turnos;
  expect(turno!.p.nueva).toEqual({ cwd: "C:\\proyecto", titulo: "Kanban · Arreglar el login", origen: { tipo: "kanban", tarjetaId: t.id } } as any);
  expect(turno!.p.texto).toContain("Arreglar el login");
  expect(turno!.p.texto).toContain("Falla con tildes en el usuario.");
  expect(turno!.p.texto).toContain("resume");
  expect(turno!.p.aprobar).toBeUndefined();
  expect(() => k.ejecutar(t.id)).toThrow("ya tiene un agente");

  // El primer evento del turno dice qué sesión es.
  turno!.empezar();
  expect(k.listar()[0]).toMatchObject({ sesionId: "s1", agente: "trabajando" });

  const antes = eventos.length;
  turno!.terminar();
  await esperar();
  expect(k.listar()[0]).toMatchObject({ columna: "revision", agente: "terminado", sesionId: "s1" });
  expect(eventos.length).toBeGreaterThan(antes);
  expect(eventos.at(-1)).toEqual({ tipo: "kanban.actualizado" });

  // Se puede volver a encargar: otra sesión.
  k.ejecutar(t.id);
  turnos[1]!.terminar();
  await esperar();
  expect(k.listar()[0]).toMatchObject({ columna: "revision", agente: "terminado", sesionId: "s2" });
});

test("varias tarjetas a la vez: cada una con su agente y su final", async () => {
  const { motor, turnos } = motorFalso();
  const k = new Kanban({ dir: null, motor, cwdPorDefecto: "C:\\p" });
  const [a, b, c, d] = ["A", "B", "C", "D"].map((titulo) => k.crear({ titulo }));
  for (const t of [a, b, c, d]) k.ejecutar(t!.id);
  expect(turnos).toHaveLength(4);
  expect(k.listar().every((t) => t.agente === "trabajando")).toBe(true);

  turnos[1]!.terminar({ motivo: "error", error: "sin cuota" });
  turnos[2]!.terminar({ motivo: "parado" });
  turnos[3]!.fallar(new Error("La sesión ya está trabajando"));
  turnos[0]!.terminar({ motivo: "limite" });
  await esperar();
  const porTitulo = Object.fromEntries(k.listar().map((t) => [t.titulo, t]));
  expect(porTitulo.B).toMatchObject({ columna: "en-curso", agente: "error", error: "sin cuota", sesionId: "s2" });
  expect(porTitulo.C!.agente).toBeUndefined();
  expect(porTitulo.C!.columna).toBe("en-curso");
  expect(porTitulo.D).toMatchObject({ agente: "error", error: "La sesión ya está trabajando" });
  expect(porTitulo.A).toMatchObject({ columna: "en-curso", agente: "error", error: "Llegó al límite de pasos sin terminar" });
});

test("borrar una tarjeta que trabaja para a su agente, también antes de conocer la sesión", async () => {
  const { motor, parados, turnos } = motorFalso();
  const k = new Kanban({ dir: null, motor, cwdPorDefecto: "C:\\p" });
  const a = k.crear({ titulo: "A" });
  const b = k.crear({ titulo: "B" });
  k.ejecutar(a.id);
  k.ejecutar(b.id);
  turnos[0]!.empezar();
  k.borrar(a.id);
  expect(parados).toEqual(["s1"]);

  k.borrar(b.id);
  expect(parados).toEqual(["s1"]);
  turnos[1]!.empezar();
  expect(parados).toEqual(["s1", "s2"]);

  turnos[0]!.terminar({ motivo: "parado" });
  turnos[1]!.terminar({ motivo: "parado" });
  await esperar();
  expect(k.listar()).toEqual([]);
});

test("al arrancar, una tarjeta que se quedó trabajando pasa a error; un fichero roto se aparta", () => {
  const d = dir();
  const { motor } = motorFalso();
  writeFileSync(
    join(d, "kanban.json"),
    JSON.stringify([
      { id: "t1", titulo: "Cortada", columna: "en-curso", orden: 0, cwd: "C:\\p", agente: "trabajando", sesionId: "s9", creada: "x", actualizada: "x" },
      { id: "t2", titulo: "Antigua" },
      { titulo: "sin id" },
    ]),
  );
  const k = new Kanban({ dir: d, motor, cwdPorDefecto: "C:\\p" });
  expect(k.listar()).toMatchObject([
    { id: "t2", titulo: "Antigua", columna: "pendiente", descripcion: "", cwd: "C:\\p" },
    { id: "t1", agente: "error", error: "El núcleo se cerró mientras el agente trabajaba", sesionId: "s9" },
  ]);

  const roto = dir();
  writeFileSync(join(roto, "kanban.json"), "{ no es json");
  expect(new Kanban({ dir: roto, motor, cwdPorDefecto: "C:\\p" }).listar()).toEqual([]);
  expect(existsSync(join(roto, "kanban.json"))).toBe(false);
  expect(readdirSync(roto).some((f) => f.startsWith("kanban.json.corrupto-"))).toBe(true);
});
