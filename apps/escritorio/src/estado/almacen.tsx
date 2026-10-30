/**
 * Estado de la app: conexión con el núcleo, sesiones, conversaciones abiertas, peticiones pendientes
 * (permisos y preguntas), proveedores y ajustes. Un reducer puro + acciones que hablan con el núcleo.
 */
import type { Ajustes, Evento, InfoProveedor, InfoSesion, MensajeHistorial, ModoAprobacion } from "@aquiles/protocolo";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { datosConexion } from "../conexion";
import { borrarClaveLlavero, guardarClaveLlavero } from "../plataforma/claves";
import { ClienteRpc } from "../rpc";
import { anadirAviso, anadirUsuario, aplicarEvento, conversacionVacia, desdeHistorial } from "./conversacion";
import type { Conversacion, EstadoApp, EstadoConexion, Pendiente, Vista } from "./tipos";

type Accion =
  | { tipo: "conexion"; estado: EstadoConexion; error?: string }
  | { tipo: "inicial"; sesiones: InfoSesion[]; ajustes: Ajustes }
  | { tipo: "proveedores"; proveedores: InfoProveedor[] }
  | { tipo: "ajustes"; ajustes: Ajustes }
  | { tipo: "vista"; vista: Vista; activa?: string }
  | { tipo: "sesion"; sesion: InfoSesion }
  | { tipo: "sesion.borrada"; sesionId: string }
  | { tipo: "cargando"; sesionId: string }
  | { tipo: "historial"; sesion: InfoSesion; historial: MensajeHistorial[] }
  | { tipo: "evento"; evento: Evento; ahora: number }
  | { tipo: "usuario"; sesionId: string; texto: string; steer: boolean; ahora: number }
  | { tipo: "aviso"; sesionId: string; nivel: "aviso" | "error"; texto: string; fin?: boolean }
  | { tipo: "pendiente"; pendiente: Pendiente }
  | { tipo: "pendiente.resuelto"; id: string; ahora: number };

const inicial: EstadoApp = { conexion: "conectando", vista: "inicio", sesiones: {}, conversaciones: {}, pendientes: [], proveedores: [] };

function conConversacion(s: EstadoApp, sesionId: string, f: (c: Conversacion) => Conversacion): EstadoApp {
  const c = s.conversaciones[sesionId] ?? conversacionVacia();
  return { ...s, conversaciones: { ...s.conversaciones, [sesionId]: f(c) } };
}

function reducir(s: EstadoApp, a: Accion): EstadoApp {
  switch (a.tipo) {
    case "conexion":
      if (a.estado === "conectada") return { ...s, conexion: a.estado, errorConexion: undefined };
      // Las peticiones del núcleo mueren con la conexión.
      return { ...s, conexion: a.estado, errorConexion: a.error, pendientes: a.estado === "caida" ? [] : s.pendientes };
    case "inicial": {
      const sesiones = Object.fromEntries(a.sesiones.map((x) => [x.sesionId, x]));
      const activa = s.activa && sesiones[s.activa] ? s.activa : undefined;
      // Tras reconectar lo cargado puede estar desfasado: se vuelve a pedir al abrir.
      return { ...s, conexion: "conectada", sesiones, ajustes: a.ajustes, conversaciones: {}, activa, vista: activa || s.vista === "ajustes" ? s.vista : "inicio" };
    }
    case "proveedores":
      return { ...s, proveedores: a.proveedores };
    case "ajustes":
      return { ...s, ajustes: a.ajustes };
    case "vista":
      return { ...s, vista: a.vista, activa: a.vista === "inicio" ? undefined : (a.activa ?? s.activa) };
    case "sesion":
      return { ...s, sesiones: { ...s.sesiones, [a.sesion.sesionId]: a.sesion } };
    case "sesion.borrada": {
      const { [a.sesionId]: _s, ...sesiones } = s.sesiones;
      const { [a.sesionId]: _c, ...conversaciones } = s.conversaciones;
      const eraActiva = s.activa === a.sesionId;
      return {
        ...s,
        sesiones,
        conversaciones,
        pendientes: s.pendientes.filter((p) => p.sesionId !== a.sesionId),
        activa: eraActiva ? undefined : s.activa,
        vista: eraActiva && s.vista === "conversacion" ? "inicio" : s.vista,
      };
    }
    case "cargando":
      return conConversacion(s, a.sesionId, (c) => ({ ...c, cargando: true }));
    case "historial":
      return conConversacion({ ...s, sesiones: { ...s.sesiones, [a.sesion.sesionId]: a.sesion } }, a.sesion.sesionId, (c) => ({
        ...c,
        cargando: false,
        elementos: desdeHistorial(a.historial),
      }));
    case "evento": {
      const e = a.evento;
      if (e.tipo === "sesion.actualizada") return { ...s, sesiones: { ...s.sesiones, [e.sesion.sesionId]: e.sesion } };
      const pendientes = e.tipo === "turno.fin" ? s.pendientes.filter((p) => p.sesionId !== e.sesionId) : s.pendientes;
      const c = s.conversaciones[e.sesionId];
      if (!c) return pendientes === s.pendientes ? s : { ...s, pendientes };
      return { ...s, pendientes, conversaciones: { ...s.conversaciones, [e.sesionId]: aplicarEvento(c, e, a.ahora) } };
    }
    case "usuario":
      return conConversacion(s, a.sesionId, (c) => anadirUsuario(c, a.texto, a.ahora, a.steer));
    case "aviso":
      return conConversacion(s, a.sesionId, (c) => {
        const conAviso = { ...anadirAviso(c, a.nivel, a.texto), cargando: false };
        return a.fin ? { ...conAviso, trabajando: false, pensandoDesde: undefined } : conAviso;
      });
    case "pendiente":
      return { ...s, pendientes: [...s.pendientes, a.pendiente] };
    case "pendiente.resuelto": {
      const p = s.pendientes.find((x) => x.id === a.id);
      const sin = { ...s, pendientes: s.pendientes.filter((x) => x.id !== a.id) };
      // La duración de una herramienta cuenta desde que se aprueba, no desde que se pidió permiso.
      if (p?.tipo !== "aprobacion" || !s.conversaciones[p.sesionId]) return sin;
      return conConversacion(sin, p.sesionId, (c) => ({
        ...c,
        elementos: c.elementos.map((e) => (e.tipo === "herramienta" && e.estado === "en-curso" ? { ...e, inicio: a.ahora } : e)),
      }));
    }
  }
}

export interface Acciones {
  reconectar: () => void;
  abrirSesion: (sesionId: string) => void;
  nuevaSesion: () => void;
  abrirAjustes: () => void;
  empezar: (p: { texto: string; proveedor?: string; modelo?: string; modoAprobacion?: ModoAprobacion }) => Promise<void>;
  enviar: (sesionId: string, texto: string) => Promise<void>;
  detener: (sesionId: string) => void;
  ajustarSesion: (sesionId: string, cambios: { proveedor?: string; modelo?: string; modoAprobacion?: ModoAprobacion }) => Promise<void>;
  renombrar: (sesionId: string, titulo: string) => Promise<void>;
  borrar: (sesionId: string) => Promise<void>;
  refrescarProveedores: () => Promise<void>;
  guardarAjustes: (cambios: Partial<Ajustes>) => Promise<Ajustes>;
  guardarClave: (proveedor: string, clave: string) => Promise<void>;
  borrarClave: (proveedor: string) => Promise<void>;
}

const ContextoEstado = createContext<EstadoApp | null>(null);
const ContextoAcciones = createContext<Acciones | null>(null);

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProveedorApp({ children }: { children: ReactNode }) {
  const [estado, despachar] = useReducer(reducir, inicial);
  const estadoRef = useRef(estado);
  estadoRef.current = estado;
  const cliente = useRef<ClienteRpc | undefined>(undefined);
  const intento = useRef(0);
  const siguientePendiente = useRef(0);

  const rpc = useCallback((): ClienteRpc => {
    if (!cliente.current) throw new Error("Sin conexión con el núcleo");
    return cliente.current;
  }, []);

  const cargar = useCallback(async (sesionId: string) => {
    despachar({ tipo: "cargando", sesionId });
    try {
      const { historial, ...sesion } = await rpc().llamar("sesion.reanudar", { sesionId });
      despachar({ tipo: "historial", sesion, historial });
    } catch (e) {
      despachar({ tipo: "aviso", sesionId, nivel: "error", texto: mensaje(e) });
    }
  }, [rpc]);

  const refrescarProveedores = useCallback(async () => {
    const { proveedores } = await rpc().llamar("proveedores.listar", {});
    despachar({ tipo: "proveedores", proveedores });
  }, [rpc]);

  const conectar = useCallback(async () => {
    const n = ++intento.current;
    const vigente = () => n === intento.current;
    cliente.current?.cerrar();
    cliente.current = undefined;
    despachar({ tipo: "conexion", estado: "conectando" });
    try {
      const { url, token } = await datosConexion();
      const c = await ClienteRpc.conectar(url, token);
      if (!vigente()) return c.cerrar();
      cliente.current = c;
      c.alEvento((evento) => despachar({ tipo: "evento", evento, ahora: Date.now() }));
      c.atender(
        "aprobacion.pedir",
        (params) =>
          new Promise((ok) => {
            const id = `p${++siguientePendiente.current}`;
            despachar({
              tipo: "pendiente",
              pendiente: { tipo: "aprobacion", id, sesionId: params.sesionId, params, responder: (decision) => (ok({ decision }), despachar({ tipo: "pendiente.resuelto", id, ahora: Date.now() })) },
            });
          }),
      );
      c.atender(
        "pregunta.hacer",
        (params) =>
          new Promise((ok) => {
            const id = `p${++siguientePendiente.current}`;
            despachar({
              tipo: "pendiente",
              pendiente: { tipo: "pregunta", id, sesionId: params.sesionId, params, responder: (respuesta) => (ok({ respuesta }), despachar({ tipo: "pendiente.resuelto", id, ahora: Date.now() })) },
            });
          }),
      );
      c.alCerrar(() => vigente() && despachar({ tipo: "conexion", estado: "caida", error: "Se perdió la conexión con el núcleo" }));
      const [{ sesiones }, ajustes] = await Promise.all([c.llamar("sesion.listar", {}), c.llamar("ajustes.leer", {})]);
      if (!vigente()) return;
      despachar({ tipo: "inicial", sesiones, ajustes });
      const activa = estadoRef.current.activa;
      if (activa && sesiones.some((x) => x.sesionId === activa)) void cargar(activa);
      // Puede tardar (agy lista sus modelos lanzando un proceso): no bloquea el arranque.
      c.llamar("proveedores.listar", {}).then(
        ({ proveedores }) => vigente() && despachar({ tipo: "proveedores", proveedores }),
        () => {},
      );
    } catch (e) {
      if (vigente()) despachar({ tipo: "conexion", estado: "caida", error: mensaje(e) });
    }
  }, [cargar]);

  useEffect(() => {
    void conectar();
    return () => {
      intento.current++;
      cliente.current?.cerrar();
      cliente.current = undefined;
    };
  }, [conectar]);

  const acciones = useMemo<Acciones>(() => {
    const enviar = async (sesionId: string, texto: string) => {
      const s = estadoRef.current;
      const pregunta = s.pendientes.find((p) => p.sesionId === sesionId && p.tipo === "pregunta");
      if (pregunta?.tipo === "pregunta") {
        despachar({ tipo: "usuario", sesionId, texto, steer: true, ahora: Date.now() });
        pregunta.responder(texto);
        return;
      }
      const trabajando = s.sesiones[sesionId]?.trabajando || s.conversaciones[sesionId]?.trabajando;
      despachar({ tipo: "usuario", sesionId, texto, steer: !!trabajando, ahora: Date.now() });
      try {
        if (trabajando) await rpc().llamar("prompt.steer", { sesionId, texto });
        else await rpc().llamar("prompt.enviar", { sesionId, texto });
      } catch (e) {
        despachar({ tipo: "aviso", sesionId, nivel: "error", texto: mensaje(e), fin: !trabajando });
      }
    };

    return {
      reconectar: () => void conectar(),
      abrirSesion: (sesionId) => {
        despachar({ tipo: "vista", vista: "conversacion", activa: sesionId });
        if (!estadoRef.current.conversaciones[sesionId]) void cargar(sesionId);
      },
      nuevaSesion: () => despachar({ tipo: "vista", vista: "inicio" }),
      abrirAjustes: () => despachar({ tipo: "vista", vista: "ajustes" }),
      empezar: async ({ texto, ...opciones }) => {
        const sesion = await rpc().llamar("sesion.crear", opciones);
        despachar({ tipo: "sesion", sesion });
        despachar({ tipo: "historial", sesion, historial: [] });
        despachar({ tipo: "vista", vista: "conversacion", activa: sesion.sesionId });
        await enviar(sesion.sesionId, texto);
      },
      enviar,
      detener: (sesionId) => void rpc().llamar("prompt.parar", { sesionId }).catch(() => {}),
      ajustarSesion: async (sesionId, cambios) => {
        try {
          despachar({ tipo: "sesion", sesion: await rpc().llamar("sesion.ajustar", { sesionId, ...cambios }) });
        } catch (e) {
          despachar({ tipo: "aviso", sesionId, nivel: "error", texto: mensaje(e) });
        }
      },
      renombrar: async (sesionId, titulo) => {
        despachar({ tipo: "sesion", sesion: await rpc().llamar("sesion.renombrar", { sesionId, titulo }) });
      },
      borrar: async (sesionId) => {
        await rpc().llamar("sesion.borrar", { sesionId });
        despachar({ tipo: "sesion.borrada", sesionId });
      },
      refrescarProveedores,
      guardarAjustes: async (cambios) => {
        const ajustes = await rpc().llamar("ajustes.guardar", cambios);
        despachar({ tipo: "ajustes", ajustes });
        return ajustes;
      },
      guardarClave: async (proveedor, clave) => {
        await guardarClaveLlavero(proveedor, clave);
        await rpc().llamar("ajustes.clave", { proveedor, clave });
      },
      borrarClave: async (proveedor) => {
        await borrarClaveLlavero(proveedor);
        await rpc().llamar("ajustes.clave", { proveedor, clave: "" });
      },
    };
  }, [cargar, conectar, refrescarProveedores, rpc]);

  return (
    <ContextoAcciones.Provider value={acciones}>
      <ContextoEstado.Provider value={estado}>{children}</ContextoEstado.Provider>
    </ContextoAcciones.Provider>
  );
}

export function useEstado(): EstadoApp {
  const e = useContext(ContextoEstado);
  if (!e) throw new Error("useEstado fuera de ProveedorApp");
  return e;
}

export function useAcciones(): Acciones {
  const a = useContext(ContextoAcciones);
  if (!a) throw new Error("useAcciones fuera de ProveedorApp");
  return a;
}

export function estaTrabajando(s: EstadoApp, sesionId: string | undefined): boolean {
  if (!sesionId) return false;
  return !!(s.sesiones[sesionId]?.trabajando || s.conversaciones[sesionId]?.trabajando);
}
