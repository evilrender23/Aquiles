/**
 * Prueba de la fase 4 con un modelo real (gasta cuota):
 *   bun packages/nucleo/scripts/probar-aprendizaje.ts [--proveedor claude] [--modelo haiku] [--sin-pedir]
 * Con --sin-pedir el usuario no le pide que lo recuerde: lo tiene que sacar la revisión.
 * 1. Sesión 1: Aquiles crea una nota y el usuario le corrige dónde y cómo se guardan.
 * 2. `/aprender` revisa la conversación; se aceptan las propuestas.
 * 3. Sesión 2: se le pide otra nota sin recordárselo y se comprueba que la pone bien.
 * Usa un perfil y una carpeta temporales; aprueba todo lo que pida permiso.
 */
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RUTA_RPC, type Evento } from "@aquiles/protocolo";
import { herramientasPorDefecto } from "../src/herramientas/index";
import { iniciarServidor } from "../src/servidor";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    proveedor: { type: "string", default: "claude" },
    modelo: { type: "string", default: "haiku" },
    "sin-pedir": { type: "boolean", default: false },
  },
});
const cwd = await mkdtemp(join(tmpdir(), "aquiles-aprende-"));
const perfil = await mkdtemp(join(tmpdir(), "aquiles-perfil-aprende-"));
const TOKEN = "prueba-aprendizaje-0123456789";
const servidor = iniciarServidor({
  puerto: 0, token: TOKEN, proveedor: values.proveedor, modelo: values.modelo, herramientas: herramientasPorDefecto(),
  cwdPorDefecto: cwd, version: "prueba", perfil,
});

const ws = new WebSocket(`ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=${TOKEN}`);
await new Promise((ok) => (ws.onopen = ok));
let n = 0;
const pendientes = new Map<number, (r: any) => void>();
const eventos: Evento[] = [];
ws.onmessage = (m) => {
  const d = JSON.parse(String(m.data));
  if (d.method === "evento") {
    eventos.push(d.params);
    const e = d.params as Evento;
    if (e.tipo === "herramienta.inicio") console.log(`  [${e.nombre}] ${e.resumen ?? ""}`);
    if (e.tipo === "aprendizaje.revision") console.log(`  [revisión] ${e.estado}${e.error ? `: ${e.error}` : ""}`);
  } else if (d.method === "aprobacion.pedir") ws.send(JSON.stringify({ jsonrpc: "2.0", id: d.id, result: { decision: "permitir" } }));
  else if (d.method === "pregunta.hacer") ws.send(JSON.stringify({ jsonrpc: "2.0", id: d.id, result: { respuesta: "Decide tú." } }));
  else pendientes.get(d.id)?.(d);
};
const llamar = (method: string, params: unknown = {}) =>
  new Promise<any>((ok) => {
    n += 1;
    pendientes.set(n, ok);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
  }).then((r) => {
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  });
const turno = async (sesionId: string, texto: string) => {
  const desde = eventos.length;
  console.log(`> ${texto}`);
  await llamar("prompt.enviar", { sesionId, texto });
  for (;;) {
    const fin = eventos.slice(desde).find((e) => e.tipo === "turno.fin" && e.sesionId === sesionId);
    if (fin && fin.tipo === "turno.fin") {
      console.log(`< ${fin.texto.slice(0, 400)}\n`);
      return fin;
    }
    await Bun.sleep(200);
  }
};
const listar = async (dir: string): Promise<string[]> => {
  const salida: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) salida.push(join(e.parentPath, e.name).slice(dir.length + 1).replace(/\\/g, "/"));
  }
  return salida.sort();
};

try {
  const s1 = (await llamar("sesion.crear", {})).sesionId;
  await turno(s1, "Apúntame una nota que diga «comprar pan».");
  await turno(
    s1,
    "No, así no. Mis notas van siempre en la carpeta notas/, en Markdown, y el nombre del fichero empieza por la fecha de hoy (AAAA-MM-DD-tema.md)." +
      (values["sin-pedir"] ? " Arregla esta, sin guardar nada en la memoria." : " Arregla esta y recuérdalo para la próxima vez."),
  );
  console.log(`ficheros tras la sesión 1: ${(await listar(cwd)).join(", ")}`);
  await turno(s1, "/aprender");

  const { propuestas } = await llamar("aprendizaje.listar", {});
  console.log(`propuestas: ${propuestas.length}`);
  for (const p of propuestas) {
    console.log(`  - ${p.resumen}`);
    const r = await llamar("aprendizaje.decidir", { id: p.id, decision: "aceptar" });
    if (r.error) console.log(`    no se pudo aceptar: ${r.error}`);
  }
  const memoria = await llamar("memoria.leer", { cwd });
  console.log(`memoria usuario: ${JSON.stringify(memoria.usuario.entradas)}`);
  console.log(`memoria proyecto: ${JSON.stringify(memoria.proyecto?.entradas)}`);

  const antes = new Set(await listar(cwd));
  const s2 = (await llamar("sesion.crear", {})).sesionId;
  await turno(s2, "Apúntame una nota que diga «llamar al fontanero el jueves».");
  const nuevos = (await listar(cwd)).filter((f) => !antes.has(f));
  const hoy = new Date().toLocaleDateString("sv-SE");
  const bien = nuevos.some((f) => f.startsWith("notas/") && f.endsWith(".md") && f.slice(6).startsWith(hoy));
  console.log(`ficheros nuevos en la sesión 2: ${nuevos.join(", ") || "ninguno"}`);

  const { entradas } = await llamar("aprendizaje.historial", {});
  console.log("lo aprendido:");
  for (const e of entradas) console.log(`  - [${e.origen.tipo}${e.origen.sesionId === s1 ? " · sesión 1" : ""}] ${e.resumen}`);
  const conOrigen = entradas.some((e: any) => e.origen.sesionId === s1);
  console.log(`\n${bien && conOrigen ? "[ok]" : "[FALLO]"} sesión 2 ${bien ? "bien" : "mal"}; origen ${conOrigen ? "visible" : "falta"}`);
  process.exitCode = bien && conOrigen ? 0 : 1;
} finally {
  ws.close();
  await servidor.detener();
}
