/**
 * Lo que Aquiles sabe de un perfil: memoria, skills e índice de búsqueda de sesiones.
 * Reúne sus herramientas y los ganchos que los conectan a las sesiones: el system prompt
 * de una sesión nueva lleva la memoria y el índice de skills, y cada mensaje guardado se indexa.
 */
import { join } from "node:path";
import type { Evento } from "@aquiles/protocolo";
import { herramientaBuscarSesiones, IndiceSesiones } from "./busqueda";
import type { Herramienta } from "./herramientas/herramienta";
import { herramientaMemoria, Memoria } from "./memoria";
import { type GanchosSesiones, info, sistemaBase } from "./sesiones";
import { AlmacenSkills, herramientasSkills } from "./skills";

export interface Conocimiento {
  memoria: Memoria;
  skills: AlmacenSkills;
  indice: IndiceSesiones;
  /** memoria, ver_skill, gestionar_skill y buscar_sesiones. */
  herramientas: Herramienta<any>[];
  ganchos: GanchosSesiones;
  cerrar(): void;
}

export interface OpcionesConocimiento {
  /** Carpeta del perfil; null = todo en memoria (tests). */
  perfil: string | null;
  /** Carpeta de las skills que vienen con Aquiles. */
  incluidas?: string | null;
  emitir?: (e: Evento) => void;
  log?: (mensaje: string) => void;
}

export function abrirConocimiento(o: OpcionesConocimiento): Conocimiento {
  const emitir = o.emitir ?? (() => {});
  const log = o.log ?? (() => {});
  const memoria = new Memoria(o.perfil);
  const skills = new AlmacenSkills({ perfil: o.perfil, incluidas: o.incluidas ?? null });
  const indice = new IndiceSesiones(o.perfil ? join(o.perfil, "busqueda.db") : null);
  if (o.perfil) {
    const n = indice.sincronizar(join(o.perfil, "sesiones"));
    if (n) log(`índice de búsqueda: ${n} mensajes nuevos`);
  }

  return {
    memoria,
    skills,
    indice,
    herramientas: [
      herramientaMemoria(memoria, (destino, cwd) => emitir({ tipo: "memoria.actualizada", destino, ...(cwd ? { cwd } : {}) })),
      ...herramientasSkills(skills, () => emitir({ tipo: "skills.actualizadas" })),
      herramientaBuscarSesiones(indice),
    ],
    ganchos: {
      sistema: (cwd) => [sistemaBase(cwd), memoria.seccionPrompt(cwd), skills.seccionPrompt(cwd)].filter(Boolean).join("\n\n"),
      alAnotar: (s, m, ordinal, fecha) => {
        // El índice es una ayuda: si falla, la sesión sigue y `sincronizar` lo repara al arrancar.
        try {
          indice.registrarSesion(info(s));
          indice.indexar(s.id, ordinal, m, fecha);
        } catch (e) {
          log(`índice de búsqueda: ${e instanceof Error ? e.message : e}`);
        }
      },
    },
    cerrar: () => indice.cerrar(),
  };
}
