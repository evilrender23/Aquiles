/**
 * Imita `claude -p --input-format stream-json --output-format stream-json` para los tests del proveedor.
 * Según la última línea del mensaje: "herramienta" → llamada en tres trozos más un resultado inventado;
 * "agotado" → error de cuota; "lento" → empieza y espera a que lo interrumpan; otra → eco de lo recibido (el texto y,
 * si hay, las imágenes con el tamaño de su base64) y de su arranque.
 */
export {};

const args = process.argv.slice(2);
const sistema = await Bun.file(args[args.indexOf("--system-prompt-file") + 1] ?? "").text();
const sinHerramientas = args[args.indexOf("--tools") + 1] === "";
const emitir = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const delta = (text: string) => emitir({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7, output_tokens_details: { thinking_tokens: 2 } };
let recibidos = 0;
let lento = false;

emitir({ type: "system", subtype: "init", tools: [] });
for await (const linea of console) {
  const m = JSON.parse(linea);
  if (m.type === "control_request") {
    emitir({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
    if (lento) emitir({ type: "result", subtype: "error_during_execution", is_error: false, usage: {} });
    lento = false;
    continue;
  }
  recibidos += 1;
  // Con imágenes, `content` es una lista de bloques de la API de mensajes.
  const contenido: string | { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[] = m.message.content;
  const texto = typeof contenido === "string" ? contenido : contenido.flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("\n");
  const imagenes = typeof contenido === "string" ? [] : contenido.flatMap((b) => (b.type === "image" ? [{ ...b.source, data: b.source?.data.length }] : []));
  const ultima = texto.split("\n").at(-1) ?? "";
  if (ultima.includes("herramienta")) {
    for (const t of ["Voy a leerlo.\n<herra", 'mienta nombre="leer">{"ruta":"a.txt"}</herramienta>', "\n<resultado>inventado</resultado>"]) delta(t);
    emitir({ type: "result", subtype: "success", is_error: false, result: 'Voy a leerlo.\n<herramienta nombre="leer">{"ruta":"a.txt"}</herramienta>\n<resultado>inventado</resultado>', usage });
  } else if (ultima.includes("agotado")) {
    emitir({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 30 } });
    emitir({ type: "result", subtype: "success", is_error: true, result: "You've hit your usage limit" });
  } else if (ultima.includes("lento")) {
    lento = true;
    delta("Empiezo");
  } else {
    const eco = JSON.stringify({ recibidos, texto, sistema: sistema.split("\n")[0], sinHerramientas, ...(imagenes.length ? { imagenes } : {}) });
    delta(eco);
    emitir({ type: "result", subtype: "success", is_error: false, result: eco, usage, modelUsage: { "claude-prueba-5-5": { contextWindow: 1_000_000 } } });
  }
}
