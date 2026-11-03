/**
 * Servidor JSON-RPC 2.0 por WebSocket, solo en 127.0.0.1.
 * Exige el token en `?token=` y, si el cliente es un navegador (envía Origin),
 * que el origen sea el de la app. También pide cosas a la interfaz (aprobaciones,
 * preguntas) y espera su respuesta.
 * Aquí se crean las piezas del núcleo y el contexto que comparten; los manejadores de cada área están en
 * servidor/rutas-*.ts.
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codigosError,
  MAX_ADJUNTOS,
  MAX_BYTES_ADJUNTO,
  metodos,
  RUTA_RPC,
  PASOS_POR_TURNO,
  type ErrorRpc,
  type InfoSesion,
  type Evento,
  type NombreMetodo,
  type NombrePeticionCliente,
  type PeticionesCliente,
  type PeticionRpc,
  type RespuestaRpc,
} from "@aquiles/protocolo";
import type { ServerWebSocket } from "bun";
import { type AdjuntoEntrante, borrarAdjuntos, carpetaAdjuntos, ErrorAdjunto, guardarAdjuntos } from "./adjuntos";
import { AJUSTES_HERRAMIENTAS, AlmacenAjustes } from "./ajustes";
import { VistasArtefactos } from "./artefactos";
import { AJUSTES_APRENDIZAJE, Aprendizaje } from "./aprendizaje";
import { ejecutarTurno, type PeticionAprobacion, type RespuestaAprobacion, type ResultadoTurno } from "./bucle";
import { Comandos } from "./comandos";
import { abrirConocimiento } from "./conocimiento";
import { Programador } from "./cron";
import { consultarGuardian } from "./guardian";
import { ErrorHerramienta, type Herramienta, type Pregunta } from "./herramientas/herramienta";
import { cerrarEstadoSesion } from "./herramientas/index";
import { cerrarNavegador, herramientaNavegador } from "./herramientas/navegador";
import { Descargas } from "./locales/huggingface";
import { ClienteMcp } from "./mcp";
import type { Motor, PeticionTurno } from "./motor";
import { Objetivos } from "./objetivos";
import { Pasarela } from "./pasarela";
import { Plugins } from "./plugins";
import { crearProveedor, servidorLlamaCpp } from "./proveedores/index";
import { AlmacenSesiones, info, type OpcionesSesion, type Sesion, titulo } from "./sesiones";
import { herramientaDelegar, type LanzarSubagente } from "./subagentes";
import { Voz } from "./voz";
import { Auditoria } from "./auditoria";
import { herramientaGenerarImagen } from "./herramientas/imagen";
import { serviciosDisponibles } from "./imagenes";
import { AVISO_DESDE_MS, fraseDeFin } from "./aviso-fin";
import type { AdjuntoGuardado, Mensaje, Proveedor } from "./tipos";
import type { ContextoServidor, Manejadores, OpcionesEjecucion } from "./servidor/contexto";
import { FalloRpc } from "./servidor/errores";
import { rutasAjustesModelos } from "./servidor/rutas-ajustes-modelos";
import { rutasAutomatizaciones } from "./servidor/rutas-automatizaciones";
import { rutasAuditoria } from "./servidor/rutas-auditoria";
import { rutasContenido } from "./servidor/rutas-contenido";
import { rutasExtensiones } from "./servidor/rutas-extensiones";
import { rutasSesiones } from "./servidor/rutas-sesiones";
import { rutasSistema } from "./servidor/rutas-sistema";

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
  /** Duración mínima de un turno para avisar al acabar (por defecto AVISO_DESDE_MS; los tests la bajan). */
  avisoFinDesdeMs?: number;
  origenesPermitidos?: readonly string[];
  log?: (mensaje: string) => void;
}

export interface Servidor {
  puerto: number;
  /** Para lanzar turnos sin la interfaz (tareas programadas, canales). */
  motor: Motor;
  detener(): Promise<void>;
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
  /** Registro de auditoría y copias para deshacer, por sesión. */
  const auditoria = new Auditoria(o.perfil ? join(o.perfil, "auditoria") : null);

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
    maxPasos: PASOS_POR_TURNO.porDefecto,
    idioma: "es",
    voz: { velocidad: 0, alAcabar: "voz" },
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
    const inicioTurno = Date.now();
    const turno = `${inicioTurno}`;
    auditoria.empezarTurno(s.id, turno, texto);
    /** Llamadas que dejó pasar el guardián (en el registro, como suyas). */
    const delGuardian = new Set<string>();
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
          delGuardian.add(p.id);
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
      auditoria: {
        antes: (rutas) => auditoria.antes(s.id, turno, rutas),
        despues: (rutas) => auditoria.despues(s.id, turno, rutas),
        registrar: (e, id) =>
          auditoria.registrar(s.id, { ...e, aprobacion: delGuardian.has(id) ? "guardian" : e.aprobacion, fecha: new Date().toISOString(), turno }),
      },
      senal: control.signal,
      maxIteraciones: a.maxPasos,
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
        // Una tarea larga de la app que acaba (sin objetivo pendiente, que podría relanzarla): «He acabado …».
        if (r.motivo === "fin" && !s.origen && objetivos.de(s.id)?.estado !== "activo" && Date.now() - inicioTurno >= (o.avisoFinDesdeMs ?? AVISO_DESDE_MS)) {
          void avisarFin(s).catch((e) => log(`aviso de fin de ${s.id}: ${e instanceof Error ? e.message : e}`));
        }
        return r;
      });
  };

  /** La frase la escribe el modelo de la sesión; va como notificación y, si así se quiere, en voz alta. */
  const avisarFin = async (s: Sesion) => {
    const modo = ajustes.leer().voz.alAcabar;
    if (modo === "nada") return;
    const frase = await fraseDeFin({ proveedor: proveedorDe(s), mensajes: s.mensajes, cwd: s.cwd });
    emitir({ tipo: "notificacion", titulo: s.titulo ?? "Aquiles", texto: frase, sesionId: s.id });
    // Sin pisar un dictado o una lectura en marcha.
    if (modo === "voz" && !(await voz.estado()).ocupada) await voz.leer(frase);
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
  const comandos = new Comandos({
    skills, objetivos, aprendizaje, sesiones, proveedorDe, emitir, avisar,
    turno: (s, texto, adjuntos) => void ejecutarConAdjuntos(s, texto, { aprobar: aprobarEnApp(s), preguntar: preguntarEnApp(s) }, adjuntos),
    carpetaPorDefecto: () => ajustes.leer().carpeta,
  });
  const plugins = new Plugins({ dir: o.perfil, alCambiar: () => emitir({ tipo: "plugins.actualizados" }), log });
  void plugins.cargar().catch((e) => log(`plugins: ${e instanceof Error ? e.message : e}`));
  extras.push(() => plugins.herramientas());

  // MCP: la lista de herramientas cambia en vivo, así que se pide en cada turno.
  const mcp = new ClienteMcp({ ruta: o.perfil ? join(o.perfil, "mcp.json") : null, alCambiar: () => emitir({ tipo: "mcp.actualizado" }), log });
  void mcp.iniciar().catch((e) => log(`mcp: ${e instanceof Error ? e.message : e}`));
  extras.push(() => mcp.herramientas());
  // Navegador: desactivado por defecto; un solo Edge para todas las sesiones.
  let navegador: Herramienta<any> | undefined;
  // Generar imágenes: solo con alguna clave de un servicio que las haga (Gemini, OpenAI, OpenRouter).
  const generarImagen = herramientaGenerarImagen();
  extras.push(() => (serviciosDisponibles().length ? [generarImagen] : []));
  extras.push(() => {
    if (!ajustes.leer().herramientas.navegador) return [];
    navegador ??= herramientaNavegador({ perfil: o.perfil });
    return [navegador];
  });
  const voz = new Voz({ ajustes: () => ajustes.leer().voz });

  const contexto: ContextoServidor = {
    o, log, emitir,
    ajustes, sesiones, auditoria, memoria, skills, indice, registro, aprendizaje, objetivos, comandos,
    pasarela, programador, plugins, mcp, voz, vistas, descargas,
    proveedores, claveProveedor,
    soltarNavegador: () => {
      if (!navegador) return;
      navegador = undefined;
      void cerrarNavegador();
    },
    obtener, vista, avisar, crearSesion, guardarEn, ejecutarConAdjuntos, aprobarEnApp, preguntarEnApp, curar,
  };
  const manejadores: Manejadores = {
    ...rutasSistema(contexto),
    ...rutasAjustesModelos(contexto),
    ...rutasSesiones(contexto),
    ...rutasContenido(contexto),
    ...rutasAuditoria(contexto),
    ...rutasExtensiones(contexto),
    ...rutasAutomatizaciones(contexto),
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
