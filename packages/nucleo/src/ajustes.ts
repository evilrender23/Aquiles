/** Ajustes por defecto del perfil (`<perfil>/ajustes.json`), que usan las sesiones nuevas. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ajustes, AjustesHerramientas } from "@aquiles/protocolo";

type Parcial<T> = { [K in keyof T]?: T[K] extends object ? Parcial<T[K]> : T[K] };
export type CambiosAjustes = Parcial<Ajustes>;

export const AJUSTES_HERRAMIENTAS: AjustesHerramientas = {
  navegador: false,
  terminal: { entorno: "local", imagen: "oven/bun:debian" },
  guardian: { activo: false },
};

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Mezcla `cambios` sobre `base` por niveles; lo indefinido no cambia nada y el texto vacío borra el campo opcional. */
function mezclar<T>(base: T, cambios: unknown): T {
  if (!esObjeto(base) || !esObjeto(cambios)) return base;
  const r: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(cambios)) {
    if (v === undefined) continue;
    if (v === "") delete r[k];
    else r[k] = esObjeto(v) && esObjeto(r[k]) ? mezclar(r[k], v) : v;
  }
  return r as T;
}

export class AlmacenAjustes {
  /** `ruta` null: solo en memoria (tests). */
  constructor(private ruta: string | null, private porDefecto: Ajustes) {}

  leer(): Ajustes {
    let guardados: unknown = {};
    if (this.ruta && existsSync(this.ruta)) {
      try {
        guardados = JSON.parse(readFileSync(this.ruta, "utf8"));
      } catch {}
    }
    return mezclar(structuredClone(this.porDefecto), guardados);
  }

  guardar(cambios: CambiosAjustes): Ajustes {
    const nuevos = mezclar(this.leer(), cambios);
    if (this.ruta) {
      mkdirSync(dirname(this.ruta), { recursive: true });
      writeFileSync(this.ruta, `${JSON.stringify(nuevos, null, 2)}\n`);
    }
    return nuevos;
  }
}
