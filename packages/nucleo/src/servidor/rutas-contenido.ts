/**
 * Lo que se lee y se guarda: memoria y alma, aprendizaje, búsqueda de sesiones y ficheros, documentos, artefactos,
 * adjuntos y estadísticas.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { codigosError } from "@aquiles/protocolo";
import { carpetaAdjuntos, leerAdjunto } from "../adjuntos";
import { FicheroYaExiste, guardarArtefacto } from "../artefactos";
import { calcularEstadisticas } from "../estadisticas";
import { buscarFicheros } from "../menciones";
import type { ContextoServidor, Manejadores } from "./contexto";
import { comoParams, FalloRpc, fallo } from "./errores";

export function rutasContenido(c: ContextoServidor) {
  const { o, emitir, memoria, registro, aprendizaje, indice, skills, vistas, obtener } = c;
  return {
    "adjuntos.leer": async ({ sesionId, id }) => {
      const s = obtener(sesionId);
      const adjunto = await leerAdjunto(carpetaAdjuntos(o.perfil, s.id), id);
      if (!adjunto) throw new FalloRpc(codigosError.paramsInvalidos, `No hay ningún adjunto ${id} en esta sesión`);
      return adjunto;
    },
    "memoria.leer": ({ cwd }) => ({
      usuario: memoria.leer("usuario"),
      agente: memoria.leer("agente"),
      ...(cwd ? { proyecto: { ...memoria.leer("proyecto", cwd), cwd } } : {}),
      alma: memoria.alma(),
    }),
    "memoria.guardar": ({ destino, cwd, entradas }) => {
      const antes = comoParams(() => memoria.leer(destino, cwd)).entradas;
      const bloque = comoParams(() => memoria.guardar(destino, entradas, cwd));
      emitir({ tipo: "memoria.actualizada", destino, ...(destino === "proyecto" && cwd ? { cwd } : {}) });
      const anadidas = bloque.entradas.filter((e) => !antes.includes(e)).length;
      const quitadas = antes.filter((e) => !bloque.entradas.includes(e)).length;
      if (anadidas || quitadas) {
        registro.anotar({ origen: { tipo: "manual" }, tipo: "memoria", resumen: `Memoria de ${destino} editada en la app (+${anadidas} −${quitadas})` });
        emitir({ tipo: "aprendizaje.actualizado" });
      }
      return bloque;
    },
    "memoria.alma": ({ texto }) => {
      const guardado = memoria.guardarAlma(texto);
      emitir({ tipo: "memoria.actualizada", destino: "alma" });
      return { texto: guardado };
    },
    "artefactos.vista": ({ tipo, contenido }) => ({ ruta: vistas.publicar(tipo, contenido) }),
    "artefactos.guardar": async ({ sesionId, nombre, contenido, sobrescribir }) => {
      const s = obtener(sesionId);
      try {
        return { ruta: await guardarArtefacto(s.cwd, nombre, contenido, sobrescribir) };
      } catch (e) {
        throw fallo(e, e instanceof FicheroYaExiste ? codigosError.yaExiste : codigosError.paramsInvalidos);
      }
    },
    "buscar.sesiones": ({ consulta, limite }) => ({ resultados: indice.buscar(consulta, limite) }),
    // Documentos para el visor y «Guardar como Word» (documentos.ts, importado al primer uso).
    "documentos.leer": async ({ ruta }) => {
      const { leerDocumento } = await import("../documentos");
      try {
        return await leerDocumento(ruta);
      } catch (e) {
        throw fallo(e);
      }
    },
    "documentos.exportar": async ({ sesionId, nombre, markdown, sobrescribir }) => {
      const s = obtener(sesionId);
      const { exportarDocumento } = await import("../documentos");
      try {
        return { ruta: await exportarDocumento(s.cwd, nombre, markdown, sobrescribir) };
      } catch (e) {
        throw fallo(e, e instanceof FicheroYaExiste ? codigosError.yaExiste : codigosError.paramsInvalidos);
      }
    },
    "ficheros.buscar": async ({ cwd, consulta, limite }) => {
      if (!isAbsolute(cwd) || !existsSync(cwd)) throw new FalloRpc(codigosError.paramsInvalidos, `No existe la carpeta ${cwd}`);
      return { ficheros: await buscarFicheros(cwd, consulta, limite) };
    },
    "aprendizaje.listar": ({ todas }) => ({ propuestas: registro.propuestas(todas) }),
    "aprendizaje.decidir": ({ id, decision }) => {
      if (!registro.propuesta(id)) throw new FalloRpc(codigosError.paramsInvalidos, `No existe la propuesta ${id}`);
      return aprendizaje.decidir(id, decision);
    },
    "aprendizaje.revisar": ({ sesionId }) => {
      const s = obtener(sesionId);
      if (aprendizaje.revisando(s.id)) return { iniciada: false };
      void aprendizaje.revisar(s, { completa: true });
      return { iniciada: true };
    },
    "aprendizaje.historial": ({ limite }) => ({ entradas: registro.historial(limite) }),
    "estadisticas.leer": ({ dias }) =>
      calcularEstadisticas({
        dirSesiones: o.perfil ? join(o.perfil, "sesiones") : null,
        historial: registro.historial(10_000),
        registroSkills: Object.fromEntries(skills.listar(undefined, { archivadas: true }).map((x) => [x.nombre, { usos: x.usos }])),
        dias,
      }),
  } satisfies Partial<Manejadores>;
}
