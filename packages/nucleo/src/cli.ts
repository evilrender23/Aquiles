/**
 * Chat por terminal para probar el motor sin la app.
 * Ctrl+C para el turno en marcha (o sale si no hay ninguno). Ctrl+D sale.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ModoAprobacion } from "@aquiles/protocolo";
import { ejecutarTurno } from "./bucle";
import { abrirConocimiento } from "./conocimiento";
import type { Herramienta } from "./herramientas/herramienta";
import { cerrarEstadoSesion } from "./herramientas/index";
import { AlmacenSesiones, type Sesion } from "./sesiones";
import type { Proveedor } from "./tipos";

export interface OpcionesCli {
  proveedor: Proveedor;
  herramientas: readonly Herramienta<any>[];
  cwd: string;
  perfil: string;
  /** Carpeta de las skills que vienen con Aquiles. */
  skillsIncluidas?: string | null;
  modoAprobacion: ModoAprobacion;
  /** Id de sesión a reanudar, o "ultima". */
  reanudar?: string;
}

export async function ejecutarCli(o: OpcionesCli): Promise<void> {
  const conocimiento = abrirConocimiento({ perfil: o.perfil, incluidas: o.skillsIncluidas });
  const herramientas = [...o.herramientas, ...conocimiento.herramientas];
  const almacen = new AlmacenSesiones(join(o.perfil, "sesiones"), o.proveedor.nombre, conocimiento.ganchos);
  let sesion: Sesion | undefined;
  if (o.reanudar) {
    const id = o.reanudar === "ultima" ? almacen.listar()[0]?.sesionId : o.reanudar;
    sesion = id ? almacen.obtener(id) : undefined;
    if (!sesion) throw new Error(`No hay sesión que reanudar (${o.reanudar})`);
  }
  sesion ??= almacen.crear(o.cwd, { modoAprobacion: o.modoAprobacion, proveedor: o.proveedor.nombre, modelo: o.proveedor.modelo });
  const s = sesion;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let turno: AbortController | undefined;
  rl.on("SIGINT", () => {
    if (turno) turno.abort();
    else rl.close();
  });

  console.log(`Aquiles (${o.proveedor.nombre}${o.proveedor.modelo ? ` ${o.proveedor.modelo}` : ""}) en ${s.cwd}`);
  console.log(`sesión ${s.id}${s.mensajes.length ? ` (${s.mensajes.length} mensajes)` : ""} · permisos: ${s.modoAprobacion}`);

  try {
    for (;;) {
      let texto: string;
      try {
        texto = (await rl.question("\n› ")).trim();
      } catch {
        break; // Ctrl+D o cierre
      }
      if (!texto) continue;
      const usuario = { rol: "usuario" as const, texto };
      s.mensajes.push(usuario);
      almacen.anotar(s, usuario);
      turno = new AbortController();
      await ejecutarTurno({
        sesionId: s.id,
        cwd: s.cwd,
        sistema: s.sistema,
        mensajes: s.mensajes,
        proveedor: o.proveedor,
        herramientas,
        senal: turno.signal,
        entorno: s,
        alAnadir: (m) => almacen.anotar(s, m),
        alCompactar: () => almacen.anotarCompactacion(s),
        async aprobar(p) {
          const r = (await rl.question(`\n¿Permitir ${p.herramienta}: ${p.resumen || JSON.stringify(p.argumentos)}? (${p.motivo}) [s]í / [t]odas / [n]o › `))
            .trim()
            .toLowerCase();
          return r.startsWith("t") ? "siempre" : r.startsWith("s") || r === "" ? "permitir" : "denegar";
        },
        async preguntar(p) {
          const opciones = p.opciones?.map((x, i) => `  ${i + 1}. ${x}`).join("\n");
          const r = (await rl.question(`\n${p.texto}${opciones ? `\n${opciones}` : ""}\n› `)).trim();
          const n = Number(r);
          return p.opciones && Number.isInteger(n) && p.opciones[n - 1] ? p.opciones[n - 1]! : r;
        },
        async guardarSalida(id, contenido) {
          const dir = join(o.perfil, "salidas", s.id);
          await mkdir(dir, { recursive: true });
          const ruta = join(dir, `${id.replace(/[^\w-]/g, "_")}.txt`);
          await writeFile(ruta, contenido);
          return ruta;
        },
        emitir(ev) {
          if (ev.tipo === "mensaje.delta") process.stdout.write(ev.texto);
          else if (ev.tipo === "herramienta.inicio") process.stdout.write(`\n[${ev.nombre}] ${ev.resumen ?? JSON.stringify(ev.argumentos)}\n`);
          else if (ev.tipo === "herramienta.fin") process.stdout.write(`[${ev.error ? "FALLO" : "ok"}] ${ev.error ? ev.resultado.split("\n")[0] : `${ev.resultado.split("\n").length} líneas`}\n`);
          else if (ev.tipo === "tareas") process.stdout.write(`${ev.tareas.map((t) => `  ${t.estado === "hecha" ? "[x]" : t.estado === "en-curso" ? "[>]" : "[ ]"} ${t.texto}`).join("\n")}\n`);
          else if (ev.tipo === "turno.reintento") process.stdout.write(`\n[AVISO] reintento ${ev.intento} en ${Math.round(ev.esperaMs / 1000)} s: ${ev.motivo}\n`);
          else if (ev.tipo === "contexto.compactado") process.stdout.write(`\n[AVISO] contexto compactado (${ev.metodo}): ${ev.antes} → ${ev.despues} tokens\n`);
          else if (ev.tipo === "turno.fin" && ev.motivo !== "fin") process.stdout.write(`\n[${ev.motivo === "error" ? "FALLO" : "AVISO"}] ${ev.motivo}${ev.error ? `: ${ev.error}` : ""}`);
        },
      });
      turno = undefined;
    }
  } finally {
    rl.close();
    await cerrarEstadoSesion(s.estado);
    await o.proveedor.cerrar?.();
    conocimiento.cerrar();
  }
}
