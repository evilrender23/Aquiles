/** El núcleo y su entorno: info y proveedores, comandos, voz, perfiles y copias de seguridad. */
import { codigosError, VERSION_PROTOCOLO } from "@aquiles/protocolo";
import { crearCopia, crearPerfil, listarCopias, listarPerfiles, prepararRestauracion } from "../perfiles";
import { listarProveedores } from "../proveedores/index";
import type { ContextoServidor, Manejadores } from "./contexto";
import { FalloRpc } from "./errores";

export function rutasSistema(c: ContextoServidor) {
  const { o, emitir, ajustes, comandos, voz, obtener } = c;

  function necesitaPerfil(): { nombre: string; datos: string } {
    if (!o.nombrePerfil || !o.datos) throw new FalloRpc(codigosError.metodoNoExiste, "Este núcleo no tiene perfil en disco");
    return { nombre: o.nombrePerfil, datos: o.datos };
  }

  return {
    "nucleo.info": () => {
      const a = ajustes.leer();
      return { version: o.version, protocolo: VERSION_PROTOCOLO, proveedor: a.proveedor, ...(a.modelo ? { modelo: a.modelo } : {}) };
    },
    "proveedores.listar": async () => ({ proveedores: await listarProveedores(o.incluirSimulado) }),
    "comandos.listar": ({ sesionId }) => ({ comandos: comandos.listar(sesionId ? obtener(sesionId) : undefined) }),
    "voz.estado": () => voz.estado(),
    "voz.dictar": async ({ segundos }) => ({ texto: await voz.dictar(segundos) }),
    "voz.leer": async ({ texto }) => {
      await voz.leer(texto);
      return { ok: true as const };
    },
    "voz.parar": () => {
      voz.parar();
      return { ok: true as const };
    },
    "perfiles.listar": () => ({ actual: necesitaPerfil().nombre, perfiles: listarPerfiles(necesitaPerfil().datos) }),
    "perfiles.crear": ({ nombre }) => {
      try {
        return crearPerfil(nombre, necesitaPerfil().datos);
      } catch (e) {
        throw new FalloRpc(codigosError.paramsInvalidos, e instanceof Error ? e.message : String(e));
      }
    },
    "copias.listar": () => ({ copias: listarCopias(necesitaPerfil().datos) }),
    "copias.crear": () => crearCopia(necesitaPerfil().nombre, necesitaPerfil().datos),
    "copias.restaurar": async ({ nombre }) => {
      const { datos } = necesitaPerfil();
      if (!o.reiniciar) throw new FalloRpc(codigosError.metodoNoExiste, "Este núcleo no se puede reiniciar solo");
      try {
        await prepararRestauracion(nombre, datos);
      } catch (e) {
        throw new FalloRpc(codigosError.paramsInvalidos, e instanceof Error ? e.message : String(e));
      }
      emitir({ tipo: "nucleo.reinicio", motivo: `restaurar ${nombre}` });
      // Deja salir la respuesta y el evento antes de cerrar.
      setTimeout(() => o.reiniciar?.(`restaurar ${nombre}`), 300);
      return { reiniciando: true };
    },
  } satisfies Partial<Manejadores>;
}
