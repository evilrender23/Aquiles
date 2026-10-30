/** Ajustes por defecto del perfil (`<perfil>/ajustes.json`), que usan las sesiones nuevas. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ajustes } from "@aquiles/protocolo";

export class AlmacenAjustes {
  /** `ruta` null: solo en memoria (tests). */
  constructor(private ruta: string | null, private porDefecto: Ajustes) {}

  leer(): Ajustes {
    if (!this.ruta || !existsSync(this.ruta)) return { ...this.porDefecto };
    try {
      return { ...this.porDefecto, ...(JSON.parse(readFileSync(this.ruta, "utf8")) as Partial<Ajustes>) };
    } catch {
      return { ...this.porDefecto };
    }
  }

  guardar(cambios: Partial<Ajustes>): Ajustes {
    const limpios = Object.fromEntries(Object.entries(cambios).filter(([, v]) => v !== undefined));
    const nuevos: Ajustes = { ...this.leer(), ...limpios };
    if (nuevos.modelo === "") delete nuevos.modelo;
    if (this.ruta) {
      mkdirSync(dirname(this.ruta), { recursive: true });
      writeFileSync(this.ruta, `${JSON.stringify(nuevos, null, 2)}\n`);
    }
    return nuevos;
  }
}
