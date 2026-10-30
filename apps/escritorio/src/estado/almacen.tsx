/**
 * Estado de la app: conexión con el núcleo, sesiones, conversaciones abiertas, peticiones pendientes
 * (permisos y preguntas), proveedores y ajustes. Un reducer puro + acciones que hablan con el núcleo.
 * Memoria, habilidades y búsqueda no se guardan aquí: las piden sus vistas (ver `carga.ts`) y este estado
 * solo lleva la cuenta de cuándo cambian (`revisiones`).
 */
import type {
  Ajustes,
  BloqueMemoria,
  DestinoMemoria,
  EntradaAprendizaje,
  Evento,
  InfoProveedor,
  InfoSesion,
  InfoSkill,
  MensajeHistorial,
  ModoAprobacion,
  NombreMetodo,
  Params,
  Propuesta,
  ResultadoBusqueda,
  Resultados,
  VersionSkill,
} from "@aquiles/protocolo";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { datosConexion } from "../conexion";
import { borrarClaveLlavero, guardarClaveLlavero } from "../plataforma/claves";
import { ClienteRpc } from "../rpc";
import { anadirAviso, anadirUsuario, aplicarEvento, conversacionVacia, desdeHistorial, type EventoSesion } from "./conversacion";
import { alAbrirSesion, alReiniciarNucleo } from "../plataforma/aplicacion";
import { notificarSistema } from "../plataforma/notificaciones";
import { enTauri } from "../plataforma/tauri";
import { type AdjuntoPendiente, paraEnviar, visto } from "./adjuntos";
import type { AdjuntoVisto, Conversacion, EstadoApp, EstadoConexion, Notificacion, Pendiente, PestanaMemoria, Subagente, Vista } from "./tipos";

type Accion =
  | { tipo: "conexion"; estado: EstadoConexion; error?: string }
  | { tipo: "inicial"; sesiones: InfoSesion[]; ajustes: Ajustes }
  | { tipo: "proveedores"; proveedores: InfoProveedor[] }
  | { tipo: "ajustes"; ajustes: Ajustes }
  | { tipo: "vista"; vista: Vista; activa?: string; pestanaMemoria?: PestanaMemoria }
  | { tipo: "sesion"; sesion: InfoSesion }
  | { tipo: "sesion.borrada"; sesionId: string }
  | { tipo: "cargando"; sesionId: string }
  | { tipo: "historial"; sesion: InfoSesion; historial: MensajeHistorial[] }
  | { tipo: "evento"; evento: Evento; ahora: number }
  | { tipo: "usuario"; sesionId: string; texto: string; steer: boolean; ahora: number; adjuntos?: AdjuntoVisto[] }
  | { tipo: "aviso"; sesionId: string; nivel: "aviso" | "error"; texto: string; fin?: boolean }
  | { tipo: "pendiente"; pendiente: Pendiente }
  | { tipo: "pendiente.resuelto"; id: string; ahora: number }
  | { tipo: "notificacion"; notificacion: Notificacion }
  | { tipo: "notificacion.cerrada"; id: number }
  | { tipo: "voz"; voz: EstadoApp["voz"] }
  | { tipo: "pedido"; pedido: Partial<{ caja: string; objetivo: string; busqueda: string }> };

const inicial: EstadoApp = {
  conexion: "conectando",
  vista: "inicio",
  sesiones: {},
  conversaciones: {},
  pendientes: [],
  proveedores: [],
  revisiones: { memoria: 0, skills: 0, aprendizaje: 0, cron: 0, canales: 0, mcp: 0, plugins: 0, modelos: 0 },
  descargasModelos: {},
  subagentes: {},
  notificaciones: [],
  pedidos: {},
};

let siguientePedido = 0;

/** Lo último que escribe un subagente (lo que cabe en su tarjeta). */
const COLA_SUBAGENTE = 600;

/** Panel de subagentes: nacen con subagente.inicio, escriben con sus mensaje.delta y acaban con subagente.fin. */
function conSubagentes(s: EstadoApp, e: Evento): EstadoApp {
  const actualizar = (subId: string, f: (x: Subagente) => Subagente) => {
    const x = s.subagentes[subId];
    return x ? { ...s, subagentes: { ...s.subagentes, [subId]: f(x) } } : s;
  };
  switch (e.tipo) {
    case "subagente.inicio":
      return { ...s, subagentes: { ...s.subagentes, [e.subId]: { subId: e.subId, padre: e.sesionId, tarea: e.tarea, estado: "en-curso", texto: "" } } };
    case "subagente.fin":
      return actualizar(e.subId, (x) => ({ ...x, estado: e.motivo, texto: (e.texto || x.texto).slice(-COLA_SUBAGENTE), ...(e.error ? { error: e.error } : {}) }));
    case "mensaje.delta":
      return actualizar(e.sesionId, (x) => ({ ...x, texto: (x.texto + e.texto).slice(-COLA_SUBAGENTE) }));
    default:
      return s;
  }
}

const subir = (s: EstadoApp, clave: keyof EstadoApp["revisiones"]): EstadoApp => ({ ...s, revisiones: { ...s.revisiones, [clave]: s.revisiones[clave] + 1 } });

const esDeSesion = (e: Evento): e is EventoSesion => "sesionId" in e;

function conConversacion(s: EstadoApp, sesionId: string, f: (c: Conversacion) => Conversacion): EstadoApp {
  const c = s.conversaciones[sesionId] ?? conversacionVacia();
  return { ...s, conversaciones: { ...s.conversaciones, [sesionId]: f(c) } };
}

function reducir(s: EstadoApp, a: Accion): EstadoApp {
  switch (a.tipo) {
    case "conexion":
      if (a.estado === "conectada") return { ...s, conexion: a.estado, errorConexion: undefined };
      // Las peticiones del núcleo mueren con la conexión.
      return { ...s, conexion: a.estado, errorConexion: a.error, pendientes: a.estado === "caida" || a.estado === "reiniciando" ? [] : s.pendientes };
    case "inicial": {
      const sesiones = Object.fromEntries(a.sesiones.map((x) => [x.sesionId, x]));
      const activa = s.activa && sesiones[s.activa] ? s.activa : undefined;
      // Tras reconectar lo cargado puede estar desfasado: se vuelve a pedir al abrir.
      return {
        ...s,
        conexion: "conectada",
        sesiones,
        ajustes: a.ajustes,
        conversaciones: {},
        activa,
        vista: activa || s.vista !== "conversacion" ? s.vista : "inicio",
        revisiones: Object.fromEntries(Object.entries(s.revisiones).map(([k, v]) => [k, v + 1])) as EstadoApp["revisiones"],
      };
    }
    case "proveedores":
      return { ...s, proveedores: a.proveedores };
    case "ajustes":
      return { ...s, ajustes: a.ajustes };
    case "vista":
      return { ...s, vista: a.vista, activa: a.vista === "inicio" ? undefined : (a.activa ?? s.activa), pestanaMemoria: a.pestanaMemoria };
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
      if (e.tipo === "memoria.actualizada") return { ...s, revisiones: { ...s.revisiones, memoria: s.revisiones.memoria + 1 } };
      if (e.tipo === "skills.actualizadas") return { ...s, revisiones: { ...s.revisiones, skills: s.revisiones.skills + 1 } };
      if (e.tipo === "aprendizaje.actualizado") return subir(s, "aprendizaje");
      if (e.tipo === "cron.ejecucion" || e.tipo === "cron.actualizado") return subir(s, "cron");
      if (e.tipo === "canales.actualizados") return subir(s, "canales");
      if (e.tipo === "mcp.actualizado") return subir(s, "mcp");
      if (e.tipo === "plugins.actualizados") return subir(s, "plugins");
      if (e.tipo === "modelos.actualizados") return subir(s, "modelos");
      if (e.tipo === "modelos.progreso") return { ...s, descargasModelos: { ...s.descargasModelos, [e.descarga.id]: e.descarga } };
      if (e.tipo === "objetivo.evaluado") {
        const sesion = s.sesiones[e.sesionId];
        return sesion ? { ...s, sesiones: { ...s.sesiones, [e.sesionId]: { ...sesion, objetivo: e.objetivo } } } : s;
      }
      // `notificacion` se atiende al recibirla (ver conectar); el resto sin sesión no toca nada.
      if (e.tipo === "notificacion" || !esDeSesion(e)) return s;
      // Una revisión que acaba deja propuestas (o cambios aplicados) nuevos.
      const t = conSubagentes(e.tipo === "aprendizaje.revision" && e.estado === "fin" ? subir(s, "aprendizaje") : s, e);
      const pendientes = e.tipo === "turno.fin" ? t.pendientes.filter((p) => p.sesionId !== e.sesionId) : t.pendientes;
      const c = t.conversaciones[e.sesionId];
      if (!c) return pendientes === t.pendientes ? t : { ...t, pendientes };
      return { ...t, pendientes, conversaciones: { ...t.conversaciones, [e.sesionId]: aplicarEvento(c, e, a.ahora) } };
    }
    case "usuario":
      return conConversacion(s, a.sesionId, (c) => anadirUsuario(c, a.texto, a.ahora, a.steer, a.adjuntos));
    case "aviso":
      return conConversacion(s, a.sesionId, (c) => {
        const conAviso = { ...anadirAviso(c, a.nivel, a.texto), cargando: false };
        return a.fin ? { ...conAviso, trabajando: false, pensandoDesde: undefined } : conAviso;
      });
    case "pendiente":
      return { ...s, pendientes: [...s.pendientes, a.pendiente] };
    case "notificacion":
      // Las cinco más recientes; las viejas se van solas.
      return { ...s, notificaciones: [...s.notificaciones, a.notificacion].slice(-5) };
    case "notificacion.cerrada":
      return { ...s, notificaciones: s.notificaciones.filter((n) => n.id !== a.id) };
    case "voz":
      return { ...s, voz: a.voz };
    case "pedido": {
      const n = ++siguientePedido;
      const p = a.pedido;
      return {
        ...s,
        pedidos: {
          ...s.pedidos,
          ...(p.caja !== undefined ? { caja: { texto: p.caja, n } } : {}),
          ...(p.objetivo !== undefined ? { objetivo: { sesionId: p.objetivo, n } } : {}),
          ...(p.busqueda !== undefined ? { busqueda: { texto: p.busqueda, n } } : {}),
        },
      };
    }
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
  abrirHabilidades: () => void;
  abrirMemoria: (pestana?: PestanaMemoria) => void;
  abrirAutomatizaciones: () => void;
  abrirEstadisticas: () => void;
  /** Antes de algo que reinicia el núcleo (cambiar de perfil, núcleo remoto…): esperar y reconectar sin dar error. */
  prepararReinicio: (motivo?: string) => void;
  abrirAjustes: () => void;
  empezar: (p: { texto: string; adjuntos?: AdjuntoPendiente[]; proveedor?: string; modelo?: string; esfuerzo?: string; modoAprobacion?: ModoAprobacion }) => Promise<void>;
  /** Los adjuntos solo van con un turno nuevo (no con el steer ni como respuesta a una pregunta). */
  enviar: (sesionId: string, texto: string, adjuntos?: AdjuntoPendiente[]) => Promise<void>;
  detener: (sesionId: string) => void;
  ajustarSesion: (sesionId: string, cambios: { proveedor?: string; modelo?: string; esfuerzo?: string; modoAprobacion?: ModoAprobacion }) => Promise<void>;
  renombrar: (sesionId: string, titulo: string) => Promise<void>;
  borrar: (sesionId: string) => Promise<void>;
  refrescarProveedores: () => Promise<void>;
  guardarAjustes: (cambios: Params<"ajustes.guardar">) => Promise<Ajustes>;
  guardarClave: (proveedor: string, clave: string) => Promise<void>;
  borrarClave: (proveedor: string) => Promise<void>;
  /** Con las archivadas: la vista las separa con su chip. */
  listarSkills: (cwd?: string) => Promise<InfoSkill[]>;
  leerSkill: (nombre: string, cwd?: string) => Promise<Resultados["skills.leer"]>;
  ajustarSkill: (nombre: string, activa: boolean, cwd?: string) => Promise<InfoSkill>;
  fijarSkill: (nombre: string, fijada: boolean) => Promise<InfoSkill>;
  archivarSkill: (nombre: string) => Promise<InfoSkill>;
  restaurarSkill: (nombre: string) => Promise<InfoSkill>;
  versionesSkill: (nombre: string) => Promise<VersionSkill[]>;
  restaurarVersionSkill: (nombre: string, version: string) => Promise<InfoSkill>;
  leerMemoria: (cwd?: string) => Promise<Resultados["memoria.leer"]>;
  /** Sustituye todas las entradas del destino; el núcleo valida y, si las rechaza, lanza su error. */
  guardarMemoria: (destino: DestinoMemoria, entradas: string[], cwd?: string) => Promise<BloqueMemoria>;
  guardarAlma: (texto: string) => Promise<string>;
  buscarSesiones: (consulta: string) => Promise<ResultadoBusqueda[]>;
  /** Propuestas pendientes de lo aprendido. */
  listarPropuestas: () => Promise<Propuesta[]>;
  decidirPropuesta: (id: string, decision: "aceptar" | "descartar") => Promise<Propuesta>;
  historialAprendizaje: () => Promise<EntradaAprendizaje[]>;
  /** URL completa de algo que el núcleo sirve por HTTP (p. ej. la `ruta` de artefactos.vista). */
  urlNucleo: (ruta: string) => string;
  /** Cualquier método del núcleo, tipado por el protocolo (cron, canales, mcp, voz…). */
  llamar: <M extends NombreMetodo>(metodo: M, params: Params<M>) => Promise<Resultados[M]>;
  /** Steer a una sesión cualquiera (p. ej. un subagente), sin pasar por su conversación. */
  reconducir: (sesionId: string, texto: string) => Promise<void>;
  cerrarNotificacion: (id: number) => void;
  /** Pone (o quita, con null) el objetivo de una sesión; la sesión se actualiza con lo que devuelve el núcleo. */
  ponerObjetivo: (sesionId: string, objetivo: string | null, maxIntentos?: number) => Promise<void>;
  /** Añade texto a la caja de la conversación abierta (y la abre si se está en otra vista). */
  insertarEnCaja: (texto: string) => void;
  /** Abre la sesión con el editor de su objetivo. */
  editarObjetivo: (sesionId: string) => void;
  buscarEnConversaciones: (texto: string) => void;
  /** Sesión vacía en esa carpeta, ya abierta. */
  nuevaSesionEn: (cwd: string) => Promise<void>;
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
  /** Espera a que el núcleo vuelva tras un reinicio y reconecta (definida más abajo: usa `conectar`). */
  const reiniciar = useRef<(motivo?: string) => void>(() => {});
  const siguientePendiente = useRef(0);
  const siguienteNotificacion = useRef(0);

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
      c.alEvento((evento) => {
        if (evento.tipo === "nucleo.reinicio") {
          reiniciar.current(evento.motivo);
          return;
        }
        if (evento.tipo === "notificacion") {
          const { titulo, texto, sesionId } = evento;
          // En la app de escritorio, notificación del sistema; en el navegador (o sin permiso), aviso dentro de la app.
          void notificarSistema({ titulo, texto, sesionId }).then(
            (enviada) => enviada || despachar({ tipo: "notificacion", notificacion: { id: ++siguienteNotificacion.current, titulo, texto, ...(sesionId ? { sesionId } : {}) } }),
          );
          return;
        }
        // Los modelos descargados son los del proveedor llamacpp: los selectores de modelo los sacan de proveedores.listar.
        if (evento.tipo === "modelos.actualizados") void refrescarProveedores().catch(() => {});
        despachar({ tipo: "evento", evento, ahora: Date.now() });
      });
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
      // Sin voz (o con un núcleo que aún no la tiene) no hay botones de voz.
      c.llamar("voz.estado", {}).then(
        (voz) => vigente() && despachar({ tipo: "voz", voz }),
        () => vigente() && despachar({ tipo: "voz", voz: undefined }),
      );
      c.llamar("proveedores.listar", {}).then(
        ({ proveedores }) => vigente() && despachar({ tipo: "proveedores", proveedores }),
        () => {},
      );
    } catch (e) {
      if (vigente()) despachar({ tipo: "conexion", estado: "caida", error: mensaje(e) });
    }
  }, [cargar, refrescarProveedores]);

  useEffect(() => {
    void conectar();
    return () => {
      intento.current++;
      cliente.current?.cerrar();
      cliente.current = undefined;
    };
  }, [conectar]);

  // Reinicio a propósito: se suelta la conexión vieja (su cierre ya no cuenta como caída) y se espera al núcleo nuevo.
  // En la app avisa Tauri con «nucleo-reiniciado»; en el navegador se reintenta hasta que vuelva a responder.
  reiniciar.current = (motivo) => {
    const n = ++intento.current;
    cliente.current?.cerrar();
    cliente.current = undefined;
    despachar({ tipo: "conexion", estado: "reiniciando", error: motivo });
    if (enTauri()) {
      setTimeout(() => n === intento.current && void conectar(), 30_000);
      return;
    }
    const probar = async (vez: number) => {
      if (n !== intento.current) return;
      try {
        const { url, token } = await datosConexion();
        (await ClienteRpc.conectar(url, token)).cerrar();
        if (n === intento.current) void conectar();
      } catch {
        if (vez < 40) setTimeout(() => void probar(vez + 1), 1000);
        else if (n === intento.current) despachar({ tipo: "conexion", estado: "caida", error: "El núcleo no ha vuelto tras reiniciarse" });
      }
    };
    // El núcleo viejo tarda un poco en cerrarse: no hay que volver a conectarse a él.
    setTimeout(() => void probar(0), 1500);
  };

  useEffect(() => alReiniciarNucleo(() => void conectar()), [conectar]);

  const acciones = useMemo<Acciones>(() => {
    const enviar = async (sesionId: string, texto: string, adjuntos: AdjuntoPendiente[] = []) => {
      const s = estadoRef.current;
      const pregunta = s.pendientes.find((p) => p.sesionId === sesionId && p.tipo === "pregunta");
      if (pregunta?.tipo === "pregunta") {
        despachar({ tipo: "usuario", sesionId, texto, steer: true, ahora: Date.now() });
        pregunta.responder(texto);
        return;
      }
      const trabajando = s.sesiones[sesionId]?.trabajando || s.conversaciones[sesionId]?.trabajando;
      const conAdjuntos = !trabajando && adjuntos.length > 0;
      despachar({ tipo: "usuario", sesionId, texto, steer: !!trabajando, ahora: Date.now(), ...(conAdjuntos ? { adjuntos: adjuntos.map(visto) } : {}) });
      try {
        if (trabajando) await rpc().llamar("prompt.steer", { sesionId, texto });
        else await rpc().llamar("prompt.enviar", { sesionId, texto, ...(conAdjuntos ? { adjuntos: adjuntos.map(paraEnviar) } : {}) });
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
      abrirHabilidades: () => despachar({ tipo: "vista", vista: "habilidades" }),
      abrirMemoria: (pestana) => despachar({ tipo: "vista", vista: "memoria", pestanaMemoria: pestana }),
      abrirAutomatizaciones: () => despachar({ tipo: "vista", vista: "automatizaciones" }),
      abrirEstadisticas: () => despachar({ tipo: "vista", vista: "estadisticas" }),
      prepararReinicio: (motivo) => reiniciar.current(motivo),
      abrirAjustes: () => despachar({ tipo: "vista", vista: "ajustes" }),
      empezar: async ({ texto, adjuntos, ...opciones }) => {
        const sesion = await rpc().llamar("sesion.crear", opciones);
        despachar({ tipo: "sesion", sesion });
        despachar({ tipo: "historial", sesion, historial: [] });
        despachar({ tipo: "vista", vista: "conversacion", activa: sesion.sesionId });
        await enviar(sesion.sesionId, texto, adjuntos);
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
      // async: rpc() lanza si no hay conexión y así llega como promesa rechazada.
      listarSkills: async (cwd) => (await rpc().llamar("skills.listar", { cwd, archivadas: true })).skills,
      leerSkill: async (nombre, cwd) => rpc().llamar("skills.leer", { nombre, cwd }),
      ajustarSkill: async (nombre, activa, cwd) => rpc().llamar("skills.ajustar", { nombre, activa, cwd }),
      fijarSkill: async (nombre, fijada) => rpc().llamar("skills.fijar", { nombre, fijada }),
      archivarSkill: async (nombre) => rpc().llamar("skills.archivar", { nombre }),
      restaurarSkill: async (nombre) => rpc().llamar("skills.restaurar", { nombre }),
      versionesSkill: async (nombre) => (await rpc().llamar("skills.versiones", { nombre })).versiones,
      restaurarVersionSkill: async (nombre, version) => rpc().llamar("skills.restaurarVersion", { nombre, version }),
      leerMemoria: async (cwd) => rpc().llamar("memoria.leer", { cwd }),
      guardarMemoria: async (destino, entradas, cwd) => rpc().llamar("memoria.guardar", { destino, entradas, cwd }),
      guardarAlma: async (texto) => (await rpc().llamar("memoria.alma", { texto })).texto,
      buscarSesiones: async (consulta) => (await rpc().llamar("buscar.sesiones", { consulta, limite: 30 })).resultados,
      listarPropuestas: async () => (await rpc().llamar("aprendizaje.listar", {})).propuestas,
      decidirPropuesta: async (id, decision) => rpc().llamar("aprendizaje.decidir", { id, decision }),
      historialAprendizaje: async () => (await rpc().llamar("aprendizaje.historial", { limite: 200 })).entradas,
      llamar: async (metodo, params) => rpc().llamar(metodo, params),
      urlNucleo: (ruta) => rpc().origenHttp + ruta,
      reconducir: async (sesionId, texto) => {
        await rpc().llamar("prompt.steer", { sesionId, texto });
      },
      cerrarNotificacion: (id) => despachar({ tipo: "notificacion.cerrada", id }),
      insertarEnCaja: (texto) => {
        const activa = estadoRef.current.activa;
        if (estadoRef.current.vista !== "conversacion" && activa) despachar({ tipo: "vista", vista: "conversacion", activa });
        despachar({ tipo: "pedido", pedido: { caja: texto } });
      },
      editarObjetivo: (sesionId) => {
        despachar({ tipo: "vista", vista: "conversacion", activa: sesionId });
        if (!estadoRef.current.conversaciones[sesionId]) void cargar(sesionId);
        despachar({ tipo: "pedido", pedido: { objetivo: sesionId } });
      },
      buscarEnConversaciones: (texto) => despachar({ tipo: "pedido", pedido: { busqueda: texto.trim().slice(0, 200) } }),
      nuevaSesionEn: async (cwd) => {
        const sesion = await rpc().llamar("sesion.crear", { cwd });
        despachar({ tipo: "sesion", sesion });
        despachar({ tipo: "historial", sesion, historial: [] });
        despachar({ tipo: "vista", vista: "conversacion", activa: sesion.sesionId });
      },
      ponerObjetivo: async (sesionId, objetivo, maxIntentos) => {
        despachar({ tipo: "sesion", sesion: await rpc().llamar("sesion.objetivo", { sesionId, objetivo, ...(maxIntentos ? { maxIntentos } : {}) }) });
      },
    };
  }, [cargar, conectar, refrescarProveedores, rpc]);

  // La entrada rápida (otra ventana) crea una sesión y pide abrirla en esta.
  useEffect(() => alAbrirSesion((sesionId) => acciones.abrirSesion(sesionId)), [acciones]);

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

/** Carpeta de la sesión activa (la última abierta), si la hay: la de su proyecto en Memoria y Habilidades. */
export function cwdActiva(s: EstadoApp): string | undefined {
  return s.activa ? s.sesiones[s.activa]?.cwd : undefined;
}

export function estaTrabajando(s: EstadoApp, sesionId: string | undefined): boolean {
  if (!sesionId) return false;
  return !!(s.sesiones[sesionId]?.trabajando || s.conversaciones[sesionId]?.trabajando);
}
