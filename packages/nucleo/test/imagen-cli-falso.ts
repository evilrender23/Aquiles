/**
 * Imita codex y agy para generar_imagen con CLI. IMAGEN_FALSO_CLI = codex | agy; IMAGEN_FALSO_MODO dice cómo
 * entrega la imagen: b64 (en un evento), ruta (ruta absoluta en un evento), cwd (fichero en la carpeta de trabajo),
 * datos (fichero en IMAGEN_FALSO_DATOS) o nada. Apunta sus argumentos en IMAGEN_FALSO_ARGS.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-falso-".repeat(40))]);
const cli = process.env.IMAGEN_FALSO_CLI;
const modo = process.env.IMAGEN_FALSO_MODO;
const salida = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
writeFileSync(process.env.IMAGEN_FALSO_ARGS!, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));

const entregar = (): unknown => {
  if (modo === "b64") return { result: PNG.toString("base64") };
  if (modo === "ruta") {
    const ruta = join(process.env.IMAGEN_FALSO_DATOS!, "generada.png");
    mkdirSync(process.env.IMAGEN_FALSO_DATOS!, { recursive: true });
    writeFileSync(ruta, PNG);
    return { saved_path: ruta };
  }
  if (modo === "cwd") writeFileSync(join(process.cwd(), "imagen.png"), PNG);
  if (modo === "datos") {
    mkdirSync(join(process.env.IMAGEN_FALSO_DATOS!, "brain", "abc"), { recursive: true });
    writeFileSync(join(process.env.IMAGEN_FALSO_DATOS!, "brain", "abc", "gato_123.png"), PNG);
  }
  return {};
};

const stdin = readFileSync(0, "utf8");
if (cli === "codex") {
  appendFileSync(process.env.IMAGEN_FALSO_ARGS!.replace(/\.json$/, ".stdin"), stdin);
  salida({ type: "thread.started" });
  salida({ type: "item.completed", item: { type: "image_generation", ...(entregar() as object) } });
  salida({ type: "item.completed", item: { type: "agent_message", text: "Aquí tienes la imagen." } });
  salida({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
} else {
  appendFileSync(process.env.IMAGEN_FALSO_ARGS!.replace(/\.json$/, ".stdin"), stdin);
  salida({ conversation_id: "c1", step_update: { step_index: 0, step_type: "tool", tool_info: { name: "generate_image", parameters: { Prompt: "x" } }, ...(entregar() as object) } });
  salida({ event: "result", result: { status: "SUCCESS", response: "Imagen generada." } });
  // agy se queda esperando otro mensaje: quien lo llama tiene que pararlo.
  await new Promise(() => {});
}
