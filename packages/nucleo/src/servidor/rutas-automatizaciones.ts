/** Lo que trabaja sin que nadie escriba: tareas programadas (cron), canales de mensajería y objetivos de sesión. */
import { interpretar, proximas } from "../cron-expresiones";
import type { ContextoServidor, Manejadores } from "./contexto";
import { comoParamsAsync } from "./errores";

export function rutasAutomatizaciones(c: ContextoServidor) {
  const { programador, pasarela, objetivos, obtener, vista, avisar } = c;
  return {
    "cron.listar": () => ({ tareas: programador.listar() }),
    "cron.crear": (p) => comoParamsAsync(() => programador.crear(p)),
    "cron.editar": (p) => comoParamsAsync(() => programador.editar(p)),
    "cron.borrar": ({ id }) => comoParamsAsync(() => {
      programador.borrar(id);
      return { borrada: true as const };
    }),
    "cron.ejecutar": ({ id }) => comoParamsAsync(() => ({ ejecucionId: programador.ejecutar(id) })),
    "cron.ejecuciones": ({ id, limite }) => ({ ejecuciones: programador.ejecuciones(id, limite) }),
    "cron.interpretar": ({ cuando }) => comoParamsAsync(() => {
      const e = interpretar(cuando);
      return { descripcion: e.descripcion, repite: e.repite, proximas: proximas(e, new Date()).map((d) => d.toISOString()) };
    }),
    "canales.listar": () => ({ canales: pasarela.listar() }),
    "canales.configurar": ({ canal, opciones }) => comoParamsAsync(() => pasarela.configurar(canal, opciones)),
    "canales.emparejar": ({ canal }) => comoParamsAsync(() => pasarela.emparejar(canal)),
    "canales.desemparejar": ({ canal, chatId }) => comoParamsAsync(() => pasarela.desemparejar(canal, chatId)),
    "canales.probar": ({ canal, destino }) =>
      comoParamsAsync(async () => {
        await pasarela.probar(canal, destino);
        return { ok: true as const };
      }),
    "sesion.objetivo": ({ sesionId, objetivo, maxIntentos }) => {
      const s = obtener(sesionId);
      objetivos.fijar(s, objetivo, maxIntentos);
      avisar(s);
      return vista(s);
    },
  } satisfies Partial<Manejadores>;
}
