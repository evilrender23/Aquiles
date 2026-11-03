/**
 * Registro de auditoría y deshacer cambios, por sesión, en <perfil>/auditoria/:
 * - <sesión>.jsonl: una línea por herramienta ejecutada (o denegada): qué, quién la aprobó, si salió bien, cuánto
 *   tardó y qué ficheros tocó.
 * - <sesión>.cambios.jsonl y <sesión>/<turno>/: antes de que una herramienta escriba un fichero, una copia de cómo
 *   estaba (o que no existía) y, después, la huella de cómo quedó. Con eso se deshacen los cambios de ficheros de un
 *   turno entero; un fichero que alguien cambió después no se pisa (se avisa). Lo que hace la terminal no se puede
 *   deshacer: queda en el registro, pero sin copia.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CambiosTurno, EntradaAuditoria, ResultadoDeshacer } from "@aquiles/protocolo";

/** Ficheros más grandes no se copian (y su cambio no se puede deshacer). */
const MAX_BYTES_COPIA = 20 * 1024 * 1024;

type LineaCambio =
  | { tipo: "turno"; turno: string; fecha: string; pedido: string }
  | { tipo: "antes"; turno: string; ruta: string; existia: boolean; copia?: string; hash?: string; grande?: boolean }
  | { tipo: "despues"; turno: string; ruta: string; hash: string | null }
  | { tipo: "deshecho"; turno: string; fecha: string };

const huella = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const huellaDe = (ruta: string): string | null => {
  try {
    return existsSync(ruta) && statSync(ruta).isFile() ? huella(readFileSync(ruta)) : null;
  } catch {
    return null;
  }
};
const nombreSeguro = (id: string) => id.replace(/[^\w.-]/g, "_");

export class Auditoria {
  /** Rutas ya copiadas en cada turno: la primera copia es la buena (la de antes del turno). */
  private copiadas = new Map<string, Set<string>>();

  /** `dir` null: no guarda nada (tests sin perfil). */
  constructor(private dir: string | null) {}

  private fichero(sesionId: string, sufijo: string): string | null {
    return this.dir ? join(this.dir, `${nombreSeguro(sesionId)}${sufijo}`) : null;
  }

  private anadir(ruta: string | null, linea: unknown): void {
    if (!ruta) return;
    mkdirSync(dirname(ruta), { recursive: true });
    appendFileSync(ruta, `${JSON.stringify(linea)}\n`);
  }

  private lineas<T>(ruta: string | null): T[] {
    if (!ruta || !existsSync(ruta)) return [];
    return readFileSync(ruta, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return [];
        }
      });
  }

  registrar(sesionId: string, entrada: EntradaAuditoria): void {
    this.anadir(this.fichero(sesionId, ".jsonl"), entrada);
  }

  leer(sesionId: string): EntradaAuditoria[] {
    return this.lineas<EntradaAuditoria>(this.fichero(sesionId, ".jsonl"));
  }

  /** Empieza un turno: con qué pedido, para enseñarlo junto a sus cambios. */
  empezarTurno(sesionId: string, turno: string, pedido: string): void {
    this.anadir(this.fichero(sesionId, ".cambios.jsonl"), { tipo: "turno", turno, fecha: new Date().toISOString(), pedido: pedido.slice(0, 200) });
  }

  /** Antes de escribir: copia de cada fichero (solo la primera vez en el turno). */
  antes(sesionId: string, turno: string, rutas: readonly string[]): void {
    const cambios = this.fichero(sesionId, ".cambios.jsonl");
    if (!cambios || !this.dir) return;
    const clave = `${sesionId}|${turno}`;
    const hechas = this.copiadas.get(clave) ?? new Set<string>();
    this.copiadas.set(clave, hechas);
    for (const ruta of rutas) {
      if (hechas.has(ruta)) continue;
      hechas.add(ruta);
      let linea: LineaCambio;
      if (!existsSync(ruta)) {
        linea = { tipo: "antes", turno, ruta, existia: false };
      } else if (!statSync(ruta).isFile() || statSync(ruta).size > MAX_BYTES_COPIA) {
        linea = { tipo: "antes", turno, ruta, existia: true, grande: true };
      } else {
        const bytes = readFileSync(ruta);
        const copia = join(nombreSeguro(sesionId), nombreSeguro(turno), `${hechas.size}.bin`);
        mkdirSync(dirname(join(this.dir, copia)), { recursive: true });
        writeFileSync(join(this.dir, copia), bytes);
        linea = { tipo: "antes", turno, ruta, existia: true, copia, hash: huella(bytes) };
      }
      this.anadir(cambios, linea);
    }
  }

  /** Después de escribir: cómo quedó cada fichero (null si ya no está). */
  despues(sesionId: string, turno: string, rutas: readonly string[]): void {
    for (const ruta of rutas) this.anadir(this.fichero(sesionId, ".cambios.jsonl"), { tipo: "despues", turno, ruta, hash: huellaDe(ruta) });
  }

  /** Los turnos con cambios de ficheros, del más reciente al más antiguo. */
  cambios(sesionId: string): CambiosTurno[] {
    const turnos = new Map<string, { fecha: string; pedido: string; deshecho: boolean; ficheros: Map<string, { antes: Extract<LineaCambio, { tipo: "antes" }>; despues?: string | null }> }>();
    const de = (t: string) => {
      let x = turnos.get(t);
      if (!x) turnos.set(t, (x = { fecha: "", pedido: "", deshecho: false, ficheros: new Map() }));
      return x;
    };
    for (const l of this.lineas<LineaCambio>(this.fichero(sesionId, ".cambios.jsonl"))) {
      const t = de(l.turno);
      if (l.tipo === "turno") Object.assign(t, { fecha: l.fecha, pedido: l.pedido });
      else if (l.tipo === "antes") t.ficheros.set(l.ruta, { antes: l });
      else if (l.tipo === "despues") {
        const f = t.ficheros.get(l.ruta);
        if (f) f.despues = l.hash;
      } else if (l.tipo === "deshecho") t.deshecho = true;
    }
    return [...turnos]
      .map(([turno, t]) => ({
        turno,
        fecha: t.fecha,
        pedido: t.pedido,
        deshecho: t.deshecho,
        ficheros: [...t.ficheros.values()]
          // Solo lo que de verdad cambió en el turno.
          .filter((f) => f.despues !== undefined && f.despues !== (f.antes.hash ?? null))
          .map((f) => ({
            ruta: f.antes.ruta,
            accion: !f.antes.existia ? ("creado" as const) : f.despues === null ? ("borrado" as const) : ("modificado" as const),
            deshacible: !f.antes.grande,
          })),
      }))
      .filter((t) => t.ficheros.length > 0)
      .reverse();
  }

  /** Deja los ficheros del turno como estaban antes; los que alguien cambió después se dejan y se avisa. */
  deshacer(sesionId: string, turno: string): ResultadoDeshacer {
    const lineas = this.lineas<LineaCambio>(this.fichero(sesionId, ".cambios.jsonl")).filter((l) => l.turno === turno);
    if (!this.dir || lineas.length === 0) throw new Error("Ese turno no tiene cambios que deshacer");
    if (lineas.some((l) => l.tipo === "deshecho")) throw new Error("Ese turno ya se deshizo");
    const ficheros = new Map<string, { antes: Extract<LineaCambio, { tipo: "antes" }>; despues?: string | null }>();
    for (const l of lineas) {
      if (l.tipo === "antes") ficheros.set(l.ruta, { antes: l });
      else if (l.tipo === "despues" && ficheros.has(l.ruta)) ficheros.get(l.ruta)!.despues = l.hash;
    }
    const r: ResultadoDeshacer = { restaurados: [], conflictos: [] };
    for (const { antes, despues } of ficheros.values()) {
      if (despues === undefined || despues === (antes.hash ?? null)) continue;
      if (antes.grande) {
        r.conflictos.push({ ruta: antes.ruta, motivo: "era demasiado grande para guardar una copia" });
        continue;
      }
      if (huellaDe(antes.ruta) !== despues) {
        r.conflictos.push({ ruta: antes.ruta, motivo: "ha cambiado después de este turno; no se toca" });
        continue;
      }
      try {
        if (!antes.existia) unlinkSync(antes.ruta);
        else {
          mkdirSync(dirname(antes.ruta), { recursive: true });
          writeFileSync(antes.ruta, readFileSync(join(this.dir, antes.copia!)));
        }
        r.restaurados.push(antes.ruta);
      } catch (e) {
        r.conflictos.push({ ruta: antes.ruta, motivo: e instanceof Error ? e.message : String(e) });
      }
    }
    this.anadir(this.fichero(sesionId, ".cambios.jsonl"), { tipo: "deshecho", turno, fecha: new Date().toISOString() });
    return r;
  }

  /** Al borrar la sesión: su registro, sus cambios y sus copias. */
  borrar(sesionId: string): void {
    if (!this.dir) return;
    for (const sufijo of [".jsonl", ".cambios.jsonl"]) rmSync(join(this.dir, `${nombreSeguro(sesionId)}${sufijo}`), { force: true });
    rmSync(join(this.dir, nombreSeguro(sesionId)), { recursive: true, force: true });
  }
}
