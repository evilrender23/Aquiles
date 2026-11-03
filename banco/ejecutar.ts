#!/usr/bin/env bun
/**
 * Banco de tareas: mide si el motor del agente mejora o empeora.
 *
 *   bun banco/ejecutar.ts [--proveedor agy] [--modelo X] [--tareas 01,05] [--paralelo 2]
 *                         [--max-iteraciones 40] [--tiempo-max 900] [--detalle] [--conservar]
 *   bun banco/ejecutar.ts --validar [--tareas ...]
 *   bun banco/ejecutar.ts --comparar A.json B.json
 *
 * Cada tarea: copia `inicial/` a una carpeta temporal, ejecuta el agente con el enunciado
 * (`tarea.md`) y pasa `comprobar.ts` sobre el resultado. `--validar` no usa el agente: comprueba
 * que cada `comprobar.ts` falla sobre `inicial/` y pasa sobre `inicial/` + `solucion/`.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { comparar, esSospechosa, porTarea, resumir, type ResultadoTarea } from "./analisis";
import { copiarProyecto } from "./comun";

const DIR_BANCO = import.meta.dir;
const RAIZ_REPO = resolve(DIR_BANCO, "..");
const DIR_TAREAS = join(DIR_BANCO, "tareas");
const DIR_RESULTADOS = join(DIR_BANCO, "resultados");
const TIEMPO_COMPROBAR_MS = 90_000;

// ------------------------------------------------------------------ argumentos

const AYUDA = `Uso: bun banco/ejecutar.ts [opciones]

  --proveedor <nombre>     proveedor del agente (por defecto agy)
  --modelo <id>            modelo a pedir al proveedor
  --tareas <ids>           tareas separadas por comas: 01,05 o 03-renombrar-funcion (por defecto, todas)
  --paralelo <n>           tareas a la vez (por defecto 2)
  --max-iteraciones <n>    límite de iteraciones del bucle del agente (por defecto 40)
  --tiempo-max <s>         límite por tarea en segundos (por defecto 900)
  --detalle                muestra las herramientas que va usando el agente
  --conservar              no borra las carpetas de trabajo de las tareas aprobadas
  --repeticiones <n>       ejecuta cada tarea n veces y da la media y la dispersión (por defecto 1)
  --validar                sin agente: comprueba que cada tarea falla en inicial/ y pasa con solucion/
  --comparar A.json B.json sin agente: qué tareas mejoran o empeoran de A a B, con tokens y tiempo
  -h, --ayuda              esta ayuda`;

function leerOpciones() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      strict: true,
      allowPositionals: true,
      options: {
        proveedor: { type: "string", default: "agy" },
        modelo: { type: "string" },
        tareas: { type: "string" },
        paralelo: { type: "string", default: "2" },
        "max-iteraciones": { type: "string", default: "40" },
        "tiempo-max": { type: "string", default: "900" },
        detalle: { type: "boolean", default: false },
        conservar: { type: "boolean", default: false },
        validar: { type: "boolean", default: false },
        repeticiones: { type: "string", default: "1" },
        comparar: { type: "boolean", default: false },
        ayuda: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n\n${AYUDA}`);
    process.exit(2);
  }
}

const { values: opciones, positionals: ficheros } = leerOpciones();
if (opciones.ayuda) {
  console.log(AYUDA);
  process.exit(0);
}

function entero(nombre: string, valor: string, minimo: number): number {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < minimo) {
    console.error(`--${nombre} debe ser un entero ≥ ${minimo} (recibido: ${valor})`);
    process.exit(2);
  }
  return n;
}

const PARALELO = entero("paralelo", opciones.paralelo, 1);
const MAX_ITERACIONES = entero("max-iteraciones", opciones["max-iteraciones"], 1);
const TIEMPO_MAX_S = entero("tiempo-max", opciones["tiempo-max"], 1);
const REPETICIONES = entero("repeticiones", opciones.repeticiones, 1);

// ------------------------------------------------------------------ tareas

interface Tarea {
  id: string;
  numero: string;
  dir: string;
}

function listarTareas(filtro?: string): Tarea[] {
  const todas = readdirSync(DIR_TAREAS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+-/.test(e.name))
    .map((e) => ({ id: e.name, numero: e.name.split("-")[0]!, dir: join(DIR_TAREAS, e.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!filtro) return todas;
  const elegidas: Tarea[] = [];
  for (const token of filtro.split(",").map((t) => t.trim()).filter(Boolean)) {
    const t = todas.find((x) => x.id === token || x.numero === token || Number(x.numero) === Number(token));
    if (!t) {
      console.error(`No existe la tarea "${token}". Disponibles:\n  ${todas.map((x) => x.id).join("\n  ")}`);
      process.exit(2);
    }
    if (!elegidas.includes(t)) elegidas.push(t);
  }
  return elegidas;
}

// ------------------------------------------------------------------ utilidades

const ahora = () => performance.now();
const segundosDesde = (t0: number) => Math.round((ahora() - t0) / 10) / 100;
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

function marcaDeTiempo(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Mata un proceso y sus hijos (en Windows `kill` no alcanza a los nietos). */
function matarArbol(pid: number): void {
  try {
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    // ya había terminado
  }
}

/** Ejecuta `items` con `n` a la vez; deja de empezar nuevos si se aborta. */
/** Borra una carpeta reintentando si Windows aún la tiene bloqueada (EBUSY/EPERM). */
async function borrarConReintentos(carpeta: string, intentos = 8): Promise<boolean> {
  for (let i = 0; i < intentos; i++) {
    try {
      rmSync(carpeta, { recursive: true, force: true });
      return true;
    } catch {
      await Bun.sleep(250 * (i + 1));
    }
  }
  return false;
}

async function enParalelo<T, R>(items: T[], n: number, senal: AbortSignal, f: (x: T) => Promise<R>): Promise<(R | undefined)[]> {
  const resultados: (R | undefined)[] = new Array(items.length);
  let siguiente = 0;
  const trabajador = async () => {
    while (!senal.aborted && siguiente < items.length) {
      const i = siguiente++;
      resultados[i] = await f(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, trabajador));
  return resultados;
}

function tabla(cabecera: string[], filas: string[][]): string {
  const anchos = cabecera.map((c, i) => Math.max(c.length, ...filas.map((f) => (f[i] ?? "").length)));
  const linea = (f: string[]) => f.map((c, i) => (i === f.length - 1 ? c : c.padEnd(anchos[i]!))).join("  ").trimEnd();
  return [linea(cabecera), anchos.map((a) => "-".repeat(a)).join("  "), ...filas.map(linea)].join("\n");
}

const corto = (s: string, n = 70) => {
  const una = s.replace(/\s+/g, " ").trim();
  return una.length > n ? `${una.slice(0, n - 1)}…` : una;
};

// ------------------------------------------------------------------ comprobador

interface ResultadoComprobar {
  ok: boolean;
  motivo: string;
  segundos: number;
}

const procesosVivos = new Set<number>();

async function comprobarCarpeta(t: Tarea, carpeta: string): Promise<ResultadoComprobar> {
  const t0 = ahora();
  const proc = Bun.spawn([process.execPath, join(t.dir, "comprobar.ts"), carpeta], {
    cwd: t.dir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  procesosVivos.add(proc.pid);
  let agotado = false;
  const temporizador = setTimeout(() => {
    agotado = true;
    matarArbol(proc.pid);
  }, TIEMPO_COMPROBAR_MS);
  const [salida, errores, codigo] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(temporizador);
  procesosVivos.delete(proc.pid);
  const texto = `${salida}${errores}`.replace(/\r\n/g, "\n").trim();
  const ok = codigo === 0 && !agotado;
  let motivo: string;
  if (agotado) motivo = `el comprobador no terminó en ${TIEMPO_COMPROBAR_MS / 1000} s`;
  else if (ok) motivo = "OK";
  else {
    const i = texto.indexOf("FALLO: ");
    motivo = (i >= 0 ? texto.slice(i + 7) : texto || `el comprobador salió con código ${codigo}`).slice(0, 2000);
  }
  return { ok, motivo, segundos: segundosDesde(t0) };
}

// ------------------------------------------------------------------ Ctrl+C

const parada = new AbortController();
let interrupciones = 0;
process.on("SIGINT", () => {
  interrupciones++;
  if (interrupciones > 1) {
    console.error("\nSaliendo ya.");
    for (const pid of procesosVivos) matarArbol(pid);
    process.exit(130);
  }
  console.error("\nInterrumpido: parando las tareas en curso (Ctrl+C otra vez para salir ya)…");
  parada.abort();
  for (const pid of procesosVivos) matarArbol(pid);
});

// ------------------------------------------------------------------ validar

async function validar(tareas: Tarea[]): Promise<number> {
  const raiz = join(tmpdir(), "aquiles-banco", `validar-${marcaDeTiempo()}-${process.pid}`);
  mkdirSync(raiz, { recursive: true });
  console.log(`Validando ${tareas.length} tareas (carpetas en ${raiz})\n`);
  const t0 = ahora();

  const filas = await enParalelo(tareas, PARALELO, parada.signal, async (t) => {
    const problemas: string[] = [];
    const enunciado = existsSync(join(t.dir, "tarea.md")) ? readFileSync(join(t.dir, "tarea.md"), "utf8").trim() : "";
    if (!enunciado) problemas.push("falta tarea.md o está vacío");
    if (!existsSync(join(t.dir, "comprobar.ts"))) problemas.push("falta comprobar.ts");
    if (!existsSync(join(t.dir, "solucion"))) problemas.push("falta solucion/");
    const pkg = join(t.dir, "inicial", "package.json");
    if (!existsSync(pkg)) problemas.push("falta inicial/package.json");
    else {
      const p = JSON.parse(readFileSync(pkg, "utf8"));
      if (Object.keys({ ...p.dependencies, ...p.devDependencies }).length) problemas.push("inicial/package.json tiene dependencias");
    }
    let inicial: ResultadoComprobar = { ok: true, motivo: "-", segundos: 0 };
    let solucion: ResultadoComprobar = { ok: false, motivo: "-", segundos: 0 };
    const dirInicial = join(raiz, `${t.id}-inicial`);
    const dirSolucion = join(raiz, `${t.id}-solucion`);
    if (!problemas.length) {
      try {
        copiarProyecto(join(t.dir, "inicial"), dirInicial);
        copiarProyecto(join(t.dir, "inicial"), dirSolucion);
        copiarProyecto(join(t.dir, "solucion"), dirSolucion);
        [inicial, solucion] = await Promise.all([comprobarCarpeta(t, dirInicial), comprobarCarpeta(t, dirSolucion)]);
      } catch (e) {
        problemas.push(`error al preparar: ${mensaje(e)}`);
      }
      if (inicial.ok) problemas.push("comprobar PASA sobre inicial/ (debería fallar)");
      if (!solucion.ok) problemas.push(`comprobar FALLA sobre la solución: ${solucion.motivo}`);
      for (const r of [inicial, solucion]) if (r.segundos > 10) problemas.push(`comprobar tarda ${r.segundos} s (> 10 s)`);
    }
    const valida = problemas.length === 0;
    if (valida) {
      rmSync(dirInicial, { recursive: true, force: true });
      rmSync(dirSolucion, { recursive: true, force: true });
    }
    console.log(`${valida ? "OK   " : "MAL  "} ${t.id}`);
    return { t, valida, problemas, inicial, solucion, dirInicial, dirSolucion };
  });

  const hechas = filas.filter((f): f is NonNullable<typeof f> => f !== undefined);
  console.log(
    `\n${tabla(
      ["tarea", "valida", "inicial (s)", "solucion (s)", "motivo del fallo en inicial / problemas"],
      hechas.map((f) => [
        f.t.id,
        f.valida ? "sí" : "NO",
        String(f.inicial.segundos),
        String(f.solucion.segundos),
        corto(f.valida ? f.inicial.motivo : f.problemas.join(" | "), 90),
      ]),
    )}`,
  );
  const malas = hechas.filter((f) => !f.valida);
  for (const f of malas) {
    console.log(`\n${f.t.id}:\n  ${f.problemas.join("\n  ")}\n  carpetas: ${f.dirInicial} · ${f.dirSolucion}`);
  }
  const validas = hechas.length - malas.length;
  console.log(`\n${validas}/${tareas.length} tareas válidas en ${segundosDesde(t0)} s`);
  if (!malas.length) rmSync(raiz, { recursive: true, force: true });
  if (parada.signal.aborted) return 130;
  return malas.length || hechas.length < tareas.length ? 1 : 0;
}

// ------------------------------------------------------------------ ejecutar con el agente

interface Tokens {
  entrada: number;
  salida: number;
  razonamiento: number;
  total: number;
}

interface ResultadoBanco {
  id: string;
  ok: boolean;
  /** Salida del comprobador (o por qué no se comprobó). */
  motivo: string;
  /** Motivo de fin del turno del agente: fin, limite, parado, error (null si no llegó a ejecutarse). */
  fin: string | null;
  segundos: number;
  segundosComprobar: number;
  tokens: Tokens;
  llamadas: number;
  error: string | null;
  /** Pila del error si el fallo fue del propio banco (no del agente): para poder arreglarlo. */
  traza: string | null;
  carpeta: string | null;
  registro: string | null;
  repeticion: number;
  /** Terminó en «fin» sin usar ninguna herramienta. */
  sospechosa: boolean;
}

const traza = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));

async function ejecutarBanco(tareas: Tarea[]): Promise<number> {
  // Se importa aquí para que --validar funcione aunque el núcleo esté a medio cambiar.
  let ejecutarTarea: typeof import("../packages/nucleo/src/agente").ejecutarTarea;
  let crearProveedor: typeof import("../packages/nucleo/src/proveedores/index").crearProveedor;
  try {
    ({ ejecutarTarea } = await import("../packages/nucleo/src/agente"));
    ({ crearProveedor } = await import("../packages/nucleo/src/proveedores/index"));
  } catch (e) {
    console.error(`No se puede cargar el núcleo del agente: ${mensaje(e)}`);
    return 1;
  }
  const proveedorNombre = opciones.proveedor;
  try {
    await crearProveedor(proveedorNombre, { modelo: opciones.modelo }).cerrar?.();
  } catch (e) {
    console.error(mensaje(e));
    return 2;
  }

  // El agente puede ejecutar `tsc` en sus carpetas temporales (tarea de tipos) sin descargar nada.
  const clavePath = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  process.env[clavePath] = `${join(RAIZ_REPO, "node_modules", ".bin")}${delimiter}${process.env[clavePath] ?? ""}`;

  const inicio = new Date();
  const raiz = join(tmpdir(), "aquiles-banco", `${marcaDeTiempo(inicio)}-${process.pid}`);
  mkdirSync(raiz, { recursive: true });
  console.log(
    `Banco: ${tareas.length} tareas · proveedor ${proveedorNombre}${opciones.modelo ? ` · modelo ${opciones.modelo}` : ""}` +
      ` · paralelo ${PARALELO} · máx. ${MAX_ITERACIONES} iteraciones · límite ${TIEMPO_MAX_S} s\nCarpetas de trabajo en ${raiz}\n`,
  );
  const t0 = ahora();
  let modeloUsado: string | null = opciones.modelo ?? null;

  const correr = async (t: Tarea, repeticion: number): Promise<ResultadoBanco> => {
    const nombre = REPETICIONES > 1 ? `${t.id}-r${repeticion}` : t.id;
    const carpeta = join(raiz, nombre);
    const registro = join(raiz, `${nombre}.log`);
    const r: ResultadoBanco = {
      id: t.id,
      ok: false,
      motivo: "",
      fin: null,
      segundos: 0,
      segundosComprobar: 0,
      tokens: { entrada: 0, salida: 0, razonamiento: 0, total: 0 },
      llamadas: 0,
      error: null,
      traza: null,
      carpeta: null,
      registro,
      repeticion,
      sospechosa: false,
    };
    const log = (linea: string) => {
      try {
        appendFileSync(registro, `${linea}\n`);
      } catch {
        // el registro es solo para depurar
      }
    };
    const control = new AbortController();
    const alParar = () => control.abort();
    parada.signal.addEventListener("abort", alParar, { once: true });
    let porTiempo = false;
    const limite = setTimeout(() => {
      porTiempo = true;
      control.abort();
    }, TIEMPO_MAX_S * 1000);
    console.log(`→ ${nombre}`);
    try {
      const enunciado = readFileSync(join(t.dir, "tarea.md"), "utf8").trim();
      copiarProyecto(join(t.dir, "inicial"), carpeta);
      const proveedor = crearProveedor(proveedorNombre, { modelo: opciones.modelo });
      modeloUsado ??= proveedor.modelo ?? null;
      log(`# ${t.id} · ${new Date().toISOString()} · ${proveedorNombre}${proveedor.modelo ? ` (${proveedor.modelo})` : ""}\n# cwd: ${carpeta}\n\n${enunciado}\n`);
      let texto = "";
      const volcarTexto = () => {
        if (texto.trim()) log(`[asistente] ${texto.trim()}`);
        texto = "";
      };
      const tAgente = ahora();
      try {
        const res = await ejecutarTarea({
          proveedor,
          cwd: carpeta,
          prompt: enunciado,
          maxIteraciones: MAX_ITERACIONES,
          senal: control.signal,
          alEvento(e) {
            if (e.tipo === "mensaje.delta") texto += e.texto;
            else if (e.tipo === "herramienta.inicio") {
              volcarTexto();
              const args = JSON.stringify(e.argumentos);
              log(`[→ ${e.nombre}] ${args.length > 600 ? `${args.slice(0, 600)}…` : args}`);
              if (opciones.detalle) console.log(`  [${t.numero}] ${e.nombre} ${corto(args, 90)}`);
            } else if (e.tipo === "herramienta.fin") {
              log(`[← ${e.nombre}${e.error ? " ERROR" : ""}] ${e.resultado.length > 1500 ? `${e.resultado.slice(0, 1500)}…` : e.resultado}`);
            } else if (e.tipo === "turno.fin") {
              volcarTexto();
              log(`[fin] ${e.motivo}${e.error ? ` · ${e.error}` : ""} · uso ${JSON.stringify(e.uso ?? {})}`);
            }
          },
        });
        r.fin = res.motivo;
        r.llamadas = res.llamadas;
        const razonamiento = res.uso.razonamiento ?? 0;
        r.tokens = { entrada: res.uso.entrada, salida: res.uso.salida, razonamiento, total: res.uso.entrada + res.uso.salida + razonamiento };
        if (res.error) r.error = res.error;
      } finally {
        r.segundos = segundosDesde(tAgente);
      }
      if (porTiempo) r.error = `tiempo agotado (${TIEMPO_MAX_S} s)${r.error ? ` · ${r.error}` : ""}`;
      if (parada.signal.aborted) {
        r.motivo = "interrumpido antes de comprobar";
      } else {
        const c = await comprobarCarpeta(t, carpeta);
        r.ok = c.ok;
        r.motivo = !c.ok && parada.signal.aborted ? "interrumpido durante la comprobación" : c.motivo;
        r.segundosComprobar = c.segundos;
        log(`\n[comprobar] ${c.ok ? "OK" : `FALLO: ${c.motivo}`}`);
      }
    } catch (e) {
      r.error = mensaje(e);
      r.traza = traza(e);
      r.motivo ||= "error al ejecutar la tarea";
      log(`[error del banco] ${r.traza}`);
    } finally {
      clearTimeout(limite);
      parada.signal.removeEventListener("abort", alParar);
      // En Windows la carpeta puede seguir bloqueada un momento tras cerrar el shell de la tarea:
      // borrar no debe pisar nunca el resultado; si no se puede, se deja y se apunta.
      if (r.ok && !opciones.conservar && !(await borrarConReintentos(carpeta).catch(() => false))) r.carpeta = carpeta;
      else if (!r.ok && existsSync(carpeta)) r.carpeta = carpeta;
    }
    r.sospechosa = esSospechosa(r);
    console.log(
      `${r.ok ? "✓" : "✗"} ${nombre}  ${r.segundos} s · ${r.tokens.total} tokens · ${r.llamadas} llamadas · ${r.fin ?? "-"}` +
        `${r.ok ? "" : ` · ${corto(r.error ?? r.motivo, 80)}`}${r.sospechosa ? " · SOSPECHOSA (sin herramientas)" : ""}`,
    );
    return r;
  };

  /** Un resultado vacío: para lo que no llegó a ejecutarse o falló fuera del agente. */
  const vacio = (t: Tarea, repeticion: number, motivo: string, e?: unknown): ResultadoBanco => ({
    id: t.id, ok: false, motivo, fin: null, segundos: 0, segundosComprobar: 0, tokens: { entrada: 0, salida: 0, razonamiento: 0, total: 0 },
    llamadas: 0, error: e === undefined ? null : mensaje(e), traza: e === undefined ? null : traza(e), carpeta: null, registro: null, repeticion, sospechosa: false,
  });

  // Repetición a repetición, para que una ejecución interrumpida deje repeticiones enteras.
  const trabajos = Array.from({ length: REPETICIONES }, (_, i) => tareas.map((t) => ({ t, repeticion: i + 1 }))).flat();
  const salida = await enParalelo(trabajos, PARALELO, parada.signal, async ({ t, repeticion }) => {
    try {
      return await correr(t, repeticion);
    } catch (e) {
      // Nunca debería llegar aquí, pero un fallo inesperado no tumba al resto (y queda su traza).
      return vacio(t, repeticion, "error del banco", e);
    }
  });

  const resultados: ResultadoBanco[] = trabajos.map(({ t, repeticion }, i) => salida[i] ?? vacio(t, repeticion, "no ejecutada (interrumpido)"));
  const segundosTotal = segundosDesde(t0);
  const aprobadas = resultados.filter((r) => r.ok).length;
  const suma = (f: (r: ResultadoBanco) => number) => resultados.reduce((s, r) => s + f(r), 0);
  const resumen = {
    aprobadas,
    total: resultados.length,
    puntuacion: `${aprobadas}/${resultados.length}`,
    porcentaje: resultados.length ? Math.round((aprobadas / resultados.length) * 1000) / 10 : 0,
    tokens: {
      entrada: suma((r) => r.tokens.entrada),
      salida: suma((r) => r.tokens.salida),
      razonamiento: suma((r) => r.tokens.razonamiento),
      total: suma((r) => r.tokens.total),
    },
    llamadas: suma((r) => r.llamadas),
    segundosAgente: Math.round(suma((r) => r.segundos) * 10) / 10,
    segundosTotal,
    interrumpido: parada.signal.aborted,
    ...resumir(resultados),
  };

  mkdirSync(DIR_RESULTADOS, { recursive: true });
  const limpio = (s: string) => s.replace(/[^\w.-]+/g, "_");
  const base = `${marcaDeTiempo(inicio)}-${limpio(proveedorNombre)}${modeloUsado ? `-${limpio(modeloUsado)}` : ""}`;
  let fichero = join(DIR_RESULTADOS, `${base}.json`);
  for (let n = 2; existsSync(fichero); n++) fichero = join(DIR_RESULTADOS, `${base}-${n}.json`);
  writeFileSync(
    fichero,
    `${JSON.stringify(
      {
        fecha: inicio.toISOString(),
        proveedor: proveedorNombre,
        modelo: modeloUsado,
        maxIteraciones: MAX_ITERACIONES,
        paralelo: PARALELO,
        tiempoMaxSegundos: TIEMPO_MAX_S,
        repeticiones: REPETICIONES,
        resumen,
        tareas: resultados,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `\n${tabla(
      ["tarea", "ok", "fin", "seg", "tokens", "llamadas", "motivo"],
      resultados.map((r) => [r.id, r.ok ? "sí" : "no", r.fin ?? "-", String(r.segundos), String(r.tokens.total), String(r.llamadas), r.ok ? "" : corto(r.error ? `${r.error} · ${r.motivo}` : r.motivo)]),
    )}`,
  );
  if (REPETICIONES > 1) {
    console.log(
      `\nPor tarea (${REPETICIONES} repeticiones):\n${tabla(
        ["tarea", "aprobadas", "tokens (media)", "seg (media ± desv.)", "sospechosas"],
        porTarea(resultados).map((t) => [t.id, `${t.aprobadas}/${t.repeticiones}`, String(t.tokensMedia), `${t.segundosMedia} ± ${t.segundosDesv}`, String(t.sospechosas)]),
      )}`,
    );
    console.log(`\nAprobadas por repetición: ${resumen.aprobadasMedia} ± ${resumen.aprobadasDesv} de ${tareas.length}`);
  }
  if (resumen.tokensPorAprobada !== null) console.log(`Coste: ${resumen.tokensPorAprobada} tokens por tarea aprobada`);
  if (resumen.probablementeRota) {
    console.log(
      `\nAVISO: ${resumen.sospechosas} de ${resultados.length} terminaron sin usar ninguna herramienta. ` +
        "Lo más probable es que el modelo no pudiera usarlas: esta ejecución no mide el motor.",
    );
  } else if (resumen.sospechosas) {
    console.log(`\n${resumen.sospechosas} sospechosa(s): terminaron sin usar ninguna herramienta.`);
  }
  console.log(
    `\nPuntuación: ${resumen.puntuacion} (${resumen.porcentaje} %) · ${resumen.tokens.total} tokens ` +
      `(entrada ${resumen.tokens.entrada}, salida ${resumen.tokens.salida}, razonamiento ${resumen.tokens.razonamiento}) · ` +
      `${resumen.llamadas} llamadas · ${segundosTotal} s${resumen.interrumpido ? " · INTERRUMPIDO" : ""}`,
  );
  console.log(`Resultados: ${fichero}`);
  console.log(`Registros del agente${resultados.some((r) => r.carpeta) ? " y carpetas de las fallidas" : ""}: ${raiz}`);
  return parada.signal.aborted ? 130 : 0;
}

// ------------------------------------------------------------------ comparar

function compararFicheros(a: string, b: string): number {
  const leer = (f: string): ResultadoTarea[] => {
    try {
      return JSON.parse(readFileSync(f, "utf8")).tareas as ResultadoTarea[];
    } catch (e) {
      console.error(`No se puede leer ${f}: ${mensaje(e)}`);
      process.exit(2);
    }
  };
  const ra = leer(a);
  const rb = leer(b);
  const filas = comparar(ra, rb);
  const pct = (x?: number) => (x === undefined ? "-" : `${Math.round(x * 100)} %`);
  const delta = (x?: number, y?: number) => (x === undefined || y === undefined ? "-" : `${y - x >= 0 ? "+" : ""}${Math.round((y - x) * 10) / 10}`);
  const marca = { mejora: "↑ mejora", empeora: "↓ empeora", igual: "", nueva: "nueva", quitada: "quitada" };
  console.log(`A: ${a}\nB: ${b}\n`);
  console.log(
    tabla(
      ["tarea", "A", "B", "", "Δ tokens", "Δ seg"],
      filas.map((f) => [f.id, pct(f.a), pct(f.b), marca[f.cambio], delta(f.tokensA, f.tokensB), delta(f.segundosA, f.segundosB)]),
    ),
  );
  const sa = resumir(ra);
  const sb = resumir(rb);
  console.log(
    `\nAprobadas: ${sa.aprobadasMedia} → ${sb.aprobadasMedia} · mejoran ${filas.filter((f) => f.cambio === "mejora").length}, ` +
      `empeoran ${filas.filter((f) => f.cambio === "empeora").length} · tokens por aprobada: ${sa.tokensPorAprobada ?? "-"} → ${sb.tokensPorAprobada ?? "-"}`,
  );
  for (const [nombre, s] of [["A", sa], ["B", sb]] as const) {
    if (s.probablementeRota) console.log(`AVISO: ${nombre} probablemente no es válida (${s.sospechosas} tareas sin herramientas).`);
  }
  return 0;
}

// ------------------------------------------------------------------ principal

if (opciones.comparar) {
  if (ficheros.length !== 2) {
    console.error(`--comparar necesita dos ficheros de resultados.\n\n${AYUDA}`);
    process.exit(2);
  }
  process.exit(compararFicheros(ficheros[0]!, ficheros[1]!));
}
if (ficheros.length) {
  console.error(`Argumentos de más: ${ficheros.join(" ")}\n\n${AYUDA}`);
  process.exit(2);
}

const tareas = listarTareas(opciones.tareas);
if (!tareas.length) {
  console.error(`No hay tareas en ${DIR_TAREAS}`);
  process.exit(1);
}
const codigo = opciones.validar ? await validar(tareas) : await ejecutarBanco(tareas);
process.exit(codigo);
