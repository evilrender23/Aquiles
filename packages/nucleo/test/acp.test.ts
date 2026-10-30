import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Diff, Evento } from "@aquiles/protocolo";
import { servirAcp, textoDelPrompt } from "../src/acp";
import type { RespuestaAprobacion, ResultadoTurno } from "../src/bucle";
import type { Motor, PeticionTurno } from "../src/motor";

const CWD = "C:\\proyecto";
const DIFF: Diff = {
  ruta: "a.txt", nuevo: false, anadidas: 1, quitadas: 1,
  bloques: [{ lineaAntes: 1, lineaDespues: 1, lineas: [{ tipo: " ", texto: "cero" }, { tipo: "-", texto: "uno" }, { tipo: "+", texto: "dos" }] }],
};

/** Motor falso: lo que hace cada turno depende del texto del prompt. */
function motorFalso() {
  const peticiones: PeticionTurno[] = [];
  const parados: string[] = [];
  const aprobaciones: RespuestaAprobacion[] = [];
  const paradas = new Map<string, () => void>();
  let n = 0;
  const motor = {
    async turno(p: PeticionTurno): Promise<{ sesionId: string; resultado: ResultadoTurno }> {
      peticiones.push(p);
      const sesionId = p.sesionId ?? `s${++n}`;
      const emitir = (e: Evento) => p.alEvento?.(e);
      const r = (motivo: ResultadoTurno["motivo"], error?: string) => ({
        sesionId, resultado: { motivo, texto: "", uso: { entrada: 0, salida: 0 }, ...(error ? { error } : {}) },
      });
      const parada = () => new Promise<void>((ok) => paradas.set(sesionId, ok));
      await Bun.sleep(1);
      switch (p.texto) {
        case "hola":
          emitir({ tipo: "mensaje.delta", sesionId, texto: "Hola, " });
          emitir({ tipo: "tareas", sesionId, tareas: [{ texto: "Leer", estado: "hecha" }, { texto: "Escribir", estado: "en-curso" }, { texto: "Probar", estado: "pendiente" }] });
          emitir({ tipo: "mensaje.delta", sesionId, texto: "qué tal" });
          return r("fin");
        case "edita": {
          emitir({ tipo: "herramienta.inicio", sesionId, id: "h1", nombre: "escribir", argumentos: { ruta: "a.txt", contenido: "dos" }, resumen: "a.txt" });
          const d = await p.aprobar!({ id: "h1", herramienta: "escribir", nivel: "escritura", resumen: "a.txt", argumentos: { ruta: "a.txt" }, motivo: "modifica ficheros" });
          aprobaciones.push(d);
          if (d === "denegar") emitir({ tipo: "herramienta.fin", sesionId, id: "h1", nombre: "escribir", resultado: "No permitido", error: true });
          else emitir({ tipo: "herramienta.fin", sesionId, id: "h1", nombre: "escribir", resultado: "Escrito", error: false, diffs: [DIFF] });
          return r("fin");
        }
        case "lento":
          emitir({ tipo: "mensaje.delta", sesionId, texto: "Empiezo…" });
          await parada();
          return r("parado");
        case "mudo": {
          // Tarda en dar el primer evento: la cancelación llega antes de saber qué sesión es.
          const esperando = parada();
          await Bun.sleep(30);
          emitir({ tipo: "mensaje.delta", sesionId, texto: "por fin" });
          await esperando;
          return r("parado");
        }
        case "falla":
          return r("error", "Sin cuota en el proveedor");
        case "largo":
          return r("limite");
        default:
          throw new Error(`no sé hacer «${p.texto}»`);
      }
    },
    parar(id: string) {
      parados.push(id);
      paradas.get(id)?.();
      return true;
    },
    log() {},
  } as unknown as Motor;
  return { motor, peticiones, parados, aprobaciones };
}

/** Cliente ACP falso con streams en memoria. `permiso` decide la respuesta a cada petición de permiso (undefined = no contesta). */
function cliente(motor: Motor, permiso: (params: any) => unknown = () => ({ outcome: { outcome: "selected", optionId: "permitir" } })) {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  const entrada = new ReadableStream<Uint8Array>({ start: (c) => void (control = c) });
  const recibidos: any[] = [];
  const permisos: any[] = [];
  const esperando = new Map<number, (m: any) => void>();
  const codificador = new TextEncoder();
  const escribirBruto = (texto: string) => control.enqueue(codificador.encode(texto));
  const escribir = (m: unknown) => escribirBruto(`${JSON.stringify(m)}\n`);
  const servido = servirAcp({
    motor, entrada, version: "9.9.9", cwdPorDefecto: CWD,
    salida: (linea) => {
      expect(linea).not.toContain("\n");
      const m = JSON.parse(linea);
      recibidos.push(m);
      if (m.method === "session/request_permission") {
        permisos.push(m.params);
        const r = permiso(m.params);
        if (r !== undefined) escribir({ jsonrpc: "2.0", id: m.id, result: r });
      } else if (m.method === undefined && esperando.has(m.id)) {
        esperando.get(m.id)!(m);
        esperando.delete(m.id);
      }
    },
  });
  let n = 0;
  const llamar = (method: string, params?: unknown): Promise<any> =>
    new Promise((ok) => {
      const id = ++n;
      esperando.set(id, ok);
      escribir({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  const actualizaciones = (sessionId: string) => recibidos.filter((m) => m.method === "session/update" && m.params.sessionId === sessionId).map((m) => m.params.update);
  const sesion = async (cwd?: string): Promise<string> => (await llamar("session/new", { ...(cwd ? { cwd } : {}), mcpServers: [] })).result.sessionId;
  return { llamar, escribir, escribirBruto, recibidos, permisos, actualizaciones, sesion, servido, cerrar: () => control.close() };
}

test("initialize y errores JSON-RPC", async () => {
  const c = cliente(motorFalso().motor);
  const ini = await c.llamar("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } } });
  expect(ini.result).toEqual({
    protocolVersion: 1,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false } },
    agentInfo: { name: "aquiles", title: "Aquiles", version: "9.9.9" },
    authMethods: [],
  });
  expect((await c.llamar("session/load", { sessionId: "x" })).error.code).toBe(-32601);
  expect((await c.llamar("initialize", {})).error.code).toBe(-32602);
  expect((await c.llamar("session/prompt", { sessionId: "no-existe", prompt: [{ type: "text", text: "hola" }] })).error).toMatchObject({ code: -32602 });
  const s = await c.sesion();
  expect((await c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "image", data: "", mimeType: "image/png" }] })).error.message).toBe("El prompt no tiene texto");

  c.escribirBruto("{ esto no es json\n");
  c.escribirBruto('{"jsonrpc":"1.0","id":7,"method":"x"}\n');
  // Las notificaciones desconocidas se ignoran sin responder.
  c.escribir({ jsonrpc: "2.0", method: "algo/raro", params: {} });
  await Bun.sleep(5);
  const errores = c.recibidos.filter((m) => m.id === null).map((m) => m.error.code);
  expect(errores).toEqual([-32700, -32600]);
  c.cerrar();
  await c.servido;
});

test("prompt: crea la sesión de Aquiles en el primero y traduce texto y plan", async () => {
  const m = motorFalso();
  const c = cliente(m.motor);
  await c.llamar("initialize", { protocolVersion: 1 });
  const s = await c.sesion("C:\\otro");
  expect(s).toStartWith("aquiles-");
  const r = await c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "hola" }] });
  expect(r.result).toEqual({ stopReason: "end_turn" });
  expect(m.peticiones[0]).toMatchObject({ nueva: { cwd: "C:\\otro", titulo: "Editor" }, texto: "hola" });
  expect(m.peticiones[0]!.nueva).not.toHaveProperty("origen");
  expect(c.actualizaciones(s)).toEqual([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hola, " } },
    {
      sessionUpdate: "plan",
      entries: [
        { content: "Leer", priority: "medium", status: "completed" },
        { content: "Escribir", priority: "medium", status: "in_progress" },
        { content: "Probar", priority: "medium", status: "pending" },
      ],
    },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "qué tal" } },
  ]);
  // Las notificaciones del turno llegan antes que la respuesta al prompt.
  const iRespuesta = c.recibidos.findIndex((x) => x.result?.stopReason);
  expect(c.recibidos.slice(iRespuesta + 1).some((x) => x.method === "session/update")).toBe(false);

  // El segundo prompt sigue en la misma sesión de Aquiles.
  await c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "hola" }] });
  expect(m.peticiones[1]).toMatchObject({ sesionId: "s1", texto: "hola" });
  expect(m.peticiones[1]!.nueva).toBeUndefined();
  // Sin cwd, la carpeta por defecto.
  const s2 = await c.sesion();
  await c.llamar("session/prompt", { sessionId: s2, prompt: [{ type: "text", text: "hola" }] });
  expect(m.peticiones[2]!.nueva?.cwd).toBe(CWD);
  c.cerrar();
  await c.servido;
});

test("herramientas y permisos: tool_call, petición al editor y diff", async () => {
  let respuesta: unknown = { outcome: { outcome: "selected", optionId: "siempre" } };
  const m = motorFalso();
  const c = cliente(m.motor, () => respuesta);
  const s = await c.sesion();
  expect((await c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "edita" }] })).result).toEqual({ stopReason: "end_turn" });
  expect(m.aprobaciones).toEqual(["siempre"]);
  expect(c.permisos[0]).toEqual({
    sessionId: s,
    toolCall: {
      toolCallId: "h1", title: "escribir: a.txt", kind: "edit", status: "pending", rawInput: { ruta: "a.txt" },
      content: [{ type: "content", content: { type: "text", text: "Pide permiso: modifica ficheros" } }],
    },
    options: [
      { optionId: "permitir", name: "Permitir una vez", kind: "allow_once" },
      { optionId: "siempre", name: "Permitir siempre", kind: "allow_always" },
      { optionId: "denegar", name: "Rechazar", kind: "reject_once" },
    ],
  });
  expect(c.actualizaciones(s)).toEqual([
    {
      sessionUpdate: "tool_call", toolCallId: "h1", title: "escribir: a.txt", kind: "edit", status: "in_progress",
      rawInput: { ruta: "a.txt", contenido: "dos" }, locations: [{ path: join(CWD, "a.txt") }],
    },
    {
      sessionUpdate: "tool_call_update", toolCallId: "h1", status: "completed",
      content: [
        { type: "diff", path: join(CWD, "a.txt"), oldText: "cero\nuno", newText: "cero\ndos" },
        { type: "content", content: { type: "text", text: "Escrito" } },
      ],
    },
  ]);

  for (const [r, esperado] of [
    [{ outcome: { outcome: "selected", optionId: "permitir" } }, "permitir"],
    [{ outcome: { outcome: "selected", optionId: "denegar" } }, "denegar"],
    [{ outcome: { outcome: "cancelled" } }, "denegar"],
    [{ outcome: { outcome: "selected", optionId: "otra" } }, "denegar"],
  ] as const) {
    respuesta = r;
    await c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "edita" }] });
    expect(m.aprobaciones.at(-1)).toBe(esperado);
  }
  expect(c.actualizaciones(s).at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
  c.cerrar();
  await c.servido;
});

test("session/cancel para el turno y responde cancelled, también esperando un permiso o antes de saber la sesión", async () => {
  const m = motorFalso();
  // Este editor no contesta a los permisos: solo la cancelación libera el turno.
  const c = cliente(m.motor, () => undefined);
  const s = await c.sesion();
  const lento = c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "lento" }] });
  await Bun.sleep(10);
  expect((await c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "hola" }] })).error.code).toBe(-32600);
  c.escribir({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: s } });
  expect((await lento).result).toEqual({ stopReason: "cancelled" });
  expect(m.parados).toEqual(["s1"]);

  const edita = c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "edita" }] });
  await Bun.sleep(10);
  expect(c.permisos).toHaveLength(1);
  c.escribir({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: s } });
  expect((await edita).result).toEqual({ stopReason: "cancelled" });
  expect(m.aprobaciones).toEqual(["denegar"]);

  const s2 = await c.sesion();
  const mudo = c.llamar("session/prompt", { sessionId: s2, prompt: [{ type: "text", text: "mudo" }] });
  await Bun.sleep(5);
  c.escribir({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: s2 } });
  expect((await mudo).result).toEqual({ stopReason: "cancelled" });
  expect(m.parados).toEqual(["s1", "s1", "s2"]);
  c.cerrar();
  await c.servido;
});

test("fin por error, por límite o porque el motor rechaza el turno", async () => {
  const c = cliente(motorFalso().motor);
  const s = await c.sesion();
  expect((await c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "falla" }] })).error).toEqual({ code: -32603, message: "Sin cuota en el proveedor" });
  expect((await c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "largo" }] })).result).toEqual({ stopReason: "max_turn_requests" });
  expect((await c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "otra cosa" }] })).error).toEqual({ code: -32603, message: "no sé hacer «otra cosa»" });
  c.cerrar();
  await c.servido;
});

test("al cerrarse la entrada para los turnos en marcha y termina", async () => {
  const m = motorFalso();
  const c = cliente(m.motor);
  const s = await c.sesion();
  void c.llamar("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "lento" }] });
  await Bun.sleep(10);
  c.cerrar();
  await c.servido;
  expect(m.parados).toEqual(["s1"]);
  expect(c.recibidos.at(-1)).toMatchObject({ result: { stopReason: "cancelled" } });
});

test("textoDelPrompt: texto y menciones en su sitio, contenido incrustado al final", () => {
  const ruta = join(CWD, "src", "a.ts");
  const uri = pathToFileURL(ruta).href;
  expect(
    textoDelPrompt([
      { type: "text", text: "Mira " },
      { type: "resource_link", uri, text: undefined },
      { type: "text", text: " y compáralo con " },
      { type: "resource", resource: { uri: "zed://nota", text: "contenido de la nota" } },
      { type: "image" },
    ]),
  ).toBe(`Mira ${ruta} y compáralo con zed://nota\n\nContenido de zed://nota:\n\`\`\`\ncontenido de la nota\n\`\`\``);
});
