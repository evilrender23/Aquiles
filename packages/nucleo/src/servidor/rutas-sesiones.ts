/** Sesiones y turnos: crear, listar, reanudar, ajustar, renombrar y borrar sesiones; enviar, reconducir y parar prompts. */
import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { codigosError } from "@aquiles/protocolo";
import { carpetaAdjuntos } from "../adjuntos";
import { cerrarEstadoSesion } from "../herramientas/index";
import { conMenciones } from "../menciones";
import { esfuerzoValido } from "../proveedores/index";
import { historial, info } from "../sesiones";
import type { ContextoServidor, Manejadores } from "./contexto";
import { FalloRpc } from "./errores";

export function rutasSesiones(c: ContextoServidor) {
  const { o, ajustes, sesiones, indice, objetivos, comandos, proveedores, claveProveedor, obtener, vista, avisar, crearSesion } = c;
  const { guardarEn, ejecutarConAdjuntos, aprobarEnApp, preguntarEnApp } = c;
  return {
    "sesion.crear": async ({ cwd, modoAprobacion, proveedor, modelo, esfuerzo }) => {
      // Una carpeta que no existe solo fallaría en el primer turno: mejor decirlo al crear la sesión.
      if (cwd !== undefined && (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()))
        throw new FalloRpc(codigosError.paramsInvalidos, `No existe la carpeta ${cwd}`);
      const a = ajustes.leer();
      const nivel = esfuerzo ? await esfuerzoValido(proveedor ?? a.proveedor, modelo ?? (proveedor ? undefined : a.modelo), esfuerzo) : undefined;
      return vista(crearSesion(cwd, { modoAprobacion, proveedor, modelo, ...(nivel ? { esfuerzo: nivel } : {}) }));
    },
    "sesion.listar": () => ({ sesiones: sesiones.listar() }),
    "sesion.reanudar": ({ sesionId }) => {
      const s = obtener(sesionId);
      return { ...vista(s), historial: historial(s) };
    },
    "sesion.ajustar": async ({ sesionId, proveedor, modelo, esfuerzo, modoAprobacion }) => {
      const s = obtener(sesionId);
      const nuevoModelo = modelo ?? (proveedor && proveedor !== s.proveedor ? "" : undefined);
      const destinoProveedor = proveedor ?? s.proveedor;
      const destinoModelo = nuevoModelo === undefined ? s.modelo : nuevoModelo || undefined;
      // Con otro modelo, el nivel elegido se vuelve a comprobar: el nuevo puede no admitirlo.
      const pedido = esfuerzo ?? (proveedor !== undefined || modelo !== undefined ? s.esfuerzo : undefined);
      const nivel = pedido === undefined ? undefined : ((await esfuerzoValido(destinoProveedor, destinoModelo, pedido)) ?? "");
      const antes = claveProveedor(s.proveedor, s.modelo, s.esfuerzo);
      sesiones.ajustar(s, { proveedor, modelo: nuevoModelo, ...(nivel === undefined ? {} : { esfuerzo: nivel }), modoAprobacion });
      // El proveedor anterior puede tener un proceso de esta sesión (claude, agy): se cierra.
      if (antes !== claveProveedor(s.proveedor, s.modelo, s.esfuerzo) && !s.turno) await proveedores.get(antes)?.cerrar?.(s.id);
      avisar(s);
      return vista(s);
    },
    "sesion.renombrar": ({ sesionId, titulo }) => {
      const s = obtener(sesionId);
      sesiones.ajustar(s, { titulo: titulo.trim() });
      indice.registrarSesion(info(s));
      avisar(s);
      return vista(s);
    },
    "sesion.borrar": async ({ sesionId }) => {
      const s = sesiones.obtener(sesionId);
      if (s) {
        s.turno?.abort();
        await cerrarEstadoSesion(s.estado);
        for (const p of proveedores.values()) await p.cerrar?.(s.id);
      }
      if (!sesiones.borrar(sesionId)) throw new FalloRpc(codigosError.sesionNoExiste, `No existe la sesión ${sesionId}`);
      if (/^[\w-]+$/.test(sesionId)) await rm(carpetaAdjuntos(o.perfil, sesionId), { recursive: true, force: true });
      indice.borrarSesion(sesionId);
      c.auditoria.borrar(sesionId);
      objetivos.fijar({ id: sesionId }, null);
      return { borrada: true };
    },
    "prompt.enviar": async ({ sesionId, texto, adjuntos }) => {
      const s = obtener(sesionId);
      if (s.turno) throw new FalloRpc(codigosError.sesionOcupada, "La sesión ya está trabajando; usa prompt.steer");
      // Cada `@ruta` que es un fichero de la carpeta de la sesión va como adjunto.
      const todos = await conMenciones(texto, s.cwd, adjuntos ?? []);
      const guardados = todos.length ? await guardarEn(s, todos) : undefined;
      // `/nombre …`: un comando de Aquiles o de una skill (comandos.ts); si no es ninguno, va como texto.
      if (!comandos.ejecutar(s, texto, guardados)) {
        void ejecutarConAdjuntos(s, texto, { aprobar: aprobarEnApp(s), preguntar: preguntarEnApp(s) }, guardados);
      }
      return { aceptado: true };
    },
    "prompt.steer": ({ sesionId, texto }) => {
      const s = sesiones.obtener(sesionId);
      if (!s?.turno) throw new FalloRpc(codigosError.sinTurno, "No hay ningún turno en marcha; usa prompt.enviar");
      s.steer.push(texto);
      return { encolado: true };
    },
    "prompt.parar": ({ sesionId }) => {
      const s = sesiones.obtener(sesionId);
      if (!s?.turno) return { parado: false };
      s.turno.abort();
      return { parado: true };
    },
  } satisfies Partial<Manejadores>;
}
