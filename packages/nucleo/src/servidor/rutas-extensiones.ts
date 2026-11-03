/** Lo que amplía al agente: servidores MCP, plugins y skills (con su archivo, versiones y curador). */
import { codigosError } from "@aquiles/protocolo";
import type { ContextoServidor, Manejadores } from "./contexto";
import { comoParams, comoParamsAsync, FalloRpc } from "./errores";

export function rutasExtensiones(c: ContextoServidor) {
  const { emitir, mcp, plugins, skills, curar } = c;

  /** Cambio en las skills que la app tiene que ver. */
  function conCambioDeSkills<T>(f: () => T): T {
    const r = comoParams(f);
    emitir({ tipo: "skills.actualizadas" });
    return r;
  }

  return {
    "skills.listar": ({ cwd, archivadas }) => ({ skills: skills.listar(cwd, { archivadas }) }),
    "skills.leer": ({ nombre, cwd }) => {
      const skill = skills.leer(nombre, cwd, { archivadas: true });
      if (!skill) throw new FalloRpc(codigosError.paramsInvalidos, `No existe la skill ${nombre}`);
      return skill;
    },
    "skills.ajustar": ({ nombre, activa, cwd }) => {
      const skill = comoParams(() => skills.ajustar(nombre, activa, cwd));
      emitir({ tipo: "skills.actualizadas" });
      return skill;
    },
    "skills.fijar": ({ nombre, fijada }) => conCambioDeSkills(() => skills.fijar(nombre, fijada)),
    "skills.archivar": ({ nombre }) => conCambioDeSkills(() => skills.archivar(nombre)),
    "skills.restaurar": ({ nombre }) => conCambioDeSkills(() => skills.restaurar(nombre)),
    "skills.versiones": ({ nombre }) => ({ versiones: comoParams(() => skills.versiones(nombre)) }),
    "skills.restaurarVersion": ({ nombre, version }) => conCambioDeSkills(() => skills.restaurarVersion(nombre, version)),
    "skills.curar": () => ({ cambios: curar() }),
    "mcp.listar": () => ({ servidores: mcp.listar() }),
    "mcp.guardar": (p) =>
      mcp.guardar(p).catch((e) => {
        throw new FalloRpc(codigosError.paramsInvalidos, e instanceof Error ? e.message : String(e));
      }),
    "mcp.borrar": async ({ nombre }) => {
      await mcp.borrar(nombre);
      return { borrado: true as const };
    },
    "mcp.reconectar": ({ nombre }) => mcp.reconectar(nombre),
    "plugins.listar": () => ({ plugins: plugins.listar() }),
    "plugins.activar": ({ nombre, activo }) => comoParamsAsync(() => plugins.activar(nombre, activo)),
  } satisfies Partial<Manejadores>;
}
