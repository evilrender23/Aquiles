/**
 * Imita `codex exec --json … -` para los tests del proveedor: lee el prompt de stdin y escribe eventos JSONL.
 * Según la última línea de la conversación: "herramienta" → una llamada y un resultado inventado; "agotado" → turn.failed
 * con límite de uso; "roto" → sale con código 2 sin eventos; otra → eco del prompt y los argumentos, en base64 para que el texto no lleve etiquetas.
 */
export {};

const args = process.argv.slice(2);
const prompt = await new Response(Bun.stdin.stream()).text();
const emitir = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const conversacion = prompt.split("<conversacion>")[1]?.split("</conversacion>")[0]?.trim() ?? "";
const ultima = conversacion.split("\n").at(-1) ?? "";

if (ultima.includes("roto")) {
  process.stderr.write("fallo de arranque");
  process.exit(2);
}
emitir({ type: "thread.started", thread_id: "t1" });
emitir({ type: "turn.started" });
if (ultima.includes("agotado")) {
  emitir({ type: "turn.failed", error: { message: "You've hit your usage limit." } });
  process.exit(1);
}
const texto = ultima.includes("herramienta")
  ? 'Voy a leerlo.\n<herramienta nombre="leer">{"ruta":"a.txt"}</herramienta>\n<resultado>inventado</resultado>'
  : Buffer.from(JSON.stringify({ args, prompt })).toString("base64");
emitir({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: texto } });
emitir({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 30, reasoning_output_tokens: 4 } });
