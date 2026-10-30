import { describe, expect, test } from "bun:test";
import { ProveedorAnthropic, traducirMensajesAnthropic } from "../src/proveedores/anthropic";
import { ErrorAbortado, ErrorProveedor, type Mensaje, type PeticionModelo } from "../src/tipos";

type Evento = Record<string, unknown> & { type: string };

/** fetch falso: responde en orden y guarda el cuerpo de cada petición. */
function fetchFalso(respuestas: Array<(senal: AbortSignal) => Response | Promise<Response>>) {
  const cuerpos: Record<string, unknown>[] = [];
  let i = 0;
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    cuerpos.push(JSON.parse(String(init?.body)));
    const r = respuestas[Math.min(i++, respuestas.length - 1)];
    if (!r) throw new Error("sin respuesta");
    return r(init?.signal ?? new AbortController().signal);
  };
  return { fetch, cuerpos };
}

/** SSE de Anthropic; con `colgar`, deja el flujo abierto tras los eventos hasta que se aborte. */
function sse(eventos: Evento[], colgar = false) {
  return (senal: AbortSignal): Response => {
    const codificador = new TextEncoder();
    const cuerpo = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ev of eventos) c.enqueue(codificador.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        if (!colgar) c.close();
        senal.addEventListener("abort", () => c.error(new DOMException("abortado", "AbortError")), { once: true });
      },
    });
    return new Response(cuerpo, { headers: { "content-type": "text/event-stream" } });
  };
}

function errorHttp(estado: number, tipo: string, mensaje: string, cabeceras: Record<string, string> = {}) {
  return (): Response =>
    new Response(JSON.stringify({ type: "error", error: { type: tipo, message: mensaje } }), {
      status: estado,
      headers: { "content-type": "application/json", ...cabeceras },
    });
}

const inicio = (uso: Record<string, number> = {}): Evento => ({
  type: "message_start",
  message: {
    id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [],
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...uso },
  },
});
const fin = (motivo: string, salida: number): Evento[] => [
  { type: "message_delta", delta: { stop_reason: motivo, stop_sequence: null }, usage: { output_tokens: salida } },
  { type: "message_stop" },
];
const texto = (indice: number, ...trozos: string[]): Evento[] => [
  { type: "content_block_start", index: indice, content_block: { type: "text", text: "" } },
  ...trozos.map((t) => ({ type: "content_block_delta", index: indice, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index: indice },
];
const herramienta = (indice: number, id: string, nombre: string, ...trozos: string[]): Evento[] => [
  { type: "content_block_start", index: indice, content_block: { type: "tool_use", id, name: nombre, input: {} } },
  ...trozos.map((t) => ({ type: "content_block_delta", index: indice, delta: { type: "input_json_delta", partial_json: t } })),
  { type: "content_block_stop", index: indice },
];
const razonamiento = (indice: number, firma: string): Evento[] => [
  { type: "content_block_start", index: indice, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: indice, delta: { type: "signature_delta", signature: firma } },
  { type: "content_block_stop", index: indice },
];

function peticion(mensajes: Mensaje[], senal = new AbortController().signal): PeticionModelo {
  return {
    sesionId: "s1",
    sistema: "Eres Aquiles.",
    mensajes,
    herramientas: [
      { nombre: "leer", descripcion: "Lee un fichero", esquema: { type: "object", properties: { ruta: { type: "string" } } } },
      { nombre: "escribir", descripcion: "Escribe un fichero", esquema: { type: "object", properties: {} } },
    ],
    cwd: ".",
    senal,
  };
}

function proveedor(f: ReturnType<typeof fetchFalso>) {
  return new ProveedorAnthropic({ clave: "prueba", baseURL: "http://anthropic.test", fetch: f.fetch });
}

describe("ProveedorAnthropic: respuestas", () => {
  test("emite el texto en streaming y suma la caché al uso de entrada", async () => {
    const f = fetchFalso([
      sse([inicio({ input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 }), ...texto(0, "Hola", " mundo"), ...fin("end_turn", 7)]),
    ]);
    const deltas: string[] = [];
    const r = await proveedor(f).responder(peticion([{ rol: "usuario", texto: "hola" }]), (d) => deltas.push(d));
    expect(deltas).toEqual(["Hola", " mundo"]);
    expect(r).toEqual({ texto: "Hola mundo", llamadas: [], uso: { entrada: 115, salida: 7 } });
  });

  test("reconstruye llamadas con argumentos troceados y guarda el razonamiento firmado", async () => {
    const f = fetchFalso([
      sse([
        inicio(),
        ...razonamiento(0, "firma-1"),
        ...texto(1, "Voy a leer."),
        ...herramienta(2, "toolu_1", "leer", '{"ru', 'ta":"a', '.txt"}'),
        ...herramienta(3, "toolu_2", "escribir"),
        ...fin("tool_use", 30),
      ]),
    ]);
    const r = await proveedor(f).responder(peticion([{ rol: "usuario", texto: "lee a.txt" }]), () => {});
    expect(r.texto).toBe("Voy a leer.");
    expect(r.llamadas).toEqual([
      { id: "toolu_1", nombre: "leer", argumentos: { ruta: "a.txt" } },
      { id: "toolu_2", nombre: "escribir", argumentos: {} },
    ]);
    expect(r.cortada).toBeUndefined();
    expect(r.opaco?.proveedor).toBe("anthropic");
    const datos = r.opaco?.datos as { bloques: Array<{ type: string }> };
    expect(datos.bloques.map((b) => b.type)).toEqual(["thinking", "text", "tool_use", "tool_use"]);
  });

  test("max_tokens marca la respuesta como cortada y el JSON incompleto no revienta", async () => {
    const f = fetchFalso([sse([inicio(), ...herramienta(0, "toolu_1", "leer", '{"ruta":"a'), ...fin("max_tokens", 50)])]);
    const r = await proveedor(f).responder(peticion([{ rol: "usuario", texto: "x" }]), () => {});
    expect(r.cortada).toBe(true);
    expect(r.llamadas[0]?.argumentos).toEqual({ __json_invalido: '{"ruta":"a' });
  });

  test("separa bloques de texto consecutivos también en los deltas", async () => {
    const f = fetchFalso([sse([inicio(), ...texto(0, "Uno."), ...razonamiento(1, "f"), ...texto(2, "Dos."), ...fin("end_turn", 3)])]);
    const deltas: string[] = [];
    const r = await proveedor(f).responder(peticion([{ rol: "usuario", texto: "x" }]), (d) => deltas.push(d));
    expect(r.texto).toBe("Uno.\n\nDos.");
    expect(deltas.join("")).toBe(r.texto);
  });
});

describe("ProveedorAnthropic: traducción", () => {
  test("sistema, herramientas y final de la conversación llevan cache_control", async () => {
    const f = fetchFalso([sse([inicio(), ...texto(0, "ok"), ...fin("end_turn", 1)])]);
    await proveedor(f).responder({ ...peticion([{ rol: "usuario", texto: "hola" }]), maxTokensSalida: 1234 }, () => {});
    const cuerpo = f.cuerpos[0] as Record<string, any>;
    expect(cuerpo.model).toBe("claude-sonnet-5-5");
    expect(cuerpo.max_tokens).toBe(1234);
    expect(cuerpo.stream).toBe(true);
    expect(cuerpo.thinking).toBeUndefined();
    expect(cuerpo.system).toEqual([{ type: "text", text: "Eres Aquiles.", cache_control: { type: "ephemeral" } }]);
    expect(cuerpo.tools.map((t: any) => t.cache_control)).toEqual([undefined, { type: "ephemeral" }]);
    expect(cuerpo.tools[0]).toMatchObject({ name: "leer", description: "Lee un fichero", input_schema: { type: "object" } });
    expect(cuerpo.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hola", cache_control: { type: "ephemeral" } }] }]);
  });

  test("agrupa resultados consecutivos en un mensaje user y le fusiona el texto que sigue", () => {
    const mensajes: Mensaje[] = [
      { rol: "resumen", texto: "Antes leímos b.txt." },
      { rol: "usuario", texto: "Ahora lee a y c" },
      {
        rol: "asistente",
        texto: "Leo los dos.",
        llamadas: [
          { id: "t1", nombre: "leer", argumentos: { ruta: "a" } },
          { id: "agy1.2", nombre: "leer", argumentos: { ruta: "c" } },
        ],
      },
      { rol: "herramienta", id: "t1", nombre: "leer", resultado: "contenido a", error: false },
      { rol: "herramienta", id: "agy1.2", nombre: "leer", resultado: "no existe", error: true },
      { rol: "usuario", texto: "[Mensaje del usuario mientras trabajabas]\ndate prisa" },
    ];
    expect(traducirMensajesAnthropic(mensajes)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "[Resumen de la conversación anterior]\nAntes leímos b.txt." },
          { type: "text", text: "Ahora lee a y c" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Leo los dos." },
          { type: "tool_use", id: "t1", name: "leer", input: { ruta: "a" } },
          { type: "tool_use", id: "agy1_2", name: "leer", input: { ruta: "c" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "contenido a" },
          { type: "tool_result", tool_use_id: "agy1_2", content: "no existe", is_error: true },
          { type: "text", text: "[Mensaje del usuario mientras trabajabas]\ndate prisa", cache_control: { type: "ephemeral" } },
        ],
      },
    ]);
  });

  test("reinyecta el razonamiento firmado en su orden y lo descarta si el historial anterior cambia", async () => {
    const respuestaConRazonamiento = sse([
      inicio(),
      ...razonamiento(0, "firma-1"),
      ...texto(1, "Leo."),
      ...herramienta(2, "toolu_1", "leer", '{"ruta":"a"}'),
      ...fin("tool_use", 10),
    ]);
    const f = fetchFalso([respuestaConRazonamiento, sse([inicio(), ...texto(0, "Hecho."), ...fin("end_turn", 2)])]);
    const p = proveedor(f);
    const mensajes: Mensaje[] = [{ rol: "usuario", texto: "lee a" }];
    const r = await p.responder(peticion(mensajes), () => {});
    mensajes.push(
      { rol: "asistente", texto: r.texto, llamadas: r.llamadas, ...(r.opaco ? { opaco: r.opaco } : {}) },
      { rol: "herramienta", id: "toolu_1", nombre: "leer", resultado: "a", error: false },
    );

    await p.responder(peticion(mensajes), () => {});
    const asistente = (f.cuerpos[1] as any).messages[1];
    expect(asistente.role).toBe("assistant");
    expect(asistente.content.map((b: any) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(asistente.content[0]).toEqual({ type: "thinking", thinking: "", signature: "firma-1" });

    // Tras compactar, lo anterior a ese turno ya no es lo mismo: se manda sin razonamiento.
    const compactados: Mensaje[] = [{ rol: "resumen", texto: "El usuario pidió leer a." }, ...mensajes.slice(1)];
    await p.responder(peticion(compactados), () => {});
    expect((f.cuerpos[2] as any).messages[1].content.map((b: any) => b.type)).toEqual(["text", "tool_use"]);
  });

  test("si el mensaje del asistente se modificó, ignora los bloques guardados", () => {
    const traducidos = traducirMensajesAnthropic([
      { rol: "usuario", texto: "hola" },
      {
        rol: "asistente",
        texto: "otro texto",
        llamadas: [],
        opaco: { proveedor: "anthropic", datos: { prefijo: "x", bloques: [{ type: "thinking", thinking: "", signature: "f" }, { type: "text", text: "texto" }] } },
      },
      { rol: "usuario", texto: "sigue" },
    ]);
    expect(traducidos[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "otro texto" }] });
  });
});

describe("ProveedorAnthropic: errores", () => {
  const fallo = async (respuesta: () => Response | Promise<Response>): Promise<ErrorProveedor> => {
    const f = fetchFalso([respuesta]);
    const e = await proveedor(f).responder(peticion([{ rol: "usuario", texto: "x" }]), () => {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorProveedor);
    return e as ErrorProveedor;
  };

  test("429 con retry-after es cuota reintentable con espera", async () => {
    const e = await fallo(errorHttp(429, "rate_limit_error", "Too many requests", { "retry-after": "7" }));
    expect(e.tipo).toBe("cuota");
    expect(e.reintentable).toBe(true);
    expect(e.detalles.reintentarEnMs).toBe(7000);
    expect(e.detalles.estado).toBe(429);
    expect(e.message).toContain("Too many requests");
  });

  test("401 es autenticación", async () => {
    const e = await fallo(errorHttp(401, "authentication_error", "invalid x-api-key"));
    expect(e.tipo).toBe("autenticacion");
    expect(e.reintentable).toBe(false);
  });

  test("prompt demasiado largo es contexto", async () => {
    const e = await fallo(errorHttp(400, "invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum"));
    expect(e.tipo).toBe("contexto");
    const e413 = await fallo(errorHttp(413, "request_too_large", "Request exceeds the maximum allowed number of bytes."));
    expect(e413.tipo).toBe("contexto");
  });

  test("otro 400 es petición", async () => {
    expect((await fallo(errorHttp(400, "invalid_request_error", "messages: field required"))).tipo).toBe("peticion");
  });

  test("529 y overloaded a mitad del flujo son sobrecarga", async () => {
    expect((await fallo(errorHttp(529, "overloaded_error", "Overloaded"))).tipo).toBe("sobrecarga");
    const aMitad = (senal: AbortSignal) => {
      const r = sse([inicio(), ...texto(0, "Ho")])(senal);
      const codificador = new TextEncoder();
      const original = r.body!.getReader();
      const cuerpo = new ReadableStream<Uint8Array>({
        async pull(c) {
          const { done, value } = await original.read();
          if (!done) return c.enqueue(value);
          c.enqueue(codificador.encode(`event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`));
          c.close();
        },
      });
      return new Response(cuerpo, { headers: { "content-type": "text/event-stream" } });
    };
    const e = await fallo(() => aMitad(new AbortController().signal));
    expect(e.tipo).toBe("sobrecarga");
  });

  test("un fallo de conexión es red", async () => {
    const e = await fallo(() => Promise.reject(new TypeError("fetch failed")));
    expect(e.tipo).toBe("red");
  });

  test("un flujo que termina sin message_stop es red", async () => {
    expect((await fallo(() => sse([inicio(), ...texto(0, "a")])(new AbortController().signal))).tipo).toBe("red");
  });
});

describe("ProveedorAnthropic: cancelación", () => {
  test("abortar a mitad del flujo lanza ErrorAbortado", async () => {
    const control = new AbortController();
    const f = fetchFalso([sse([inicio(), ...texto(0, "Ho")].slice(0, 3), true)]);
    const promesa = proveedor(f).responder(peticion([{ rol: "usuario", texto: "x" }], control.signal), () => control.abort());
    expect(await promesa.catch((e: unknown) => e)).toBeInstanceOf(ErrorAbortado);
  });

  test("con la señal ya abortada no llega a llamar", async () => {
    const control = new AbortController();
    control.abort();
    const f = fetchFalso([sse([inicio(), ...fin("end_turn", 1)])]);
    expect(await proveedor(f).responder(peticion([], control.signal), () => {}).catch((e: unknown) => e)).toBeInstanceOf(ErrorAbortado);
    expect(f.cuerpos).toHaveLength(0);
  });

  test("abortar mientras espera la respuesta lanza ErrorAbortado", async () => {
    const control = new AbortController();
    const colgada = (senal: AbortSignal) =>
      new Promise<Response>((_, mal) => senal.addEventListener("abort", () => mal(new DOMException("abortado", "AbortError"))));
    const f = fetchFalso([colgada]);
    const promesa = proveedor(f).responder(peticion([{ rol: "usuario", texto: "x" }], control.signal), () => {});
    setTimeout(() => control.abort(), 10);
    expect(await promesa.catch((e: unknown) => e)).toBeInstanceOf(ErrorAbortado);
  });
});
