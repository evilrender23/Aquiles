/**
 * Errores que el servidor devuelve al cliente con su código JSON-RPC, y cómo se traducen a ellos los errores
 * de datos del resto del núcleo (memoria, skills, plugins, cron, canales).
 */
import { codigosError } from "@aquiles/protocolo";
import { ErrorCanal } from "../canales/canal";
import { ErrorCron } from "../cron-expresiones";
import { ErrorMemoria } from "../memoria";
import { ErrorPlugin } from "../plugins";
import { ErrorSkill } from "../skills";

export class FalloRpc extends Error {
  constructor(readonly codigo: number, mensaje: string, readonly datos?: unknown) {
    super(mensaje);
  }
}

export const fallo = (e: unknown, codigo: number = codigosError.paramsInvalidos) =>
  new FalloRpc(codigo, e instanceof Error ? e.message : String(e));

/** Los errores de memoria y skills son de datos del cliente (límite, nombre, formato). */
export const comoParams = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof ErrorMemoria) throw new FalloRpc(codigosError.paramsInvalidos, e.message, e.exceso === undefined ? undefined : { exceso: e.exceso });
    if (e instanceof ErrorSkill) throw new FalloRpc(codigosError.paramsInvalidos, e.message);
    throw e;
  }
};

/** Igual para plugins, cron y canales, que pueden ser asíncronos. */
export const comoParamsAsync = async <T>(f: () => Promise<T> | T): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ErrorPlugin || e instanceof ErrorCron || e instanceof ErrorCanal) {
      throw new FalloRpc(codigosError.paramsInvalidos, e.message);
    }
    throw e;
  }
};
