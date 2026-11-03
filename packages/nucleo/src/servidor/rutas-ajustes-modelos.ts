/** Ajustes del perfil y claves de proveedores; modelos locales (buscar y descargar de Hugging Face, motor llama.cpp). */
import { codigosError } from "@aquiles/protocolo";
import { buscarModelos, directorioModelos, ficherosRepo, modelosLocales as modelosDescargados } from "../locales/huggingface";
import { instalarLlamaCpp, rutaLlamaServer } from "../locales/llamacpp";
import { establecerClave, esfuerzoValido, servidorLlamaCpp, VARIABLES_CLAVE } from "../proveedores/index";
import type { ContextoServidor, Manejadores } from "./contexto";
import { FalloRpc, fallo } from "./errores";

export function rutasAjustesModelos(c: ContextoServidor) {
  const { log, emitir, ajustes, pasarela, descargas, proveedores, soltarNavegador } = c;
  return {
    "ajustes.leer": () => ajustes.leer(),
    "ajustes.guardar": async (cambios) => {
      const antes = ajustes.leer();
      if (cambios.esfuerzo !== undefined || cambios.proveedor !== undefined || cambios.modelo !== undefined) {
        const proveedor = cambios.proveedor ?? antes.proveedor;
        const modelo = cambios.modelo ?? (cambios.proveedor && cambios.proveedor !== antes.proveedor ? "" : antes.modelo);
        cambios.esfuerzo = (await esfuerzoValido(proveedor, modelo || undefined, cambios.esfuerzo ?? antes.esfuerzo)) ?? "";
      }
      const r = ajustes.guardar(cambios);
      if (!r.herramientas.navegador) soltarNavegador();
      return r;
    },
    "ajustes.clave": ({ proveedor, clave }) => {
      try {
        establecerClave(proveedor, clave);
      } catch (e) {
        throw new FalloRpc(codigosError.paramsInvalidos, e instanceof Error ? e.message : String(e));
      }
      if (proveedor in VARIABLES_CLAVE) {
        for (const [k, p] of proveedores) {
          if (!k.startsWith(`${proveedor}|`)) continue;
          void p.cerrar?.();
          proveedores.delete(k);
        }
      }
      // Un secreto de canal: el canal vuelve a arrancar con él.
      const canal = ({ telegram: "telegram", discord: "discord", slack: "slack", "slack-app": "slack", correo: "correo" } as const)[
        proveedor as "telegram"
      ];
      if (canal) void pasarela.reiniciar(canal).catch((e) => log(`canal ${canal}: ${e instanceof Error ? e.message : e}`));
      return { ok: true };
    },
    "modelos.buscar": async ({ consulta }) => {
      try {
        return { resultados: await buscarModelos(consulta, { token: process.env.HF_TOKEN || undefined }) };
      } catch (e) {
        throw fallo(e, codigosError.interno);
      }
    },
    "modelos.repo": async ({ repo }) => {
      try {
        return await ficherosRepo(repo, { token: process.env.HF_TOKEN || undefined });
      } catch (e) {
        throw fallo(e);
      }
    },
    "modelos.descargar": async ({ repo, fichero, proyector }) => {
      let info: Awaited<ReturnType<typeof ficherosRepo>>;
      try {
        info = await ficherosRepo(repo, { token: process.env.HF_TOKEN || undefined });
      } catch (e) {
        throw fallo(e);
      }
      const f = info.ficheros.find((x) => x.nombre === fichero);
      if (!f) throw new FalloRpc(codigosError.paramsInvalidos, `${repo} no tiene ${fichero}`);
      const pr = proyector ? info.proyectores.find((x) => x.nombre === proyector) : undefined;
      if (proyector && !pr) throw new FalloRpc(codigosError.paramsInvalidos, `${repo} no tiene ${proyector}`);
      return { id: descargas.iniciar(repo, f, pr) };
    },
    "modelos.cancelar": ({ id }) => ({ cancelada: descargas.cancelar(id) }),
    "modelos.borrar": async ({ id }) => {
      // En Windows un fichero abierto no se puede borrar: si llama.cpp lo tiene cargado, se para antes.
      if (servidorLlamaCpp().modeloCargado === id) await servidorLlamaCpp().parar();
      try {
        await descargas.borrar(id);
      } catch (e) {
        throw fallo(e);
      }
      emitir({ tipo: "modelos.actualizados" });
      return { borrado: true as const };
    },
    "modelos.listar": async () => {
      const ruta = rutaLlamaServer();
      const cargado = servidorLlamaCpp().modeloCargado;
      return {
        carpeta: directorioModelos(),
        locales: (await modelosDescargados()).map((m) => ({ id: m.id, repo: m.repo, nombre: m.nombre, bytes: m.bytes, imagenes: Boolean(m.proyector) })),
        descargas: descargas.listar(),
        motor: { ...(ruta ? { ruta } : {}), ...(cargado ? { cargado } : {}) },
      };
    },
    "modelos.instalarMotor": async () => {
      try {
        await instalarLlamaCpp((t) => log(`winget: ${t.trim()}`));
      } catch (e) {
        throw fallo(e, codigosError.interno);
      }
      const ruta = rutaLlamaServer();
      if (!ruta) throw new FalloRpc(codigosError.interno, "winget terminó pero no aparece llama-server");
      emitir({ tipo: "modelos.actualizados" });
      return { ruta };
    },
  } satisfies Partial<Manejadores>;
}
