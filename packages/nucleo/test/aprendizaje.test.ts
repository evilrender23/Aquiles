import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AjustesAprendizaje, Evento } from "@aquiles/protocolo";
import { AJUSTES_APRENDIZAJE, Aprendizaje, RegistroAprendizaje, revisar, transcripcionRevision } from "../src/aprendizaje";
import { leer } from "../src/herramientas/leer";
import { Memoria } from "../src/memoria";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { AlmacenSesiones } from "../src/sesiones";
import { AlmacenSkills } from "../src/skills";
import type { Mensaje, PeticionModelo, RespuestaModelo } from "../src/tipos";

const SKILL = "---\nname: notas-con-fecha\ndescription: Cómo crear notas del usuario.\n---\n\n1. Ponlas en notas/AAAA-MM-DD-tema.md.\n";

/** Revisor simulado: en la primera llamada guarda una preferencia y crea una skill; después termina. */
function revisor(): ProveedorSimulado {
  return new ProveedorSimulado([
    (): RespuestaModelo => ({
      texto: "",
      llamadas: [
        { id: "m1", nombre: "memoria", argumentos: { accion: "añadir", destino: "usuario", texto: "Quiere las notas en notas/ con la fecha delante." } },
        { id: "s1", nombre: "gestionar_skill", argumentos: { accion: "crear", nombre: "notas-con-fecha", contenido: SKILL } },
      ],
    }),
    (p: PeticionModelo): RespuestaModelo => {
      const errores = p.mensajes.filter((m) => m.rol === "herramienta" && m.error);
      return { texto: errores.length ? `fallos: ${JSON.stringify(errores)}` : "Guardé la preferencia de notas y una skill.", llamadas: [] };
    },
  ]);
}

const conversacion: Mensaje[] = [
  { rol: "usuario", texto: "Crea una nota sobre la reunión" },
  { rol: "asistente", texto: "", llamadas: [{ id: "e1", nombre: "escribir", argumentos: { ruta: "reunion.md" } }] },
  { rol: "herramienta", id: "e1", nombre: "escribir", resultado: "ok", error: false },
  { rol: "usuario", texto: "No: las notas siempre van en notas/ con la fecha delante del nombre." },
];

function perfilTemporal(): string {
  return mkdtempSync(join(tmpdir(), "aquiles-aprendizaje-"));
}

test("la revisión trabaja sobre una copia y devuelve propuestas sin tocar el perfil", async () => {
  const perfil = perfilTemporal();
  const cwd = mkdtempSync(join(tmpdir(), "aquiles-cwd-"));
  const r = await revisar({
    perfil, incluidas: null, cwd, mensajes: conversacion, origen: { tipo: "revision", sesionId: "s1" },
    proveedor: revisor(), lectura: [leer], senal: new AbortController().signal,
  });
  expect(r.error).toBeUndefined();
  expect(r.texto).toBe("Guardé la preferencia de notas y una skill.");
  expect(r.propuestas).toHaveLength(2);
  expect(r.propuestas[0]).toMatchObject({ tipo: "memoria", destino: "usuario", anadidas: ["Quiere las notas en notas/ con la fecha delante."], quitadas: [] });
  expect(r.propuestas[1]).toMatchObject({ tipo: "skill", nombre: "notas-con-fecha", nueva: true, ficheros: [{ ruta: "SKILL.md", despues: SKILL }] });
  // El perfil real no cambia y la copia se borra.
  expect(new Memoria(perfil).leer("usuario").entradas).toEqual([]);
  expect(existsSync(join(perfil, "skills", "notas-con-fecha"))).toBe(false);
  expect(readdirSync(join(perfil, "aprendizaje", "revisiones"))).toEqual([]);
});

test("Aprendizaje: umbrales, cola de propuestas, aceptar y registro con origen", async () => {
  const perfil = perfilTemporal();
  const cwd = mkdtempSync(join(tmpdir(), "aquiles-cwd-"));
  const memoria = new Memoria(perfil);
  const skills = new AlmacenSkills({ perfil });
  const registro = new RegistroAprendizaje(join(perfil, "aprendizaje"));
  const eventos: Evento[] = [];
  let ajustes: AjustesAprendizaje = { ...AJUSTES_APRENDIZAJE, cadaMensajes: 2 };
  const a = new Aprendizaje({
    perfil, incluidas: null, memoria, skills, registro, ajustes: () => ajustes,
    proveedorDe: () => revisor(), lectura: [leer], emitir: (e) => eventos.push(e),
  });
  const s = new AlmacenSesiones(null).crear(cwd, { proveedor: "simulado" });
  s.mensajes.push(...conversacion);

  a.alMensajeUsuario(s);
  a.alTerminarTurno(s);
  expect(a.revisando(s.id)).toBe(false);
  a.alMensajeUsuario(s);
  a.alTerminarTurno(s);
  expect(a.revisando(s.id)).toBe(true);
  for (let i = 0; i < 200 && a.revisando(s.id); i++) await Bun.sleep(10);
  expect(eventos).toContainEqual({ tipo: "aprendizaje.revision", sesionId: s.id, estado: "fin", propuestas: 2, aplicadas: 0 });

  const pendientes = registro.propuestas();
  const mem = pendientes.find((p) => p.tipo === "memoria");
  const skill = pendientes.find((p) => p.tipo === "skill");
  expect(mem?.tipo).toBe("memoria");
  expect(skill?.tipo).toBe("skill");
  expect(mem?.origen).toEqual({ tipo: "revision", sesionId: s.id, titulo: "Crea una nota sobre la reunión" });

  expect(a.decidir(mem!.id, "aceptar").estado).toBe("aceptada");
  expect(memoria.leer("usuario").entradas).toEqual(["Quiere las notas en notas/ con la fecha delante."]);
  expect(a.decidir(skill!.id, "descartar").estado).toBe("descartada");
  expect(skills.leer("notas-con-fecha")).toBeUndefined();
  expect(registro.propuestas()).toEqual([]);
  expect(registro.historial()).toMatchObject([{ tipo: "memoria", propuestaId: mem!.id, origen: { tipo: "revision", sesionId: s.id } }]);

  // Sin nada nuevo no revisa; con aplicarSinPreguntar aplica al momento.
  expect(await a.revisar(s)).toEqual({ estado: "omitida", motivo: "no hay nada nuevo que revisar" });
  ajustes = { ...ajustes, aplicarSinPreguntar: true };
  s.mensajes.push({ rol: "usuario", texto: "otra corrección" });
  const r = await a.revisar(s);
  expect(r).toMatchObject({ estado: "hecha", aplicadas: 1, propuestas: 0 });
  expect(skills.leer("notas-con-fecha")?.origen).toBe("aprendida");
});

test("aceptar una propuesta que ya no cabe la deja pendiente con el error", () => {
  const perfil = perfilTemporal();
  const memoria = new Memoria(perfil);
  memoria.guardar("usuario", ["x".repeat(1390)]);
  const registro = new RegistroAprendizaje(join(perfil, "aprendizaje"));
  const a = new Aprendizaje({
    perfil, incluidas: null, memoria, skills: new AlmacenSkills({ perfil }), registro, ajustes: () => AJUSTES_APRENDIZAJE,
    proveedorDe: () => revisor(), lectura: [], emitir: () => {},
  });
  const p = registro.nuevaPropuesta({ origen: { tipo: "revision" }, tipo: "memoria", resumen: "x", destino: "usuario", anadidas: ["una entrada más larga que el hueco"], quitadas: [] });
  const r = a.decidir(p.id, "aceptar");
  expect(r.estado).toBe("pendiente");
  expect(r.error).toContain("límite");
});

test("aceptar un cambio de skill comprueba que no cambió desde la propuesta", () => {
  const perfil = perfilTemporal();
  mkdirSync(join(perfil, "skills", "notas-con-fecha"), { recursive: true });
  writeFileSync(join(perfil, "skills", "notas-con-fecha", "SKILL.md"), SKILL);
  const skills = new AlmacenSkills({ perfil });
  const registro = new RegistroAprendizaje(null);
  const a = new Aprendizaje({
    perfil, incluidas: null, memoria: new Memoria(perfil), skills, registro, ajustes: () => AJUSTES_APRENDIZAJE,
    proveedorDe: () => revisor(), lectura: [], emitir: () => {},
  });
  const nuevo = SKILL.replace("1. Ponlas", "1. Siempre ponlas");
  const vieja = registro.nuevaPropuesta({
    origen: { tipo: "revision" }, tipo: "skill", resumen: "x", nombre: "notas-con-fecha", nueva: false,
    ficheros: [{ ruta: "SKILL.md", antes: "otro contenido", despues: nuevo }],
  });
  expect(a.decidir(vieja.id, "aceptar").error).toContain("ha cambiado");
  const buena = registro.nuevaPropuesta({
    origen: { tipo: "revision" }, tipo: "skill", resumen: "x", nombre: "notas-con-fecha", nueva: false,
    ficheros: [{ ruta: "SKILL.md", antes: SKILL, despues: nuevo }],
  });
  expect(a.decidir(buena.id, "aceptar").estado).toBe("aceptada");
  expect(skills.leer("notas-con-fecha")?.contenido).toBe(nuevo);
  expect(skills.versiones("notas-con-fecha")).toHaveLength(1);
});

test("transcripción para el revisor: recorta resultados y conserva el final", () => {
  const t = transcripcionRevision([
    { rol: "usuario", texto: "hola" },
    { rol: "herramienta", id: "1", nombre: "leer", resultado: "a".repeat(2000), error: false },
  ]);
  expect(t).toContain("[Usuario]\nhola");
  expect(t).toContain("(recortado)");
  expect(t.length).toBeLessThan(1000);
});
