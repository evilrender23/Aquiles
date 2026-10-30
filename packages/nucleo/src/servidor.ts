/**
 * Servidor JSON-RPC 2.0 por WebSocket, solo en 127.0.0.1.
 * Exige el token en `?token=` y, si el cliente es un navegador (envía Origin),
 * que el origen sea el de la app. También pide cosas a la interfaz (aprobaciones,
 * preguntas) y espera su respuesta.
 */
import { timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codigosError,
  metodos,
  RUTA_RPC,
  VERSION_PROTOCOLO,
  type ErrorRpc,
  type Evento,
  type NombreMetodo,
  type NombrePeticionCliente,
  type PeticionesCliente,
  type PeticionRpc,
  type RespuestaRpc,
  type Resultados,
} from "@aquiles/protocolo";
import type { ServerWebSocket } from "bun";
import { AlmacenAjustes } from "./ajustes";
import { ejecutarTurno } from "./bucle";
import { abrirConocimiento } from "./conocimiento";
import type { Herramienta } from "./herramientas/herramienta";
import { cerrarEstadoSesion } from "./herramientas/index";
import { ErrorMemoria } from "./memoria";
import { crearProveedor, establecerClave, listarProveedores } from "./proveedores/index";
import { AlmacenSesiones, historial, info, type Sesion } from "./sesiones";
import { ErrorSkill } from "./skills";
import type { Proveedor } from "./tipos";

export const ORIGENES_APP = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:1420"];

export interface OpcionesServidor {
  puerto: number;
  token: string;
  /** Proveedor por defecto si el perfil aún no tiene ajustes. */
  proveedor: string;
  modelo?: string;
  /** Crea proveedores por nombre y modelo (inyectable en tests). */
  fabrica?: (nombre: string, modelo?: string) => Proveedor;
  herramientas: readonly Herramienta<any>[];
  cwdPorDefecto: string;
  version: string;
  /** Carpeta del perfil (sesiones/, salidas/, memoria/, skills/, ajustes.json); null = solo memoria. */
  perfil: string | null;
  /** Carpeta de las skills que vienen con Aquiles. */
  skillsIncluidas?: string | null;
  /** Ofrecer el proveedor simulado en proveedores.listar (desarrollo). */
  incluirSimulado?: boolean;
  origenesPermitidos?: readonly string[];
  log?: (mensaje: string) => void;
}

export interface Servidor {
  puerto: number;
  detener(): Promise<void>;
}

class FalloRpc extends Error {
  constructor(readonly codigo: number, mensaje: string, readonly datos?: unknown) {
    super(mensaje);
  }
}

export function iniciarServidor(o: OpcionesServidor): Servidor {
  const clientes = new Set<ServerWebSocket<unknown>>();
  const origenes = o.origenesPermitidos ?? ORIGENES_APP;
  const log = o.log ?? (() => {});
  const pendientes = new Map<string, { ok: (r: unknown) => void; mal: (e: Error) => void }>();
  let siguiente = 0;

  const emitir = (evento: Evento) => {
    const texto = JSON.stringify({ jsonrpc: "2.0", method: "evento", params: evento });
    for (const ws of clientes) ws.send(texto);
  };

  const conocimiento = abrirConocimiento({ perfil: o.perfil, incluidas: o.skillsIncluidas, emitir, log });
  const { memoria, skills, indice } = conocimiento;
  const herramientas = [...o.herramientas, ...conocimiento.herramientas];
  const sesiones = new AlmacenSesiones(o.perfil ? join(o.perfil, "sesiones") : null, o.proveedor, conocimiento.ganchos);
  /** Los errores de memoria y skills son de datos del cliente (límite, nombre, formato). */
  const comoParams = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof ErrorMemoria) throw new FalloRpc(codigosError.paramsInvalidos, e.message, e.exceso === undefined ? undefined : { exceso: e.exceso });
      if (e instanceof ErrorSkill) throw new FalloRpc(codigosError.paramsInvalidos, e.message);
      throw e;
    }
  };

  /** Pide algo a la interfaz; responde el primer cliente que conteste. */
  const pedirCliente = <M extends NombrePeticionCliente>(
    metodo: M,
    params: PeticionesCliente[M]["params"],
    senal: AbortSignal,
  ): Promise<PeticionesCliente[M]["resultado"]> => {
    if (clientes.size === 0) return Promise.reject(new Error("No hay ninguna interfaz conectada para responder"));
    const id = `n${++siguiente}`;
    return new Promise((ok, mal) => {
      pendientes.set(id, { ok: ok as (r: unknown) => void, mal });
      senal.addEventListener("abort", () => pendientes.delete(id) && mal(new Error("turno parado")), { once: true });
      const texto = JSON.stringify({ jsonrpc: "2.0", id, method: metodo, params });
      for (const ws of clientes) ws.send(texto);
    });
  };

  const salidas = o.perfil ? join(o.perfil, "salidas") : null;
  const ajustes = new AlmacenAjustes(o.perfil ? join(o.perfil, "ajustes.json") : null, {
    proveedor: o.proveedor,
    ...(o.modelo ? { modelo: o.modelo } : {}),
    modoAprobacion: "preguntar-ejecutar",
    carpeta: o.cwdPorDefecto,
  });
  const fabrica = o.fabrica ?? ((nombre: string, modelo?: string) => crearProveedor(nombre, { modelo }));
  /** Un proveedor por (nombre, modelo), compartido entre sesiones. */
  const proveedores = new Map<string, Proveedor>();
  const proveedorDe = (s: Sesion): Proveedor => {
    const clave = `${s.proveedor}|${s.modelo ?? ""}`;
    let p = proveedores.get(clave);
    if (!p) {
      try {
        p = fabrica(s.proveedor, s.modelo);
      } catch (e) {
        throw new FalloRpc(codigosError.paramsInvalidos, e instanceof Error ? e.message : String(e));
      }
      proveedores.set(clave, p);
    }
    return p;
  };
  const obtener = (sesionId: string): Sesion => {
    const s = sesiones.obtener(sesionId);
    if (!s) throw new FalloRpc(codigosError.sesionNoExiste, `No existe la sesión ${sesionId}`);
    return s;
  };
  const avisar = (s: Sesion) => emitir({ tipo: "sesion.actualizada", sesion: info(s) });

  const manejadores: { [M in NombreMetodo]: (params: any) => Resultados[M] | Promise<Resultados[M]> } = {
    "nucleo.info": () => {
      const a = ajustes.leer();
      return { version: o.version, protocolo: VERSION_PROTOCOLO, proveedor: a.proveedor, ...(a.modelo ? { modelo: a.modelo } : {}) };
    },
    "proveedores.listar": async () => ({ proveedores: await listarProveedores(o.incluirSimulado) }),
    "ajustes.leer": () => ajustes.leer(),
    "ajustes.guardar": (cambios) => ajustes.guardar(cambios),
    "ajustes.clave": ({ proveedor, clave }) => {
      try {
        establecerClave(proveedor, clave);
      } catch (e) {
        throw new FalloRpc(codigosError.paramsInvalidos, e instanceof Error ? e.message : String(e));
      }
      for (const [k, p] of proveedores) {
        if (!k.startsWith(`${proveedor}|`)) continue;
        void p.cerrar?.();
        proveedores.delete(k);
      }
      return { ok: true };
    },
    "sesion.crear": ({ cwd, modoAprobacion, proveedor, modelo }) => {
      const a = ajustes.leer();
      const elegido = proveedor ?? a.proveedor;
      const s = sesiones.crear(cwd ?? a.carpeta, {
        modoAprobacion: modoAprobacion ?? a.modoAprobacion,
        proveedor: elegido,
        modelo: modelo ?? (proveedor ? undefined : a.modelo),
      });
      log(`sesión ${s.id} en ${s.cwd} (${s.proveedor}${s.modelo ? ` ${s.modelo}` : ""})`);
      avisar(s);
      return info(s);
    },
    "sesion.listar": () => ({ sesiones: sesiones.listar() }),
    "sesion.reanudar": ({ sesionId }) => {
      const s = obtener(sesionId);
      return { ...info(s), historial: historial(s) };
    },
    "sesion.ajustar": ({ sesionId, proveedor, modelo, modoAprobacion }) => {
      const s = obtener(sesionId);
      sesiones.ajustar(s, { proveedor, modelo: modelo ?? (proveedor && proveedor !== s.proveedor ? "" : undefined), modoAprobacion });
      avisar(s);
      return info(s);
    },
    "sesion.renombrar": ({ sesionId, titulo }) => {
      const s = obtener(sesionId);
      sesiones.ajustar(s, { titulo: titulo.trim() });
      indice.registrarSesion(info(s));
      avisar(s);
      return info(s);
    },
    "sesion.borrar": async ({ sesionId }) => {
      const s = sesiones.obtener(sesionId);
      if (s) {
        s.turno?.abort();
        await cerrarEstadoSesion(s.estado);
        for (const p of proveedores.values()) await p.cerrar?.(s.id);
      }
      if (!sesiones.borrar(sesionId)) throw new FalloRpc(codigosError.sesionNoExiste, `No existe la sesión ${sesionId}`);
      indice.borrarSesion(sesionId);
      return { borrada: true };
    },
    "prompt.enviar": ({ sesionId, texto }) => {
      const s = obtener(sesionId);
      if (s.turno) throw new FalloRpc(codigosError.sesionOcupada, "La sesión ya está trabajando; usa prompt.steer");
      const proveedor = proveedorDe(s);
      const usuario = { rol: "usuario" as const, texto };
      s.mensajes.push(usuario);
      sesiones.anotar(s, usuario);
      const control = new AbortController();
      s.turno = control;
      avisar(s);
      void ejecutarTurno({
        sesionId: s.id,
        cwd: s.cwd,
        sistema: s.sistema,
        mensajes: s.mensajes,
        proveedor,
        herramientas,
        emitir,
        senal: control.signal,
        entorno: s,
        alAnadir: (m) => sesiones.anotar(s, m),
        alCompactar: () => sesiones.anotarCompactacion(s),
        aprobar: async (p) => (await pedirCliente("aprobacion.pedir", { sesionId: s.id, ...p }, control.signal)).decision,
        preguntar: async (p) => (await pedirCliente("pregunta.hacer", { sesionId: s.id, ...p }, control.signal)).respuesta,
        guardarSalida: salidas
          ? async (id, contenido) => {
              const dir = join(salidas, s.id);
              await mkdir(dir, { recursive: true });
              const ruta = join(dir, `${id.replace(/[^\w-]/g, "_")}.txt`);
              await writeFile(ruta, contenido);
              return ruta;
            }
          : undefined,
      })
        .then((r) => log(`turno ${s.id}: ${r.motivo}${r.error ? ` (${r.error})` : ""}`))
        .finally(() => {
          if (s.turno === control) s.turno = undefined;
          avisar(s);
        });
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
    "memoria.leer": ({ cwd }) => ({
      usuario: memoria.leer("usuario"),
      agente: memoria.leer("agente"),
      ...(cwd ? { proyecto: { ...memoria.leer("proyecto", cwd), cwd } } : {}),
      alma: memoria.alma(),
    }),
    "memoria.guardar": ({ destino, cwd, entradas }) => {
      const bloque = comoParams(() => memoria.guardar(destino, entradas, cwd));
      emitir({ tipo: "memoria.actualizada", destino, ...(destino === "proyecto" && cwd ? { cwd } : {}) });
      return bloque;
    },
    "memoria.alma": ({ texto }) => {
      const guardado = memoria.guardarAlma(texto);
      emitir({ tipo: "memoria.actualizada", destino: "alma" });
      return { texto: guardado };
    },
    "skills.listar": ({ cwd }) => ({ skills: skills.listar(cwd) }),
    "skills.leer": ({ nombre, cwd }) => {
      const skill = skills.leer(nombre, cwd);
      if (!skill) throw new FalloRpc(codigosError.paramsInvalidos, `No existe la skill ${nombre}`);
      return skill;
    },
    "skills.ajustar": ({ nombre, activa, cwd }) => {
      const skill = comoParams(() => skills.ajustar(nombre, activa, cwd));
      emitir({ tipo: "skills.actualizadas" });
      return skill;
    },
    "buscar.sesiones": ({ consulta, limite }) => ({ resultados: indice.buscar(consulta, limite) }),
  };

  const atender = async (bruto: string): Promise<RespuestaRpc | undefined> => {
    let peticion: PeticionRpc & { result?: unknown; error?: ErrorRpc };
    try {
      peticion = JSON.parse(bruto);
    } catch {
      return { jsonrpc: "2.0", id: null, error: { code: codigosError.parse, message: "JSON no válido" } };
    }
    const id = peticion?.id ?? null;
    // Respuesta del cliente a una petición nuestra.
    if (typeof id === "string" && pendientes.has(id) && peticion.method === undefined) {
      const p = pendientes.get(id)!;
      pendientes.delete(id);
      if (peticion.error) p.mal(new Error(peticion.error.message));
      else p.ok(peticion.result);
      return undefined;
    }
    if (peticion?.jsonrpc !== "2.0" || typeof peticion.method !== "string") {
      return { jsonrpc: "2.0", id, error: { code: codigosError.peticionInvalida, message: "Petición JSON-RPC no válida" } };
    }
    const esquema = (metodos as Record<string, (typeof metodos)[NombreMetodo]>)[peticion.method];
    if (!esquema) return id === null ? undefined : error(id, codigosError.metodoNoExiste, `Método desconocido: ${peticion.method}`);
    const params = esquema.safeParse(peticion.params ?? {});
    if (!params.success) return error(id, codigosError.paramsInvalidos, "Parámetros no válidos", params.error.issues);
    try {
      const result = await manejadores[peticion.method as NombreMetodo](params.data);
      return id === null ? undefined : { jsonrpc: "2.0", id, result };
    } catch (e) {
      if (e instanceof FalloRpc) return error(id, e.codigo, e.message, e.datos);
      log(`error en ${peticion.method}: ${e instanceof Error ? e.stack : e}`);
      return error(id, codigosError.interno, e instanceof Error ? e.message : String(e));
    }
  };

  const servidor = Bun.serve({
    hostname: "127.0.0.1",
    port: o.puerto,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== RUTA_RPC) return new Response("No encontrado", { status: 404 });
      const origen = req.headers.get("origin");
      if (origen && !origenes.includes(origen)) {
        log(`rechazado origen ${origen}`);
        return new Response("Origen no permitido", { status: 403 });
      }
      if (!mismoToken(url.searchParams.get("token") ?? "", o.token)) return new Response("Token no válido", { status: 401 });
      if (srv.upgrade(req, { data: undefined })) return undefined;
      return new Response("Se esperaba WebSocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        clientes.add(ws);
        log(`cliente conectado (${clientes.size})`);
      },
      close(ws) {
        clientes.delete(ws);
      },
      async message(ws, datos) {
        const respuesta = await atender(typeof datos === "string" ? datos : new TextDecoder().decode(datos));
        if (respuesta) ws.send(JSON.stringify(respuesta));
      },
    },
  });

  return {
    puerto: servidor.port ?? o.puerto,
    async detener() {
      for (const s of sesiones.enCurso()) {
        s.turno?.abort();
        await cerrarEstadoSesion(s.estado);
      }
      servidor.stop(true);
      for (const p of proveedores.values()) await p.cerrar?.();
      conocimiento.cerrar();
    },
  };
}

function error(id: number | string | null, code: number, message: string, data?: unknown): RespuestaRpc {
  const e: ErrorRpc = { code, message, ...(data === undefined ? {} : { data }) };
  return { jsonrpc: "2.0", id, error: e };
}

function mismoToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
