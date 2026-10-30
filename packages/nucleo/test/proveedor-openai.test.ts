import { describe, expect, test } from "bun:test";
import {
  presetsOpenAI,
  ProveedorOpenAICompatible,
  proveedorDePreset,
  traducirMensajesOpenAI,
} from "../src/proveedores/openai-compatible";
import { ErrorAbortado, ErrorProveedor, type Mensaje, type PeticionModelo } from "../src/tipos";

/** fetch falso: responde en orden y guarda URL y cuerpo de cada petición. */
function fetchFalso(respuestas: Array<(senal: AbortSignal) => Response | Promise<Response>>) {
  const peticiones: Array<{ url: string; cuerpo: Record<string, any>; cabeceras: Headers }> = [];
  let i = 0;
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    peticiones.push({ url: String(url), cuerpo: JSON.parse(String(init?.body)), cabeceras: new Headers(init?.headers) });
    const r = respuestas[Math.min(i++, respuestas.length - 1)];
    if (!r) throw new Error("sin respuesta");
    return r(init?.signal ?? new AbortController().signal);
  };
  return { fetch, peticiones };
}

/** SSE de chat.completions; con `colgar`, deja el flujo abierto hasta que se aborte. */
function sse(trozos: unknown[], { colgar = false, fin = true } = {}) {
  return (senal: AbortSignal): Response => {
    const codificador = new TextEncoder();
    const cuerpo = new ReadableStream<Uint8Array>({
      start(c) {
        for (const t of trozos) c.enqueue(codificador.encode(`data: ${JSON.stringify(t)}\n\n`));
        if (colgar) {
          senal.addEventListener("abort", () => c.error(new DOMException("abortado", "AbortError")), { once: true });
          return;
        }
        if (fin) c.enqueue(codificador.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(cuerpo, { headers: { "content-type": "text/event-stream" } });
  };
}

const trozo = (delta: Record<string, unknown>, motivo: string | null = null) => ({
  id: "c1", object: "chat.completion.chunk", created: 0, model: "m",
  choices: [{ index: 0, delta, finish_reason: motivo }],
});
const uso = (entrada: number, salida: number) => ({
  id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [],
  usage: { prompt_tokens: entrada, completion_tokens: salida, total_tokens: entrada + salida },
});

function errorHttp(estado: number, error: Record<string, unknown>, cabeceras: Record<string, string> = {}) {
  return (): Response =>
    new Response(JSON.stringify({ error }), { status: estado, headers: { "content-type": "application/json", ...cabeceras } });
}

function peticion(mensajes: Mensaje[], senal = new AbortController().signal): PeticionModelo {
  return {
    sesionId: "s1",
    sistema: "Eres Aquiles.",
    mensajes,
    herramientas: [{ nombre: "leer", descripcion: "Lee un fichero", esquema: { type: "object", properties: { ruta: { type: "string" } } } }],
    cwd: ".",
    senal,
  };
}

function proveedor(f: ReturnType<typeof fetchFalso>) {
  return new ProveedorOpenAICompatible({ baseURL: "http://openai.test/v1", modelo: "qwen3", nombre: "ollama", fetch: f.fetch });
}

describe("ProveedorOpenAICompatible: respuestas", () => {
  test("emite el texto en streaming y recoge el uso del último trozo", async () => {
    const f = fetchFalso([
      sse([trozo({ role: "assistant", content: "" }), trozo({ content: "Hola" }), trozo({ content: " mundo" }), trozo({}, "stop"), uso(12, 3)]),
    ]);
    const deltas: string[] = [];
    const r = await proveedor(f).responder(peticion([{ rol: "usuario", texto: "hola" }]), (d) => deltas.push(d));
    expect(deltas).toEqual(["Hola", " mundo"]);
    expect(r).toEqual({ texto: "Hola mundo", llamadas: [], uso: { entrada: 12, salida: 3 } });
    expect(f.peticiones[0]?.url).toBe("http://openai.test/v1/chat/completions");
  });

  test("acumula tool_calls por índice con argumentos troceados", async () => {
    const f = fetchFalso([
      sse([
        trozo({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "leer", arguments: "" } }] }),
        trozo({ tool_calls: [{ index: 0, function: { arguments: '{"ru' } }] }),
        trozo({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "leer", arguments: "{ruta:" } }] }),
        trozo({ tool_calls: [{ index: 0, function: { arguments: 'ta":"a.txt"}' } }] }),
        trozo({}, "tool_calls"),
        uso(20, 9),
      ]),
    ]);
    const r = await proveedor(f).responder(peticion([{ rol: "usuario", texto: "lee" }]), () => {});
    expect(r.llamadas).toEqual([
      { id: "call_1", nombre: "leer", argumentos: { ruta: "a.txt" } },
      { id: "call_2", nombre: "leer", argumentos: { __json_invalido: "{ruta:" } },
    ]);
    expect(r.texto).toBe("");
  });

  test("llamadas completas que reutilizan el índice se separan", async () => {
    const f = fetchFalso([
      sse([
        trozo({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "leer", arguments: '{"ruta":"1"}' } }] }),
        trozo({ tool_calls: [{ index: 0, id: "b", type: "function", function: { name: "leer", arguments: '{"ruta":"2"}' } }] }),
        trozo({}, "tool_calls"),
      ]),
    ]);
    const r = await proveedor(f).responder(peticion([{ rol: "usuario", texto: "x" }]), () => {});
    expect(r.llamadas.map((l) => [l.id, l.argumentos])).toEqual([["a", { ruta: "1" }], ["b", { ruta: "2" }]]);
    expect(r.uso).toBeUndefined();
  });

  test("finish_reason length marca la respuesta como cortada", async () => {
    const f = fetchFalso([sse([trozo({ content: "a medias" }, "length")])]);
    expect((await proveedor(f).responder(peticion([{ rol: "usuario", texto: "x" }]), () => {})).cortada).toBe(true);
  });
});

describe("ProveedorOpenAICompatible: traducción", () => {
  test("petición con herramientas function, include_usage y sin clave real", async () => {
    const f = fetchFalso([sse([trozo({ content: "ok" }, "stop")])]);
    await proveedor(f).responder({ ...peticion([{ rol: "usuario", texto: "hola" }]), maxTokensSalida: 500 }, () => {});
    const { cuerpo, cabeceras } = f.peticiones[0]!;
    expect(cuerpo.model).toBe("qwen3");
    expect(cuerpo.stream).toBe(true);
    expect(cuerpo.stream_options).toEqual({ include_usage: true });
    expect(cuerpo.max_tokens).toBe(500);
    expect(cuerpo.tools).toEqual([
      { type: "function", function: { name: "leer", description: "Lee un fichero", parameters: { type: "object", properties: { ruta: { type: "string" } } } } },
    ]);
    expect(cuerpo.messages).toEqual([
      { role: "system", content: "Eres Aquiles." },
      { role: "user", content: "hola" },
    ]);
    expect(cabeceras.get("authorization")).toBe("Bearer sin-clave");
  });

  test("resumen, llamadas, resultados con tool_call_id y fusión de mensajes user", () => {
    const mensajes: Mensaje[] = [
      { rol: "resumen", texto: "Antes leímos b.txt." },
      { rol: "usuario", texto: "Ahora lee a y c" },
      {
        rol: "asistente",
        texto: "",
        llamadas: [
          { id: "call_1", nombre: "leer", argumentos: { ruta: "a" } },
          { id: "call_2", nombre: "leer", argumentos: { ruta: "c" } },
        ],
      },
      { rol: "herramienta", id: "call_1", nombre: "leer", resultado: "contenido a", error: false },
      { rol: "herramienta", id: "call_2", nombre: "leer", resultado: "no existe", error: true },
      { rol: "asistente", texto: "c no existe.", llamadas: [] },
      { rol: "usuario", texto: "vale" },
    ];
    expect(traducirMensajesOpenAI("Sistema", mensajes)).toEqual([
      { role: "system", content: "Sistema" },
      { role: "user", content: "[Resumen de la conversación anterior]\nAntes leímos b.txt.\n\nAhora lee a y c" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "leer", arguments: '{"ruta":"a"}' } },
          { id: "call_2", type: "function", function: { name: "leer", arguments: '{"ruta":"c"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "contenido a" },
      { role: "tool", tool_call_id: "call_2", content: "Error: no existe" },
      { role: "assistant", content: "c no existe." },
      { role: "user", content: "vale" },
    ]);
  });

  test("presets y preset openai con max_completion_tokens y clave del entorno", async () => {
    expect(presetsOpenAI.ollama.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(presetsOpenAI.lmstudio.baseURL).toBe("http://127.0.0.1:1234/v1");
    expect(presetsOpenAI.openrouter).toEqual({ baseURL: "https://openrouter.ai/api/v1", variableClave: "OPENROUTER_API_KEY" });
    expect(presetsOpenAI.openai.variableClave).toBe("OPENAI_API_KEY");

    const anterior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-prueba";
    try {
      const f = fetchFalso([sse([trozo({ content: "ok" }, "stop")])]);
      const p = proveedorDePreset("openai", { modelo: "gpt-x", maxTokens: 900, fetch: f.fetch });
      expect(p.nombre).toBe("openai");
      await p.responder(peticion([{ rol: "usuario", texto: "hola" }]), () => {});
      const { url, cuerpo, cabeceras } = f.peticiones[0]!;
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(cuerpo.max_completion_tokens).toBe(900);
      expect(cuerpo.max_tokens).toBeUndefined();
      expect(cabeceras.get("authorization")).toBe("Bearer sk-prueba");
    } finally {
      if (anterior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = anterior;
    }
  });
});

describe("ProveedorOpenAICompatible: errores", () => {
  const fallo = async (respuesta: (senal: AbortSignal) => Response | Promise<Response>): Promise<ErrorProveedor> => {
    const f = fetchFalso([respuesta]);
    const e = await proveedor(f).responder(peticion([{ rol: "usuario", texto: "x" }]), () => {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorProveedor);
    return e as ErrorProveedor;
  };

  test("429 con retry-after es cuota con espera", async () => {
    const e = await fallo(errorHttp(429, { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" }, { "retry-after": "3" }));
    expect(e.tipo).toBe("cuota");
    expect(e.detalles.reintentarEnMs).toBe(3000);
    expect(e.message).toContain("ollama 429");
  });

  test("retry-after-ms tiene prioridad", async () => {
    const e = await fallo(errorHttp(429, { message: "slow down" }, { "retry-after": "3", "retry-after-ms": "250" }));
    expect(e.detalles.reintentarEnMs).toBe(250);
  });

  test("401 es autenticación", async () => {
    expect((await fallo(errorHttp(401, { message: "Incorrect API key provided", code: "invalid_api_key" }))).tipo).toBe("autenticacion");
  });

  test("contexto demasiado largo", async () => {
    const e = await fallo(
      errorHttp(400, {
        message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
        code: "context_length_exceeded",
      }),
    );
    expect(e.tipo).toBe("contexto");
  });

  test("529 y error a mitad del flujo (OpenRouter) son sobrecarga", async () => {
    expect((await fallo(errorHttp(529, { message: "Overloaded" }))).tipo).toBe("sobrecarga");
    const e = await fallo(sse([trozo({ content: "Ho" }), { error: { code: 502, message: "Provider returned error" } }]));
    expect(e.tipo).toBe("sobrecarga");
    expect(e.detalles.estado).toBe(502);
  });

  test("fallo de conexión y flujo sin finish_reason son red", async () => {
    expect((await fallo(() => Promise.reject(new TypeError("fetch failed")))).tipo).toBe("red");
    expect((await fallo(sse([trozo({ content: "a" })], { fin: false }))).tipo).toBe("red");
  });
});

describe("ProveedorOpenAICompatible: cancelación", () => {
  test("abortar a mitad del flujo lanza ErrorAbortado", async () => {
    const control = new AbortController();
    const f = fetchFalso([sse([trozo({ content: "Ho" })], { colgar: true })]);
    const promesa = proveedor(f).responder(peticion([{ rol: "usuario", texto: "x" }], control.signal), () => control.abort());
    expect(await promesa.catch((e: unknown) => e)).toBeInstanceOf(ErrorAbortado);
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
