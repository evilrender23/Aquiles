import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { errorClaude, ProveedorClaude, transcripcion } from "../src/proveedores/claude-cli";
import { ErrorAbortado, ErrorProveedor, type Mensaje, type PeticionModelo } from "../src/tipos";

const proveedor = new ProveedorClaude({ comando: [process.execPath, join(import.meta.dir, "claude-falso.ts")] });
afterEach(() => proveedor.cerrar());

const peticion = (mensajes: Mensaje[], senal = new AbortController().signal): PeticionModelo => ({
  sesionId: "s1", sistema: "Eres Aquiles, de prueba.", mensajes, cwd: import.meta.dir, senal,
  herramientas: [{ nombre: "leer", descripcion: "Lee un fichero", esquema: { type: "object" } }],
});

test("eco: system prompt en fichero, sin herramientas propias, uso sumado con la caché", async () => {
  const deltas: string[] = [];
  const r = await proveedor.responder(peticion([{ rol: "usuario", texto: "hola" }]), (d) => deltas.push(d));
  const eco = JSON.parse(r.texto);
  expect(eco).toMatchObject({ recibidos: 1, texto: "hola", sistema: "Eres Aquiles, de prueba.", sinHerramientas: true });
  expect(deltas.join("")).toBe(r.texto);
  expect(r.uso).toEqual({ entrada: 115, salida: 7, razonamiento: 2 });
});

test("llamadas en texto: oculta el bloque al vuelo y descarta resultados inventados", async () => {
  const deltas: string[] = [];
  const mensajes: Mensaje[] = [{ rol: "usuario", texto: "usa una herramienta" }];
  const r = await proveedor.responder(peticion(mensajes), (d) => deltas.push(d));
  expect(deltas.join("")).toBe("Voy a leerlo.\n");
  expect(r.texto).toBe("Voy a leerlo.");
  expect(r.llamadas).toEqual([{ id: "claude1-1", nombre: "leer", argumentos: { ruta: "a.txt" } }]);

  // Siguiente llamada del mismo turno: solo viaja el resultado, no la respuesta del asistente.
  mensajes.push({ rol: "asistente", texto: r.texto, llamadas: r.llamadas }, { rol: "herramienta", id: "claude1-1", nombre: "leer", resultado: "abc", error: false });
  const eco = JSON.parse((await proveedor.responder(peticion(mensajes), () => {})).texto);
  expect(eco.recibidos).toBe(2);
  expect(eco.texto).toBe('<resultado herramienta="leer" id="claude1-1">\nabc\n</resultado>');
});

test("un proceso nuevo con historial recibe la conversación entera", async () => {
  const mensajes: Mensaje[] = [
    { rol: "usuario", texto: "primera" },
    { rol: "asistente", texto: "respuesta", llamadas: [] },
    { rol: "usuario", texto: "segunda" },
  ];
  const eco = JSON.parse((await proveedor.responder(peticion(mensajes), () => {})).texto);
  expect(eco.recibidos).toBe(1);
  expect(eco.texto).toContain("[Usuario]\nprimera\n\n[Tú]\nrespuesta\n\n[Usuario]\nsegunda");
});

test("error del CLI: cuota con espera hasta que se libera; el proceso se descarta", async () => {
  const e = await proveedor.responder(peticion([{ rol: "usuario", texto: "agotado" }]), () => {}).catch((x) => x);
  expect(e).toBeInstanceOf(ErrorProveedor);
  expect(e.tipo).toBe("cuota");
  expect(e.detalles.reintentarEnMs).toBeGreaterThan(20_000);
  // Proceso nuevo: vuelve a enviar lo que había.
  const eco = JSON.parse((await proveedor.responder(peticion([{ rol: "usuario", texto: "agotado" }, { rol: "usuario", texto: "otra" }]), () => {})).texto);
  expect(eco.recibidos).toBe(1);
});

test("parar interrumpe el turno sin perder el proceso", async () => {
  const control = new AbortController();
  const mensajes: Mensaje[] = [{ rol: "usuario", texto: "algo lento" }];
  const enCurso = proveedor.responder(peticion(mensajes, control.signal), () => control.abort());
  await expect(enCurso).rejects.toBeInstanceOf(ErrorAbortado);
  mensajes.push({ rol: "usuario", texto: "sigue" });
  const eco = JSON.parse((await proveedor.responder(peticion(mensajes), () => {})).texto);
  expect(eco).toMatchObject({ recibidos: 2, texto: "sigue" });
});

test("clasifica los errores del CLI", () => {
  expect(errorClaude("There's an issue with the selected model (x). It may not exist").tipo).toBe("peticion");
  expect(errorClaude("Invalid API key · Please run /login").tipo).toBe("autenticacion");
  expect(errorClaude("API Error: 529 Overloaded").tipo).toBe("sobrecarga");
  expect(errorClaude("Prompt is too long").tipo).toBe("contexto");
  expect(errorClaude("algo raro").tipo).toBe("otro");
});

test("transcripción con llamadas y resultados", () => {
  const t = transcripcion([
    { rol: "usuario", texto: "lee a" },
    { rol: "asistente", texto: "", llamadas: [{ id: "1", nombre: "leer", argumentos: { ruta: "a" } }] },
    { rol: "herramienta", id: "1", nombre: "leer", resultado: "x", error: false },
  ]);
  expect(t).toContain('[Tú]\n<herramienta nombre="leer">{"ruta":"a"}</herramienta>');
  expect(t).toContain('<resultado herramienta="leer" id="1">\nx\n</resultado>');
});
