/**
 * Índice de texto completo de las sesiones (SQLite FTS5 de Bun), sin distinguir tildes ni mayúsculas.
 * Se alimenta en vivo con `indexar` y al arrancar con `sincronizar`, que lee los JSONL de sesiones.
 * `indice` es el ordinal (desde 0) de la línea "mensaje" dentro del JSONL, contando también las anteriores
 * a una compactación; las líneas que no se pueden leer no cuentan, igual que al cargar la sesión.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResultadoBusqueda } from "@aquiles/protocolo";
import { z } from "zod";
import { definir, type Herramienta } from "./herramientas/herramienta";
import type { Mensaje } from "./tipos";

const MAX_TEXTO = 20_000;
const LINEAS_RESULTADO = 5;
const POR_SESION = 3;

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS sesiones (
  id TEXT PRIMARY KEY,
  titulo TEXT,
  cwd TEXT NOT NULL,
  actualizada TEXT NOT NULL,
  bytes INTEGER
);
CREATE TABLE IF NOT EXISTS mensajes (
  id INTEGER PRIMARY KEY,
  sesion TEXT NOT NULL,
  indice INTEGER NOT NULL,
  rol TEXT NOT NULL,
  texto TEXT NOT NULL,
  fecha TEXT NOT NULL,
  UNIQUE (sesion, indice)
);
CREATE VIRTUAL TABLE IF NOT EXISTS mensajes_fts USING fts5(
  texto, content = 'mensajes', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS mensajes_ai AFTER INSERT ON mensajes BEGIN
  INSERT INTO mensajes_fts (rowid, texto) VALUES (new.id, new.texto);
END;
CREATE TRIGGER IF NOT EXISTS mensajes_ad AFTER DELETE ON mensajes BEGIN
  INSERT INTO mensajes_fts (mensajes_fts, rowid, texto) VALUES ('delete', old.id, old.texto);
END;
CREATE TRIGGER IF NOT EXISTS mensajes_au AFTER UPDATE ON mensajes BEGIN
  INSERT INTO mensajes_fts (mensajes_fts, rowid, texto) VALUES ('delete', old.id, old.texto);
  INSERT INTO mensajes_fts (rowid, texto) VALUES (new.id, new.texto);
END;
`;

const CONSULTA = `
WITH c AS (
  SELECT m.sesion, m.rol, m.fecha, s.titulo, COALESCE(s.cwd, '') AS cwd,
         snippet(mensajes_fts, 0, '«', '»', '…', 20) AS fragmento, bm25(mensajes_fts) AS puntos
  FROM mensajes_fts JOIN mensajes m ON m.id = mensajes_fts.rowid LEFT JOIN sesiones s ON s.id = m.sesion
  WHERE mensajes_fts MATCH ? AND m.sesion <> ?
)
SELECT * FROM (SELECT c.*, ROW_NUMBER() OVER (PARTITION BY sesion ORDER BY puntos, fecha DESC) AS n FROM c)
WHERE n <= ${POR_SESION} ORDER BY puntos, fecha DESC LIMIT ?`;

interface Fila {
  sesion: string;
  rol: ResultadoBusqueda["rol"];
  fecha: string;
  titulo: string | null;
  cwd: string;
  fragmento: string;
}

export class IndiceSesiones {
  private db: Database;

  /** `rutaDb` null: base en memoria (tests). */
  constructor(rutaDb: string | null) {
    if (rutaDb) mkdirSync(dirname(rutaDb), { recursive: true });
    this.db = new Database(rutaDb ?? ":memory:", { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.db.exec(ESQUEMA);
  }

  registrarSesion(info: { sesionId: string; titulo?: string; cwd: string; actualizada: string }): void {
    this.db
      .query(
        "INSERT INTO sesiones (id, titulo, cwd, actualizada) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET " +
          "titulo = COALESCE(excluded.titulo, titulo), cwd = excluded.cwd, actualizada = excluded.actualizada",
      )
      .run(info.sesionId, info.titulo ?? null, info.cwd, info.actualizada);
  }

  /** Indexa un mensaje; no hace nada si ya estaba (sesion, indice) o no tiene texto. Devuelve si lo añadió. */
  indexar(sesionId: string, indice: number, mensaje: Mensaje, fecha: string): boolean {
    const texto = textoIndexable(mensaje);
    if (!texto) return false;
    const r = this.db
      .query("INSERT INTO mensajes (sesion, indice, rol, texto, fecha) VALUES (?, ?, ?, ?, ?) ON CONFLICT (sesion, indice) DO NOTHING")
      .run(sesionId, indice, mensaje.rol, texto, fecha);
    return r.changes > 0;
  }

  /**
   * Añade lo que falte de los JSONL de `dirSesiones` y quita las sesiones cuyo fichero ya no existe.
   * Se salta los ficheros que no han cambiado de tamaño desde la última vez. Devuelve los mensajes añadidos.
   */
  sincronizar(dirSesiones: string): number {
    let nombres: string[];
    try {
      nombres = readdirSync(dirSesiones).filter((f) => /^[\w-]+\.jsonl$/.test(f));
    } catch {
      return 0;
    }
    const conocidas = new Map(
      this.db
        .query("SELECT id, bytes FROM sesiones")
        .all()
        .map((r) => [(r as { id: string }).id, (r as { bytes: number | null }).bytes]),
    );
    const presentes = new Set(nombres.map((f) => f.slice(0, -6)));
    for (const id of conocidas.keys()) if (!presentes.has(id)) this.borrarSesion(id);

    let nuevos = 0;
    for (const f of nombres) {
      const id = f.slice(0, -6);
      const ruta = join(dirSesiones, f);
      let tamano: number;
      let mtime: string;
      try {
        const info = statSync(ruta);
        tamano = info.size;
        mtime = info.mtime.toISOString();
      } catch {
        continue;
      }
      if (conocidas.get(id) === tamano) continue;
      let texto: string;
      try {
        texto = readFileSync(ruta, "utf8");
      } catch {
        continue;
      }
      nuevos += this.db.transaction(() => this.sincronizarSesion(id, texto, tamano, mtime))();
    }
    return nuevos;
  }

  borrarSesion(id: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM mensajes WHERE sesion = ?").run(id);
      this.db.query("DELETE FROM sesiones WHERE id = ?").run(id);
    })();
  }

  /**
   * Busca en lenguaje normal: cada palabra se busca tal cual (sin sintaxis FTS5) y, si tiene 3 letras o más,
   * también como prefijo. Primero exige todas las palabras y, si no hay nada, basta con alguna.
   * Como mucho 3 resultados por sesión; `excluir` deja fuera una sesión (la actual).
   */
  buscar(consulta: string, limite = 20, excluir?: string): ResultadoBusqueda[] {
    const terminos = consulta
      .split(/\s+/)
      .map((p) => p.replace(/"/g, ""))
      .filter((p) => /[\p{L}\p{N}]/u.test(p))
      .slice(0, 16)
      .map((p) => `"${p}"${p.replace(/[^\p{L}\p{N}]/gu, "").length >= 3 ? "*" : ""}`);
    if (!terminos.length) return [];
    const n = Math.max(1, Math.min(100, Math.floor(limite)));
    let filas = this.consultar(terminos.join(" "), n, excluir);
    if (!filas.length && terminos.length > 1) filas = this.consultar(terminos.join(" OR "), n, excluir);
    return filas.map((f) => ({
      sesionId: f.sesion,
      ...(f.titulo ? { titulo: f.titulo } : {}),
      cwd: f.cwd,
      fecha: f.fecha,
      rol: f.rol,
      fragmento: f.fragmento.replace(/\s+/g, " ").trim(),
    }));
  }

  cerrar(): void {
    this.db.close();
  }

  private consultar(expresion: string, limite: number, excluir?: string): Fila[] {
    try {
      return this.db.query(CONSULTA).all(expresion, excluir ?? "", limite) as Fila[];
    } catch {
      return [];
    }
  }

  private sincronizarSesion(id: string, texto: string, tamano: number, mtime: string): number {
    let inicio: { cwd?: unknown; creada?: unknown } | undefined;
    let titulo: string | undefined;
    let primero: string | undefined;
    const mensajes: { mensaje: Mensaje; fecha?: unknown }[] = [];
    for (const bruta of texto.split("\n")) {
      if (!bruta.trim()) continue;
      let l: any;
      try {
        l = JSON.parse(bruta);
      } catch {
        continue; // última línea a medio escribir
      }
      if (l?.tipo === "inicio") inicio = l;
      else if (l?.tipo === "ajuste" && typeof l.titulo === "string" && l.titulo) titulo = l.titulo;
      else if (l?.tipo === "mensaje" && l.mensaje && typeof l.mensaje === "object") {
        mensajes.push({ mensaje: l.mensaje, fecha: l.fecha });
        if (primero === undefined && l.mensaje.rol === "usuario" && typeof l.mensaje.texto === "string") primero = l.mensaje.texto;
      }
    }
    if (!inicio || typeof inicio.cwd !== "string") return 0;
    const respaldo = typeof inicio.creada === "string" ? inicio.creada : mtime;
    this.registrarSesion({ sesionId: id, titulo: titulo ?? tituloDe(primero), cwd: inicio.cwd, actualizada: mtime });
    let nuevos = 0;
    for (const [i, { mensaje, fecha }] of mensajes.entries()) {
      if (this.indexar(id, i, mensaje, typeof fecha === "string" ? fecha : respaldo)) nuevos++;
    }
    this.db.query("UPDATE sesiones SET bytes = ? WHERE id = ?").run(tamano, id);
    return nuevos;
  }
}

/** Texto que se indexa: el de usuario, asistente y resumen; de una herramienta, nombre, resumen y el principio del resultado. */
function textoIndexable(m: Mensaje): string {
  if (m.rol !== "herramienta") return typeof m.texto === "string" ? m.texto.trim().slice(0, MAX_TEXTO) : "";
  const cabeza = (m.resultado ?? "").split("\n", LINEAS_RESULTADO).join("\n").slice(0, 600);
  return [m.resumen ? `${m.nombre}: ${m.resumen}` : m.nombre, cabeza].join("\n").trim();
}

function tituloDe(texto?: string): string | undefined {
  if (!texto) return undefined;
  const t = texto.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t || undefined;
}

export function herramientaBuscarSesiones(i: IndiceSesiones): Herramienta {
  return definir({
    nombre: "buscar_sesiones",
    descripcion:
      "Busca por texto en las conversaciones anteriores con el usuario (todas las sesiones guardadas, de cualquier carpeta). " +
      "Úsala para recordar algo de conversaciones anteriores: una decisión, un error que ya se resolvió, un comando, un nombre. " +
      "Escribe palabras clave; no distingue tildes ni mayúsculas, y si ningún mensaje tiene todas, devuelve los que tengan alguna. " +
      "Devuelve el id, el título, la fecha y un fragmento con la coincidencia entre «».",
    nivel: "lectura",
    parametros: z.object({
      consulta: z.string().min(1).describe("Palabras que buscar"),
      limite: z.number().int().min(1).max(50).optional().describe("Máximo de resultados (20 por defecto)"),
    }),
    resumen: ({ consulta }) => consulta,
    async ejecutar({ consulta, limite }, ctx) {
      const resultados = i.buscar(consulta, limite ?? 20, ctx.sesionId);
      if (!resultados.length) return `Sin resultados para «${consulta}» en otras sesiones.`;
      return [
        `${resultados.length} ${resultados.length === 1 ? "resultado" : "resultados"} para «${consulta}»:`,
        ...resultados.map(
          (r, n) =>
            `${n + 1}. ${r.fecha.slice(0, 10)} · ${r.titulo ?? "(sin título)"} · sesión ${r.sesionId} · ${r.cwd}\n   ${r.rol}: ${r.fragmento}`,
        ),
      ].join("\n");
    },
  });
}
