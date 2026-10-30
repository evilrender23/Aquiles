/** Chat por terminal para probar el motor sin la app. Ctrl+C para el turno; Ctrl+D sale. */
import { createInterface } from "node:readline";
import { ejecutarTurno } from "./bucle";
import type { Herramienta } from "./herramientas/herramienta";
import { Sesiones } from "./sesiones";
import type { Proveedor } from "./tipos";

export async function ejecutarCli(proveedor: Proveedor, herramientas: readonly Herramienta<any>[], cwd: string): Promise<void> {
  const sesion = new Sesiones().crear(cwd);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "\n› " });
  let turno: AbortController | undefined;
  process.on("SIGINT", () => {
    if (turno) turno.abort();
    else process.exit(0);
  });

  console.log(`Aquiles (${proveedor.nombre}) en ${cwd}`);
  rl.prompt();
  for await (const linea of rl) {
    const texto = linea.trim();
    if (!texto) {
      rl.prompt();
      continue;
    }
    sesion.mensajes.push({ rol: "usuario", texto });
    turno = new AbortController();
    rl.pause();
    await ejecutarTurno({
      sesionId: sesion.id,
      cwd,
      sistema: sesion.sistema,
      mensajes: sesion.mensajes,
      proveedor,
      herramientas,
      senal: turno.signal,
      emitir(ev) {
        if (ev.tipo === "mensaje.delta") process.stdout.write(ev.texto);
        else if (ev.tipo === "herramienta.inicio") process.stdout.write(`\n[${ev.nombre}] ${JSON.stringify(ev.argumentos)}\n`);
        else if (ev.tipo === "herramienta.fin") process.stdout.write(`[${ev.error ? "FALLO" : "ok"}] ${ev.resultado.split("\n").length} líneas\n`);
        else if (ev.tipo === "turno.fin" && ev.motivo !== "fin") process.stdout.write(`\n[${ev.motivo}] ${ev.error ?? ""}`);
      },
    });
    turno = undefined;
    rl.resume();
    rl.prompt();
  }
  await proveedor.cerrar?.();
}
