/**
 * Servidor JSON-RPC 2.0 por WebSocket, solo en 127.0.0.1.
 * Exige el token en `?token=` y, si el cliente es un navegador (envía Origin),
 * que el origen sea el de la app. También pide cosas a la interfaz (aprobaciones,
 * preguntas) y espera su respuesta.
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  codigosError,
  MAX_ADJUNTOS,
  MAX_BYTES_ADJUNTO,
  metodos,
  RUTA_RPC,
  VERSION_PROTOCOLO,
  type ErrorRpc,
  type InfoSesion,
  type Evento,
  type NombreMetodo,
  type NombrePeticionCliente,
  type PeticionesCliente,
  type PeticionRpc,
  type RespuestaRpc,
  type Resultados,
} from "@aquiles/protocolo";
import type { ServerWebSocket } from "bun";
import { type AdjuntoEntrante, borrarAdjuntos, carpetaAdjuntos, ErrorAdjunto, guardarAdjuntos, leerAdjunto } from "./adjuntos";
import { AJUSTES_HERRAMIENTAS, AlmacenAjustes } from "./ajustes";
import { FicheroYaExiste, guardarArtefacto, VistasArtefactos } from "./artefactos";
import { AJUSTES_APRENDIZAJE, Aprendizaje, instruccionAprender } from "./aprendizaje";
import { ejecutarTurno, type PeticionAprobacion, type RespuestaAprobacion, type ResultadoTurno } from "./bucle";
import { ErrorCanal } from "./canales/canal";
import { abrirConocimiento } from "./conocimiento";
import { Programador } from "./cron";
import { ErrorCron, interpretar, proximas } from "./cron-expresiones";
import { calcularEstadisticas } from "./estadisticas";
import { consultarGuardian } from "./guardian";
import { ErrorHerramienta, type Herramienta, type Pregunta } from "./herramientas/herramienta";
import { cerrarEstadoSesion } from "./herramientas/index";
import { cerrarNavegador, herramientaNavegador } from "./herramientas/navegador";
import { ErrorKanban, Kanban } from "./kanban";
import { buscarFicheros, conMenciones } from "./menciones";
import { buscarModelos, Descargas, directorioModelos, ficherosRepo, modelosLocales as modelosDescargados } from "./locales/huggingface";
import { instalarLlamaCpp, rutaLlamaServer } from "./locales/llamacpp";
import { ClienteMcp } from "./mcp";
import { ErrorMemoria } from "./memoria";
import type { Motor, PeticionTurno } from "./motor";
import { Objetivos } from "./objetivos";
import { Pasarela } from "./pasarela";
import { crearCopia, crearPerfil, listarCopias, listarPerfiles, prepararRestauracion } from "./perfiles";
import { ErrorPlugin, Plugins } from "./plugins";
import {
  crearProveedor, establecerClave, esfuerzoValido, listarProveedores, servidorLlamaCpp, VARIABLES_CLAVE,
} from "./proveedores/index";
import { AlmacenSesiones, historial, info, type OpcionesSesion, type Sesion, titulo } from "./sesiones";
import { ErrorSkill } from "./skills";
import { herramientaDelegar, type LanzarSubagente } from "./subagentes";
import { Voz } from "./voz";
import type { AdjuntoGuardado, Mensaje, Proveedor } from "./tipos";

const HERRAMIENTAS_LECTURA = ["leer", "buscar_texto", "buscar_ficheros"];
const DIA_MS = 24 * 60 * 60 * 1000;
/** Un prompt.enviar puede traer 10 adjuntos de 25 MB en base64 (un tercio más), y adjuntos.leer devuelve uno entero. */
const MAX_MENSAJE_WS = Math.ceil((MAX_ADJUNTOS * MAX_BYTES_ADJUNTO * 4) / 3) + 1024 * 1024;

export const ORIGENES_APP = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:1420"];

export interface OpcionesServidor {
  puerto: number;
  token: string;
  /** Proveedor por defecto si el perfil aún no tiene ajustes. */
  proveedor: string;
  modelo?: string;
  /** Crea proveedores por nombre y modelo (inyectable en tests). */
  fabrica?: (nombre: string, modelo?: string, esfuerzo?: string) => Proveedor;
  herramientas: readonly Herramienta<any>[];
  cwdPorDefecto: string;
  version: string;
  /** Carpeta del perfil (sesiones/, salidas/, memoria/, skills/, ajustes.json); null = solo memoria. */
  perfil: string | null;
  /** Carpeta de las skills que vienen con Aquiles. */
  skillsIncluidas?: string | null;
  /** Nombre del perfil y carpeta de datos (para perfiles y copias); sin ellos esos métodos no están disponibles. */
  nombrePerfil?: string;
  datos?: string;
  /** Interfaz de red; por defecto solo 127.0.0.1. Otra (p. ej. 0.0.0.0) es el modo remoto. */
  host?: string;
  /** Reinicia el proceso (main sale con el código 75 y la app lo relanza). */
  reiniciar?: (motivo: string) => void;
  /** Ofrecer el proveedor simulado en proveedores.listar (desarrollo). */
  incluirSimulado?: boolean;
  origenesPermitidos?: readonly string[];
  log?: (mensaje: string) => void;
}

export interface Servidor {
  puerto: number;
  /** Para lanzar turnos sin la interfaz (tareas programadas, canales). */
  motor: Motor;
  detener(): Promise<void>;
}

/** Cómo se lanza un turno: quién responde a permisos y preguntas, y quién más escucha sus eventos. */
interface OpcionesEjecucion {
  aprobar: (p: PeticionAprobacion, senal: AbortSignal) => Promise<RespuestaAprobacion>;
  preguntar: (p: Pregunta, senal: AbortSignal) => Promise<string>;
  alEvento?: (e: Evento) => void;
  /** Herramientas de esta ejecución; por defecto, las de la sesión. */
  herramientas?: readonly Herramienta<any>[];
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
  /** Peticiones nuestras a la interfaz; `faltan` = clientes que aún pueden contestar. */
  const pendientes = new Map<string, { ok: (r: unknown) => void; mal: (e: Error) => void; faltan: number }>();
  let siguiente = 0;

  const emitir = (evento: Evento) => {
    const texto = JSON.stringify({ jsonrpc: "2.0", method: "evento", params: evento });
    for (const ws of clientes) ws.send(texto);
  };

  const conocimiento = abrirConocimiento({
    perfil: o.perfil, incluidas: o.skillsIncluidas, emitir, log,
    origen: (sesionId) => {
      const s = sesiones.obtener(sesionId);
      const t = s ? titulo(s) : undefined;
      return { tipo: aprendizaje.aprendiendo.has(sesionId) ? "aprender" : "sesion", sesionId, ...(t ? { titulo: t } : {}) };
    },
  });
  const { memoria, skills, indice, registro } = conocimiento;
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

  /**
   * Pide algo a la interfaz; vale la primera respuesta de un cliente que la atienda. Un cliente que no la atiende
   * (-32601: la ventana de entrada rápida, un editor por ACP…) no cuenta; solo si no la atiende ninguno, falla.
   */
  const pedirCliente = <M extends NombrePeticionCliente>(
    metodo: M,
    params: PeticionesCliente[M]["params"],
    senal: AbortSignal,
  ): Promise<PeticionesCliente[M]["resultado"]> => {
    if (clientes.size === 0) return Promise.reject(new Error("No hay ninguna interfaz conectada para responder"));
    const id = `n${++siguiente}`;
    return new Promise((ok, mal) => {
      pendientes.set(id, { ok: ok as (r: unknown) => void, mal, faltan: clientes.size });
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
    aprendizaje: AJUSTES_APRENDIZAJE,
    herramientas: AJUSTES_HERRAMIENTAS,
  });
  const fabrica = o.fabrica ?? ((nombre: string, modelo?: string, esfuerzo?: string) => crearProveedor(nombre, { modelo, esfuerzo }));
  /** Un proveedor por (nombre, modelo, esfuerzo), compartido entre sesiones. */
  const proveedores = new Map<string, Proveedor>();
  const claveProveedor = (nombre: string, modelo?: string, esfuerzo?: string) => `${nombre}|${modelo ?? ""}|${esfuerzo ?? ""}`;
  const proveedorPara = (nombre: string, modelo?: string, esfuerzo?: string): Proveedor => {
    const clave = claveProveedor(nombre, modelo, esfuerzo);
    let p = proveedores.get(clave);
    if (!p) {
      try {
        p = fabrica(nombre, modelo, esfuerzo);
      } catch (e) {
        throw new FalloRpc(codigosError.paramsInvalidos, e instanceof Error ? e.message : String(e));
      }
      proveedores.set(clave, p);
    }
    return p;
  };
  const proveedorDe = (s: Sesion): Proveedor => proveedorPara(s.proveedor, s.modelo, s.esfuerzo);

  const aprendizaje: Aprendizaje = new Aprendizaje({
    perfil: o.perfil,
    incluidas: o.skillsIncluidas ?? null,
    memoria,
    skills,
    registro,
    ajustes: () => ajustes.leer().aprendizaje,
    proveedorDe: (s, a) => (a.proveedor ? proveedorPara(a.proveedor, a.modelo) : proveedorDe(s)),
    lectura: o.herramientas.filter((h) => HERRAMIENTAS_LECTURA.includes(h.nombre)),
    emitir,
    log,
  });

  /** Curador de skills: al arrancar y una vez al día. */
  const curar = () => {
    try {
      const cambios = skills.curar();
      if (!cambios.length) return cambios;
      log(`curador: ${cambios.map((c) => `${c.nombre} ${c.antes}→${c.despues}`).join(", ")}`);
      emitir({ tipo: "skills.actualizadas" });
      return cambios;
    } catch (e) {
      log(`curador: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  };
  curar();
  const relojCurador = setInterval(curar, DIA_MS);
  relojCurador.unref?.();
  const vistas = new VistasArtefactos();
  const descargas = new Descargas({
    token: () => process.env.HF_TOKEN || undefined,
    alProgreso: (d) => {
      emitir({ tipo: "modelos.progreso", descarga: d });
      if (d.estado !== "descargando") emitir({ tipo: "modelos.actualizados" });
    },
  });
  const fallo = (e: unknown, codigo: number = codigosError.paramsInvalidos) =>
    new FalloRpc(codigo, e instanceof Error ? e.message : String(e));

  const obtener = (sesionId: string): Sesion => {
    const s = sesiones.obtener(sesionId);
    if (!s) throw new FalloRpc(codigosError.sesionNoExiste, `No existe la sesión ${sesionId}`);
    return s;
  };
  /** InfoSesion con lo que vive fuera de la sesión (su objetivo). */
  const vista = (s: Sesion): InfoSesion => {
    const objetivo = objetivos.de(s.id);
    return { ...info(s), ...(objetivo ? { objetivo } : {}) };
  };
  const avisar = (s: Sesion) => emitir({ tipo: "sesion.actualizada", sesion: vista(s) });

  const crearSesion = (cwd: string | undefined, x: Partial<OpcionesSesion> = {}): Sesion => {
    const a = ajustes.leer();
    const s = sesiones.crear(cwd ?? a.carpeta, {
      ...x,
      modoAprobacion: x.modoAprobacion ?? a.modoAprobacion,
      proveedor: x.proveedor ?? a.proveedor,
      modelo: x.modelo ?? (x.proveedor ? undefined : a.modelo),
      // El esfuerzo por defecto solo vale con el proveedor y el modelo por defecto, para los que se comprobó al guardarlo.
      esfuerzo: x.esfuerzo ?? (x.proveedor || x.modelo ? undefined : a.esfuerzo || undefined),
    });
    log(`sesión ${s.id} en ${s.cwd} (${s.proveedor}${s.modelo ? ` ${s.modelo}` : ""})${s.origen ? ` [${s.origen.tipo}]` : ""}`);
    avisar(s);
    return s;
  };

  /** Permisos y preguntas a la interfaz, en la conversación `s`. */
  const aprobarEnApp = (s: Sesion) => async (p: PeticionAprobacion, senal: AbortSignal) =>
    (await pedirCliente("aprobacion.pedir", { sesionId: s.id, ...p }, senal)).decision;
  const preguntarEnApp = (s: Sesion) => async (p: Pregunta, senal: AbortSignal) =>
    (await pedirCliente("pregunta.hacer", { sesionId: s.id, ...p }, senal)).respuesta;

  /** Herramientas extra que se enchufan después (MCP, navegador). */
  const extras: (() => Herramienta<any>[])[] = [];

  const lanzarSubagente: LanzarSubagente = async (p) => {
    const padre = obtener(p.padre);
    const hija = crearSesion(p.cwd, {
      proveedor: padre.proveedor, modelo: padre.modelo, esfuerzo: padre.esfuerzo, modoAprobacion: padre.modoAprobacion,
      titulo: `${p.nombre} · subagente`, origen: { tipo: "subagente", padre: padre.id },
    });
    emitir({ tipo: "subagente.inicio", sesionId: padre.id, subId: hija.id, tarea: p.tarea });
    const parar = () => hija.turno?.abort();
    p.senal.addEventListener("abort", parar, { once: true });
    const lectura = herramientasDe(hija).filter((h) => h.nivel === "lectura" && h.nombre !== "delegar");
    try {
      const r = await ejecutarEn(hija, p.tarea, {
        // Lo que pida el subagente se pregunta en la conversación del padre, con su nombre delante.
        aprobar: (q, senal) => aprobarEnApp(padre)({ ...q, resumen: `[${p.nombre}] ${q.resumen}` }, senal),
        preguntar: (q, senal) => preguntarEnApp(padre)({ ...q, texto: `[${p.nombre}] ${q.texto}` }, senal),
        ...(p.soloLectura ? { herramientas: lectura } : {}),
      });
      emitir({ tipo: "subagente.fin", sesionId: padre.id, subId: hija.id, motivo: r.motivo, texto: r.texto, ...(r.error ? { error: r.error } : {}) });
      if (r.motivo === "error") throw new ErrorHerramienta(`El subagente «${p.nombre}» falló: ${r.error ?? "sin detalles"}`);
      if (r.motivo === "parado") throw new ErrorHerramienta(`El subagente «${p.nombre}» se paró antes de terminar. Lo que llevaba: ${r.texto.slice(0, 2000)}`);
      return { subId: hija.id, texto: r.texto };
    } finally {
      p.senal.removeEventListener("abort", parar);
      // El subagente ya acabó: su terminal (y su contenedor, si es Docker) no se queda abierta.
      await cerrarEstadoSesion(hija.estado);
    }
  };
  const delegar = herramientaDelegar(lanzarSubagente);

  /** Herramientas de una sesión: las básicas, memoria y skills, las extra y delegar (salvo en los subagentes). */
  const herramientasDe = (s: Sesion): Herramienta<any>[] => [
    ...o.herramientas,
    ...conocimiento.herramientas,
    ...extras.flatMap((f) => f()),
    ...(s.origen?.tipo === "subagente" ? [] : [delegar]),
  ];

  /** Guarda los adjuntos de un mensaje en la carpeta de la sesión; uno que no vale es un error de parámetros. */
  const guardarEn = (s: Sesion, entrantes: readonly AdjuntoEntrante[]): Promise<AdjuntoGuardado[]> =>
    guardarAdjuntos(entrantes, carpetaAdjuntos(o.perfil, s.id)).catch((e) => {
      throw e instanceof ErrorAdjunto ? new FalloRpc(codigosError.paramsInvalidos, e.message) : e;
    });

  /**
   * Añade el mensaje del usuario (con sus adjuntos, ya guardados) y ejecuta un turno en la sesión; la promesa acaba
   * con el turno. El guardián, si está activo, aprueba lo claramente seguro antes de preguntar.
   */
  const ejecutarEn = (s: Sesion, texto: string, x: OpcionesEjecucion, adjuntos?: AdjuntoGuardado[]): Promise<ResultadoTurno> => {
    if (s.turno) throw new FalloRpc(codigosError.sesionOcupada, "La sesión ya está trabajando; usa prompt.steer");
    // Sin esto, el primer proceso que se lanza en ella falla con un ENOENT que culpa al ejecutable.
    if (!existsSync(s.cwd)) throw new FalloRpc(codigosError.paramsInvalidos, `La carpeta de trabajo ya no existe: ${s.cwd}`);
    const proveedor = proveedorDe(s);
    const usuario: Mensaje = { rol: "usuario", texto, ...(adjuntos?.length ? { adjuntos } : {}) };
    s.mensajes.push(usuario);
    sesiones.anotar(s, usuario);
    const aprende = s.origen?.tipo !== "subagente";
    if (aprende) aprendizaje.alMensajeUsuario(s);
    const control = new AbortController();
    s.turno = control;
    sesiones.anotarInicioTurno(s);
    const a = ajustes.leer();
    if (!s.estado.has("terminal.entorno")) s.estado.set("terminal.entorno", a.herramientas.terminal);
    avisar(s);
    const emitirTurno = (e: Evento) => {
      emitir(e);
      x.alEvento?.(e);
    };
    const aprobar = async (p: PeticionAprobacion): Promise<RespuestaAprobacion> => {
      const g = ajustes.leer().herramientas.guardian;
      if (g.activo) {
        const d = await consultarGuardian({
          proveedor: g.proveedor ? proveedorPara(g.proveedor, g.modelo) : proveedor, peticion: p, cwd: s.cwd, mensajes: s.mensajes, senal: control.signal,
        });
        if (d.decision === "permitir") {
          log(`guardián permite ${p.herramienta} en ${s.id}: ${d.motivo}`);
          emitirTurno({ tipo: "herramienta.progreso", sesionId: s.id, id: p.id, texto: `Permitido por el guardián: ${d.motivo}\n` });
          return "permitir";
        }
      }
      return x.aprobar(p, control.signal);
    };
    return ejecutarTurno({
      sesionId: s.id,
      cwd: s.cwd,
      sistema: s.sistema,
      mensajes: s.mensajes,
      proveedor,
      herramientas: x.herramientas ?? herramientasDe(s),
      emitir: emitirTurno,
      senal: control.signal,
      entorno: s,
      alAnadir: (m) => {
        sesiones.anotar(s, m);
        if (aprende && m.rol === "herramienta") aprendizaje.alHerramienta(s);
      },
      alCompactar: () => sesiones.anotarCompactacion(s),
      aprobar,
      preguntar: (p) => x.preguntar(p, control.signal),
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
      .then((r) => {
        log(`turno ${s.id}: ${r.motivo}${r.error ? ` (${r.error})` : ""}`);
        sesiones.anotarUso(s, r.uso, r.motivo);
        return r;
      })
      .finally(() => {
        if (s.turno === control) s.turno = undefined;
        aprendizaje.aprendiendo.delete(s.id);
        avisar(s);
        if (aprende) aprendizaje.alTerminarTurno(s);
      })
      .then((r) => {
        // Con la sesión ya libre: si tiene objetivo, el juez decide si se relanza.
        void objetivos.alTerminarTurno(s, r).catch((e) => log(`objetivo de ${s.id}: ${e instanceof Error ? e.message : e}`));
        return r;
      });
  };

  /** ejecutarEn con adjuntos recién guardados: si el turno no llega a empezar (sesión ocupada mientras se guardaban…), se borran. */
  const ejecutarConAdjuntos = (s: Sesion, texto: string, x: OpcionesEjecucion, adjuntos?: AdjuntoGuardado[]): Promise<ResultadoTurno> => {
    try {
      return ejecutarEn(s, texto, x, adjuntos);
    } catch (e) {
      void borrarAdjuntos(adjuntos ?? []);
      throw e;
    }
  };

  const motor: Motor = {
    async turno(p: PeticionTurno) {
      const s = p.sesionId ? obtener(p.sesionId) : crearSesion(p.nueva?.cwd, p.nueva ?? {});
      if (!p.sesionId) p.alEvento?.({ tipo: "sesion.actualizada", sesion: vista(s) });
      const adjuntos = p.adjuntos?.length ? await guardarEn(s, p.adjuntos) : undefined;
      const resultado = await ejecutarConAdjuntos(s, p.texto, {
        aprobar: p.aprobar ? (q) => p.aprobar!(q) : async () => "denegar",
        preguntar: p.preguntar ? (q) => p.preguntar!(q) : async () => "No hay nadie para responder; decide tú.",
        alEvento: p.alEvento,
      }, adjuntos);
      return { sesionId: s.id, resultado };
    },
    existeSesion: (id) => sesiones.obtener(id) !== undefined,
    trabajando: (id) => sesiones.obtener(id)?.turno !== undefined,
    steer(id, texto) {
      const s = sesiones.obtener(id);
      if (!s?.turno) return false;
      s.steer.push(texto);
      return true;
    },
    parar(id) {
      const s = sesiones.obtener(id);
      if (!s?.turno) return false;
      s.turno.abort();
      return true;
    },
    notificar: (n) => emitir({ tipo: "notificacion", ...n }),
    emitir,
    ajustes: () => ajustes.leer(),
    log,
  };

  // Tareas programadas y canales: comparten carpeta (tareas.json, ejecuciones.jsonl, canales.json).
  const dirAutomatizaciones = o.perfil ? join(o.perfil, "automatizaciones") : null;
  const pasarela = new Pasarela({ dir: dirAutomatizaciones, motor, cwdPorDefecto: o.cwdPorDefecto });
  const programador = new Programador({ dir: dirAutomatizaciones, motor, pasarela, cwdPorDefecto: o.cwdPorDefecto });
  void pasarela
    .iniciar()
    .catch((e) => log(`pasarela: ${e instanceof Error ? e.message : e}`))
    .finally(() => programador.iniciar());

  const objetivos = new Objetivos({ motor, proveedorJuez: (id) => proveedorDe(obtener(id)), emitir, log });
  const kanban = new Kanban({ dir: o.perfil, motor, cwdPorDefecto: o.cwdPorDefecto });
  const plugins = new Plugins({ dir: o.perfil, alCambiar: () => emitir({ tipo: "plugins.actualizados" }), log });
  void plugins.cargar().catch((e) => log(`plugins: ${e instanceof Error ? e.message : e}`));
  extras.push(() => plugins.herramientas());

  // MCP: la lista de herramientas cambia en vivo, así que se pide en cada turno.
  const mcp = new ClienteMcp({ ruta: o.perfil ? join(o.perfil, "mcp.json") : null, alCambiar: () => emitir({ tipo: "mcp.actualizado" }), log });
  void mcp.iniciar().catch((e) => log(`mcp: ${e instanceof Error ? e.message : e}`));
  extras.push(() => mcp.herramientas());
  // Navegador: desactivado por defecto; un solo Edge para todas las sesiones.
  let navegador: Herramienta<any> | undefined;
  extras.push(() => {
    if (!ajustes.leer().herramientas.navegador) return [];
    navegador ??= herramientaNavegador({ perfil: o.perfil });
    return [navegador];
  });
  const voz = new Voz();
  const comoParamsAsync = async <T>(f: () => Promise<T> | T): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ErrorKanban || e instanceof ErrorPlugin || e instanceof ErrorCron || e instanceof ErrorCanal) {
        throw new FalloRpc(codigosError.paramsInvalidos, e.message);
      }
      throw e;
    }
  };

  const manejadores: { [M in NombreMetodo]: (params: any) => Resultados[M] | Promise<Resultados[M]> } = {
    "nucleo.info": () => {
      const a = ajustes.leer();
      return { version: o.version, protocolo: VERSION_PROTOCOLO, proveedor: a.proveedor, ...(a.modelo ? { modelo: a.modelo } : {}) };
    },
    "proveedores.listar": async () => ({ proveedores: await listarProveedores(o.incluirSimulado) }),
    "ajustes.leer": () => ajustes.leer(),
    "ajustes.guardar": async (cambios) => {
      const antes = ajustes.leer();
      if (cambios.esfuerzo !== undefined || cambios.proveedor !== undefined || cambios.modelo !== undefined) {
        const proveedor = cambios.proveedor ?? antes.proveedor;
        const modelo = cambios.modelo ?? (cambios.proveedor && cambios.proveedor !== antes.proveedor ? "" : antes.modelo);
        cambios.esfuerzo = (await esfuerzoValido(proveedor, modelo || undefined, cambios.esfuerzo ?? antes.esfuerzo)) ?? "";
      }
      const r = ajustes.guardar(cambios);
      if (!r.herramientas.navegador && navegador) {
        navegador = undefined;
        void cerrarNavegador();
      }
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
      objetivos.fijar({ id: sesionId }, null);
      return { borrada: true };
    },
    "prompt.enviar": async ({ sesionId, texto, adjuntos }) => {
      const s = obtener(sesionId);
      if (s.turno) throw new FalloRpc(codigosError.sesionOcupada, "La sesión ya está trabajando; usa prompt.steer");
      // Cada `@ruta` que es un fichero de la carpeta de la sesión va como adjunto.
      const todos = await conMenciones(texto, s.cwd, adjuntos ?? []);
      const guardados = todos.length ? await guardarEn(s, todos) : undefined;
      const orden = /^\/aprender(?:\s+([\s\S]+))?$/.exec(texto.trim());
      if (orden && !orden[1] && !guardados) return revisarComoTurno(s, texto);
      if (orden) aprendizaje.aprendiendo.add(s.id);
      // `/aprender` con adjuntos y sin más: la fuente son los adjuntos.
      const pedido = orden ? instruccionAprender(orden[1]?.trim() || "los ficheros adjuntos a este mensaje") : texto;
      void ejecutarConAdjuntos(s, pedido, { aprobar: aprobarEnApp(s), preguntar: preguntarEnApp(s) }, guardados);
      return { aceptado: true };
    },
    "adjuntos.leer": async ({ sesionId, id }) => {
      const s = obtener(sesionId);
      const adjunto = await leerAdjunto(carpetaAdjuntos(o.perfil, s.id), id);
      if (!adjunto) throw new FalloRpc(codigosError.paramsInvalidos, `No hay ningún adjunto ${id} en esta sesión`);
      return adjunto;
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
      const antes = comoParams(() => memoria.leer(destino, cwd)).entradas;
      const bloque = comoParams(() => memoria.guardar(destino, entradas, cwd));
      emitir({ tipo: "memoria.actualizada", destino, ...(destino === "proyecto" && cwd ? { cwd } : {}) });
      const anadidas = bloque.entradas.filter((e) => !antes.includes(e)).length;
      const quitadas = antes.filter((e) => !bloque.entradas.includes(e)).length;
      if (anadidas || quitadas) {
        registro.anotar({ origen: { tipo: "manual" }, tipo: "memoria", resumen: `Memoria de ${destino} editada en la app (+${anadidas} −${quitadas})` });
        emitir({ tipo: "aprendizaje.actualizado" });
      }
      return bloque;
    },
    "memoria.alma": ({ texto }) => {
      const guardado = memoria.guardarAlma(texto);
      emitir({ tipo: "memoria.actualizada", destino: "alma" });
      return { texto: guardado };
    },
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
    "artefactos.vista": ({ tipo, contenido }) => ({ ruta: vistas.publicar(tipo, contenido) }),
    "artefactos.guardar": async ({ sesionId, nombre, contenido, sobrescribir }) => {
      const s = obtener(sesionId);
      try {
        return { ruta: await guardarArtefacto(s.cwd, nombre, contenido, sobrescribir) };
      } catch (e) {
        throw fallo(e, e instanceof FicheroYaExiste ? codigosError.yaExiste : codigosError.paramsInvalidos);
      }
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
    "buscar.sesiones": ({ consulta, limite }) => ({ resultados: indice.buscar(consulta, limite) }),
    // Provisionales: los conectan los módulos de documentos y de comandos.
    "documentos.leer": () => {
      throw new FalloRpc(codigosError.metodoNoExiste, "Todavía no disponible");
    },
    "documentos.exportar": () => {
      throw new FalloRpc(codigosError.metodoNoExiste, "Todavía no disponible");
    },
    "comandos.listar": () => {
      throw new FalloRpc(codigosError.metodoNoExiste, "Todavía no disponible");
    },
    "ficheros.buscar": async ({ cwd, consulta, limite }) => {
      if (!isAbsolute(cwd) || !existsSync(cwd)) throw new FalloRpc(codigosError.paramsInvalidos, `No existe la carpeta ${cwd}`);
      return { ficheros: await buscarFicheros(cwd, consulta, limite) };
    },
    "aprendizaje.listar": ({ todas }) => ({ propuestas: registro.propuestas(todas) }),
    "aprendizaje.decidir": ({ id, decision }) => {
      if (!registro.propuesta(id)) throw new FalloRpc(codigosError.paramsInvalidos, `No existe la propuesta ${id}`);
      return aprendizaje.decidir(id, decision);
    },
    "aprendizaje.revisar": ({ sesionId }) => {
      const s = obtener(sesionId);
      if (aprendizaje.revisando(s.id)) return { iniciada: false };
      void aprendizaje.revisar(s, { completa: true });
      return { iniciada: true };
    },
    "aprendizaje.historial": ({ limite }) => ({ entradas: registro.historial(limite) }),
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
    "kanban.listar": () => ({ tarjetas: kanban.listar() }),
    "kanban.crear": (p) => comoParamsAsync(() => kanban.crear(p)),
    "kanban.editar": (p) => comoParamsAsync(() => kanban.editar(p)),
    "kanban.borrar": ({ id }) => comoParamsAsync(() => {
      kanban.borrar(id);
      return { borrada: true as const };
    }),
    "kanban.ejecutar": ({ id }) => comoParamsAsync(() => kanban.ejecutar(id)),
    "plugins.listar": () => ({ plugins: plugins.listar() }),
    "plugins.activar": ({ nombre, activo }) => comoParamsAsync(() => plugins.activar(nombre, activo)),
    "estadisticas.leer": ({ dias }) =>
      calcularEstadisticas({
        dirSesiones: o.perfil ? join(o.perfil, "sesiones") : null,
        historial: registro.historial(10_000),
        registroSkills: Object.fromEntries(skills.listar(undefined, { archivadas: true }).map((x) => [x.nombre, { usos: x.usos }])),
        dias,
      }),
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
  };

  function necesitaPerfil(): { nombre: string; datos: string } {
    if (!o.nombrePerfil || !o.datos) throw new FalloRpc(codigosError.metodoNoExiste, "Este núcleo no tiene perfil en disco");
    return { nombre: o.nombrePerfil, datos: o.datos };
  }

  function conCambioDeSkills<T>(f: () => T): T {
    const r = comoParams(f);
    emitir({ tipo: "skills.actualizadas" });
    return r;
  }

  /** `/aprender` sin fuente: revisa la conversación entera ahora y lo cuenta como un turno. */
  function revisarComoTurno(s: Sesion, texto: string): { aceptado: true } {
    const usuario: Mensaje = { rol: "usuario", texto };
    s.mensajes.push(usuario);
    sesiones.anotar(s, usuario);
    const control = new AbortController();
    s.turno = control;
    avisar(s);
    void aprendizaje
      .revisar(s, { completa: true })
      .then((r) => {
        const respuesta =
          r.estado === "hecha"
            ? [
                r.aplicadas ? `He guardado ${r.aplicadas} ${r.aplicadas === 1 ? "cambio" : "cambios"}.` : "",
                r.propuestas ? `Hay ${r.propuestas} ${r.propuestas === 1 ? "propuesta" : "propuestas"} esperando en Memoria → Propuestas.` : "",
                r.texto.trim(),
              ].filter(Boolean).join("\n\n")
            : r.estado === "omitida"
              ? `No he revisado nada: ${r.motivo}.`
              : `La revisión falló: ${r.error}`;
        emitir({ tipo: "mensaje.delta", sesionId: s.id, texto: respuesta });
        const asistente: Mensaje = { rol: "asistente", texto: respuesta, llamadas: [] };
        s.mensajes.push(asistente);
        sesiones.anotar(s, asistente);
        emitir({ tipo: "turno.fin", sesionId: s.id, motivo: "fin", texto: respuesta, uso: { entrada: 0, salida: 0 } });
      })
      .finally(() => {
        if (s.turno === control) s.turno = undefined;
        avisar(s);
      });
    return { aceptado: true };
  }

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
      if (peticion.error?.code === codigosError.metodoNoExiste && --p.faltan > 0) return undefined;
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
    hostname: o.host ?? "127.0.0.1",
    port: o.puerto,
    fetch(req, srv) {
      const url = new URL(req.url);
      // Vistas de artefactos: sin token (la clave aleatoria de la ruta es el permiso) y aisladas por su CSP `sandbox`.
      if (req.method === "GET") {
        const vistaArtefacto = vistas.responder(url.pathname);
        if (vistaArtefacto) return vistaArtefacto;
      }
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
      // Por defecto, 16 MB: un mensaje mayor cierra la conexión (1009).
      maxPayloadLength: MAX_MENSAJE_WS,
      // Con un cliente lento (modo remoto), tras un adjuntos.leer grande el búfer pasaría del límite por defecto
      // (16 MB) y lo que se mandara detrás se descartaría.
      backpressureLimit: MAX_MENSAJE_WS,
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
    motor,
    async detener() {
      for (const s of sesiones.enCurso()) {
        s.turno?.abort();
        await cerrarEstadoSesion(s.estado);
      }
      servidor.stop(true);
      clearInterval(relojCurador);
      programador.detener();
      await pasarela.detener().catch(() => undefined);
      voz.parar();
      await mcp.detener().catch(() => undefined);
      await cerrarNavegador().catch(() => undefined);
      aprendizaje.cerrar();
      descargas.cancelarTodas();
      await servidorLlamaCpp().parar().catch(() => undefined);
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
