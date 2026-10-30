/**
 * Lo que Aquiles sabe de un perfil: memoria, skills, índice de búsqueda de sesiones y registro de lo aprendido.
 * Reúne sus herramientas y los ganchos que los conectan a las sesiones: el system prompt de una sesión nueva lleva
 * la memoria y el índice de skills, cada mensaje guardado se indexa y lo que el agente guarda queda anotado con su origen.
 */
import { join } from "node:path";
import type { Evento, OrigenAprendizaje } from "@aquiles/protocolo";
import { RegistroAprendizaje } from "./aprendizaje";
import { herramientaBuscarSesiones, IndiceSesiones } from "./busqueda";
import type { Herramienta } from "./herramientas/herramienta";
import { herramientaMemoria, Memoria } from "./memoria";
import { type GanchosSesiones, info, sistemaBase } from "./sesiones";
import { AlmacenSkills, herramientasSkills } from "./skills";

export interface Conocimiento {
  memoria: Memoria;
  skills: AlmacenSkills;
  indice: IndiceSesiones;
  registro: RegistroAprendizaje;
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
  /** Origen de lo que guarda el agente en una sesión (por defecto, la propia sesión). */
  origen?: (sesionId: string) => OrigenAprendizaje;
}

export function abrirConocimiento(o: OpcionesConocimiento): Conocimiento {
  const emitir = o.emitir ?? (() => {});
  const log = o.log ?? (() => {});
  const origen = o.origen ?? ((sesionId: string): OrigenAprendizaje => ({ tipo: "sesion", sesionId }));
  const memoria = new Memoria(o.perfil);
  const skills = new AlmacenSkills({ perfil: o.perfil, incluidas: o.incluidas ?? null });
  const indice = new IndiceSesiones(o.perfil ? join(o.perfil, "busqueda.db") : null);
  const registro = new RegistroAprendizaje(o.perfil ? join(o.perfil, "aprendizaje") : null);
  if (o.perfil) {
    const n = indice.sincronizar(join(o.perfil, "sesiones"));
    if (n) log(`índice de búsqueda: ${n} mensajes nuevos`);
  }
  const anotar = (e: Parameters<RegistroAprendizaje["anotar"]>[0]) => {
    registro.anotar(e);
    emitir({ tipo: "aprendizaje.actualizado" });
  };

  return {
    memoria,
    skills,
    indice,
    registro,
    herramientas: [
      herramientaMemoria(memoria, (destino, cwd, detalle) => {
        emitir({ tipo: "memoria.actualizada", destino, ...(cwd ? { cwd } : {}) });
        if (detalle) anotar({ origen: origen(detalle.sesionId), tipo: "memoria", resumen: `Memoria de ${destino}: ${detalle.hechas.join("; ")}` });
      }),
      ...herramientasSkills(skills, (detalle) => {
        emitir({ tipo: "skills.actualizadas" });
        if (!detalle) return;
        const que = detalle.accion === "crear" ? "Skill nueva" : detalle.accion === "parchear" ? "Skill corregida" : "Fichero de skill";
        anotar({ origen: origen(detalle.sesionId), tipo: "skill", resumen: `${que} «${detalle.nombre}»${detalle.accion === "crear" ? "" : ` (${detalle.fichero})`}` });
      }),
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
