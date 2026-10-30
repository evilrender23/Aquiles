import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ventanaDe } from "../src/proveedores/anthropic";
import { errorClaude, ProveedorClaude, transcripcion } from "../src/proveedores/claude-cli";
import { ErrorAbortado, ErrorProveedor, type Mensaje, type PeticionModelo } from "../src/tipos";
import { adjuntosDePrueba } from "./ficheros-prueba";

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
  // La ventana de contexto la dice el CLI en el result.
  expect(proveedor.ventanaContexto).toBe(1_000_000);
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

test("adjuntos: con imágenes, content son bloques image (base64) y text; cada imagen viaja una vez", async () => {
  const { foto, nota } = await adjuntosDePrueba();
  const mensajes: Mensaje[] = [{ rol: "usuario", texto: "¿Qué ves?", adjuntos: [foto, nota] }];
  const eco = JSON.parse((await proveedor.responder(peticion(mensajes), () => {})).texto);
  expect(eco.imagenes).toEqual([{ type: "base64", media_type: "image/png", data: readFileSync(foto.ruta).toString("base64").length }]);
  expect(eco.texto).toBe(
    `¿Qué ves?\n\n<adjunto nombre="foto.png" tipo="image/png" ruta="${foto.ruta}">\nImagen adjunta a este mensaje.\n</adjunto>\n\n` +
      `<adjunto nombre="nota.txt" tipo="text/plain" ruta="${nota.ruta}">\ncontenido de la nota\n</adjunto>`,
  );
  // El CLI guarda la conversación: el siguiente mensaje va sin la imagen.
  mensajes.push({ rol: "asistente", texto: "Rojo.", llamadas: [] }, { rol: "usuario", texto: "gracias" });
  const siguiente = JSON.parse((await proveedor.responder(peticion(mensajes), () => {})).texto);
  expect(siguiente).toMatchObject({ recibidos: 2, texto: "gracias" });
  expect(siguiente.imagenes).toBeUndefined();
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

test("ventana de contexto por modelo de la API de Anthropic", () => {
  expect(ventanaDe("claude-sonnet-5-5")).toBe(1_000_000);
  expect(ventanaDe("claude-fable-5-1")).toBe(1_000_000);
  expect(ventanaDe("claude-3-5-sonnet-20241022")).toBe(200_000);
});
