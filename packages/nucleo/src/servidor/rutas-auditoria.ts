/** Registro de auditoría de una sesión y deshacer los cambios de ficheros de un turno (auditoria.ts). */
import { codigosError } from "@aquiles/protocolo";
import type { ContextoServidor, Manejadores } from "./contexto";
import { FalloRpc } from "./errores";

export function rutasAuditoria(c: ContextoServidor) {
  const { auditoria, obtener, log } = c;
  return {
    "auditoria.leer": ({ sesionId }) => {
      obtener(sesionId);
      return { entradas: auditoria.leer(sesionId) };
    },
    "cambios.listar": ({ sesionId }) => {
      obtener(sesionId);
      return { turnos: auditoria.cambios(sesionId) };
    },
    "cambios.deshacer": ({ sesionId, turno }) => {
      const s = obtener(sesionId);
      // Con un turno en marcha, el agente podría estar escribiendo esos mismos ficheros.
      if (s.turno) throw new FalloRpc(codigosError.sesionOcupada, "Espera a que acabe el turno (o páralo) para deshacer cambios");
      try {
        const r = auditoria.deshacer(sesionId, turno);
        log(`deshecho el turno ${turno} de ${sesionId}: ${r.restaurados.length} restaurados, ${r.conflictos.length} sin tocar`);
        return r;
      } catch (e) {
        throw new FalloRpc(codigosError.paramsInvalidos, e instanceof Error ? e.message : String(e));
      }
    },
  } satisfies Partial<Manejadores>;
}
