import { expect, test } from "bun:test";
import { join } from "node:path";
import { errorCodex, leerCatalogo, ProveedorCodex, promptCodex } from "../src/proveedores/codex-cli";
import { ErrorProveedor, type Mensaje, type PeticionModelo } from "../src/tipos";
import { adjuntosDePrueba } from "./ficheros-prueba";

const proveedor = new ProveedorCodex({ comando: [process.execPath, join(import.meta.dir, "codex-falso.ts")], modelo: "gpt-prueba" });

const peticion = (mensajes: Mensaje[]): PeticionModelo => ({
  sesionId: "s1", sistema: "Eres Aquiles, de prueba.", mensajes, cwd: import.meta.dir, senal: new AbortController().signal,
  herramientas: [{ nombre: "leer", descripcion: "Lee un fichero", esquema: { type: "object" } }],
});

test("cada llamada lleva instrucciones, herramientas y la conversación entera; sin herramientas propias ni sesión guardada", async () => {
  const mensajes: Mensaje[] = [
    { rol: "usuario", texto: "hola" },
    { rol: "asistente", texto: "", llamadas: [{ id: "x1", nombre: "leer", argumentos: { ruta: "a" } }] },
    { rol: "herramienta", id: "x1", nombre: "leer", resultado: "contenido", error: false },
  ];
  const deltas: string[] = [];
  const r = await proveedor.responder(peticion(mensajes), (d) => deltas.push(d));
  const { args, prompt } = JSON.parse(Buffer.from(r.texto, "base64").toString());
  expect(args).toContain("--ephemeral");
  expect(args).toContain("--ignore-user-config");
  expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);
  expect(args).toContain("shell_tool");
  expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "gpt-prueba"]);
  expect(args.at(-1)).toBe("-");
  expect(prompt).toContain("Eres Aquiles, de prueba.");
  expect(prompt).toContain("- leer: Lee un fichero");
  expect(prompt).toContain('[Usuario]\nhola\n\n[Tú]\n<herramienta nombre="leer">{"ruta":"a"}</herramienta>');
  expect(prompt).toContain('<resultado herramienta="leer" id="x1">\ncontenido\n</resultado>');
  expect(deltas.join("")).toBe(r.texto);
  expect(r.uso).toEqual({ entrada: 1200, salida: 30, razonamiento: 4 });
});

test("adjuntos: las imágenes van con -i (antes de las demás opciones) y en el prompt, el <adjunto> con su ruta", async () => {
  const { foto, nota } = await adjuntosDePrueba();
  // Otra instancia: la de arriba numera las llamadas y los demás tests cuentan con ello.
  const codex = new ProveedorCodex({ comando: [process.execPath, join(import.meta.dir, "codex-falso.ts")] });
  const mensajes: Mensaje[] = [{ rol: "usuario", texto: "¿Qué ves?", adjuntos: [foto, nota] }];
  const r = await codex.responder(peticion(mensajes), () => {});
  const { args, prompt } = JSON.parse(Buffer.from(r.texto, "base64").toString());
  expect(args.slice(args.indexOf("exec"), args.indexOf("exec") + 4)).toEqual(["exec", "-i", foto.ruta, "--json"]);
  expect(prompt).toContain(
    `[Usuario]\n¿Qué ves?\n\n<adjunto nombre="foto.png" tipo="image/png" ruta="${foto.ruta}">\nImagen adjunta a este mensaje.\n</adjunto>\n\n` +
      `<adjunto nombre="nota.txt" tipo="text/plain" ruta="${nota.ruta}">\ncontenido de la nota\n</adjunto>`,
  );
  // Como mucho 5 imágenes, las más recientes.
  const muchas: Mensaje[] = [{ rol: "usuario", texto: "todas", adjuntos: Array.from({ length: 7 }, (_, i) => ({ ...foto, id: `f${i}` })) }];
  const otra = JSON.parse(Buffer.from((await codex.responder(peticion(muchas), () => {})).texto, "base64").toString());
  expect(otra.args.filter((a: string) => a === "-i")).toHaveLength(5);
  expect(otra.prompt).toContain("Imagen que no cabe en esta petición");
});

test("esfuerzo: va como model_reasoning_effort, y el catálogo trae niveles y nivel por defecto", async () => {
  const conEsfuerzo = new ProveedorCodex({ comando: [process.execPath, join(import.meta.dir, "codex-falso.ts")], modelo: "gpt-prueba", esfuerzo: "high" });
  const r = await conEsfuerzo.responder(peticion([{ rol: "usuario", texto: "hola" }]), () => {});
  const { args } = JSON.parse(Buffer.from(r.texto, "base64").toString());
  expect(args.slice(args.indexOf('model_reasoning_effort="high"') - 1, args.indexOf('model_reasoning_effort="high"') + 1)).toEqual(["-c", 'model_reasoning_effort="high"']);
  const json = JSON.stringify({
    models: [{ slug: "a", visibility: "list", priority: 1, context_window: 1, default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] }],
  });
  expect(leerCatalogo(json)).toEqual([{ slug: "a", nombre: "a", ventana: 1, niveles: ["low", "ultra"], porDefecto: "low" }]);
});

test("razonamiento: se pide el resumen y llega aparte del texto", async () => {
  const pensado: string[] = [];
  const r = await proveedor.responder({ ...peticion([{ rol: "usuario", texto: "razona esto" }]), alPensamiento: (t) => pensado.push(t) }, () => {});
  expect(pensado).toEqual(["**Calculando 366 menos 52**\n\n"]);
  const { args } = JSON.parse(Buffer.from(r.texto, "base64").toString());
  expect(args).toContain('model_reasoning_summary="detailed"');
});

test("llamadas en texto: se ocultan al vuelo y se descarta el resultado inventado", async () => {
  const deltas: string[] = [];
  const r = await proveedor.responder(peticion([{ rol: "usuario", texto: "usa una herramienta" }]), (d) => deltas.push(d));
  expect(deltas.join("")).toBe("Voy a leerlo.\n");
  expect(r.texto).toBe("Voy a leerlo.");
  expect(r.llamadas).toEqual([{ id: expect.stringMatching(/^codex\d+-1$/), nombre: "leer", argumentos: { ruta: "a.txt" } }]);
});

test("errores: turn.failed y salida sin eventos", async () => {
  const cuota = await proveedor.responder(peticion([{ rol: "usuario", texto: "agotado" }]), () => {}).catch((e) => e);
  expect(cuota).toBeInstanceOf(ErrorProveedor);
  expect(cuota.tipo).toBe("cuota");
  const roto = await proveedor.responder(peticion([{ rol: "usuario", texto: "roto" }]), () => {}).catch((e) => e);
  expect(roto.message).toContain("fallo de arranque");
  expect(errorCodex("401 Unauthorized").tipo).toBe("autenticacion");
  expect(errorCodex("context window exceeded").tipo).toBe("contexto");
});

test("catálogo de modelos: solo los visibles, por prioridad y con su ventana", () => {
  const json = JSON.stringify({
    models: [
      { slug: "b", display_name: "B", visibility: "list", priority: 2, context_window: 272000 },
      { slug: "oculto", visibility: "hide", priority: 0, context_window: 1 },
      { slug: "a", display_name: "A", visibility: "list", priority: 1, context_window: 500000 },
    ],
  });
  expect(leerCatalogo(json)).toEqual([
    { slug: "a", nombre: "A", ventana: 500000 },
    { slug: "b", nombre: "B", ventana: 272000 },
  ]);
  expect(leerCatalogo("no es json")).toEqual([]);
  expect(promptCodex({ sistema: "S", herramientas: [], mensajes: [] })).toContain("<instrucciones_de_aquiles>\nS");
});
