/**
 * Servidor JSON-RPC 2.0 por WebSocket, solo en 127.0.0.1.
 * Exige el token en `?token=` y, si el cliente es un navegador (envía Origin),
 * que el origen sea el de la app.
 */
import { timingSafeEqual } from "node:crypto";
import {
  codigosError,
  metodos,
  RUTA_RPC,
  VERSION_PROTOCOLO,
  type ErrorRpc,
  type Evento,
  type NombreMetodo,
  type PeticionRpc,
  type RespuestaRpc,
  type Resultados,
} from "@aquiles/protocolo";
import type { ServerWebSocket } from "bun";
import { ejecutarTurno } from "./bucle";
import type { Herramienta } from "./herramientas/herramienta";
import { Sesiones } from "./sesiones";
import type { Proveedor } from "./tipos";

export const ORIGENES_APP = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:1420"];

export interface OpcionesServidor {
  puerto: number;
  token: string;
  proveedor: Proveedor;
  herramientas: readonly Herramienta<any>[];
  cwdPorDefecto: string;
  version: string;
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
  const sesiones = new Sesiones();
  const clientes = new Set<ServerWebSocket<unknown>>();
  const origenes = o.origenesPermitidos ?? ORIGENES_APP;
  const log = o.log ?? (() => {});

  const emitir = (evento: Evento) => {
    const texto = JSON.stringify({ jsonrpc: "2.0", method: "evento", params: evento });
    for (const ws of clientes) ws.send(texto);
  };

  const manejadores: { [M in NombreMetodo]: (params: any) => Resultados[M] | Promise<Resultados[M]> } = {
    "nucleo.info": () => ({ version: o.version, protocolo: VERSION_PROTOCOLO, proveedor: o.proveedor.nombre }),
    "sesion.crear": ({ cwd }) => {
      const s = sesiones.crear(cwd ?? o.cwdPorDefecto);
      log(`sesión ${s.id} en ${s.cwd}`);
      return { sesionId: s.id, cwd: s.cwd };
    },
    "prompt.enviar": ({ sesionId, texto }) => {
      const s = sesiones.obtener(sesionId);
      if (!s) throw new FalloRpc(codigosError.sesionNoExiste, `No existe la sesión ${sesionId}`);
      if (s.turno) throw new FalloRpc(codigosError.sesionOcupada, "La sesión ya está trabajando");
      s.mensajes.push({ rol: "usuario", texto });
      const control = new AbortController();
      s.turno = control;
      void ejecutarTurno({
        sesionId: s.id,
        cwd: s.cwd,
        sistema: s.sistema,
        mensajes: s.mensajes,
        proveedor: o.proveedor,
        herramientas: o.herramientas,
        emitir,
        senal: control.signal,
      })
        .then((r) => log(`turno ${s.id}: ${r.motivo}${r.error ? ` (${r.error})` : ""}`))
        .finally(() => {
          if (s.turno === control) s.turno = undefined;
        });
      return { aceptado: true };
    },
    "prompt.parar": ({ sesionId }) => {
      const s = sesiones.obtener(sesionId);
      if (!s?.turno) return { parado: false };
      s.turno.abort();
      return { parado: true };
    },
  };

  const atender = async (bruto: string): Promise<RespuestaRpc | undefined> => {
    let peticion: PeticionRpc;
    try {
      peticion = JSON.parse(bruto);
    } catch {
      return { jsonrpc: "2.0", id: null, error: { code: codigosError.parse, message: "JSON no válido" } };
    }
    const id = peticion?.id ?? null;
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
      servidor.stop(true);
      await o.proveedor.cerrar?.();
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
