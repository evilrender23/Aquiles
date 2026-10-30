/**
 * Protocolo entre la interfaz (o cualquier cliente) y el núcleo de Aquiles:
 * JSON-RPC 2.0 sobre WebSocket. Los esquemas de parámetros son la única fuente
 * de verdad y se validan en el núcleo; los tipos se comparten con la interfaz.
 *
 * Además de responder, el núcleo hace peticiones al cliente (aprobaciones y preguntas)
 * con ids de texto que empiezan por "n"; el cliente contesta con el mismo id.
 */
import { z } from "zod";

export * from "./artefactos";

export const VERSION_PROTOCOLO = 11;

/** Línea que el núcleo imprime en stdout cuando ya escucha: `AQUILES_READY port=N`. */
export const LINEA_LISTO = "AQUILES_READY";

/** Ruta del WebSocket; el token va en `?token=`. */
export const RUTA_RPC = "/rpc";

export const MODOS_APROBACION = ["preguntar-siempre", "preguntar-ejecutar", "libre-proyecto"] as const;
export type ModoAprobacion = (typeof MODOS_APROBACION)[number];

/** Dónde corre la terminal: en este equipo, en un contenedor Docker o en otra máquina por SSH. */
export const ENTORNOS_TERMINAL = ["local", "docker", "ssh"] as const;
export type EntornoTerminal = (typeof ENTORNOS_TERMINAL)[number];

/** Columnas del kanban, en orden. */
export const COLUMNAS_KANBAN = ["pendiente", "en-curso", "revision", "hecha"] as const;
export type ColumnaKanban = (typeof COLUMNAS_KANBAN)[number];

/** Canales por los que Aquiles entrega resultados y, si el canal lo permite, conversa. */
export const CANALES = ["escritorio", "terminal", "telegram", "discord", "slack", "correo"] as const;
export type IdCanal = (typeof CANALES)[number];

const idSesion = z.string().min(1);

/** Hasta 10 adjuntos por mensaje y 25 MB cada uno. */
export const MAX_ADJUNTOS = 10;
export const MAX_BYTES_ADJUNTO = 25 * 1024 * 1024;

/**
 * Un fichero adjunto a un mensaje. La app de escritorio manda la ruta (el núcleo lo lee de disco); el navegador y el
 * portapapeles mandan el contenido en base64. Exactamente uno de los dos.
 */
const adjunto = z
  .object({
    nombre: z.string().min(1).max(255),
    /** Tipo MIME; si falta, se deduce de la extensión. */
    tipo: z.string().max(200).optional(),
    ruta: z.string().min(1).optional(),
    datos: z.string().optional(),
  })
  .refine((a) => (a.ruta === undefined) !== (a.datos === undefined), "Cada adjunto lleva ruta o datos, uno de los dos");

export const metodos = {
  "nucleo.info": z.object({}),
  /** Proveedores conocidos, si están disponibles ahora y sus modelos. */
  "proveedores.listar": z.object({}),
  /** Ajustes por defecto del perfil (los usan las sesiones nuevas). */
  "ajustes.leer": z.object({}),
  "ajustes.guardar": z.object({
    proveedor: z.string().min(1).optional(),
    modelo: z.string().optional(),
    /** Nivel de esfuerzo de razonamiento; "" = el del modelo. */
    esfuerzo: z.string().optional(),
    modoAprobacion: z.enum(MODOS_APROBACION).optional(),
    carpeta: z.string().min(1).optional(),
    aprendizaje: z
      .object({
        activo: z.boolean().optional(),
        cadaHerramientas: z.number().int().min(1).max(500).optional(),
        cadaMensajes: z.number().int().min(1).max(500).optional(),
        aplicarSinPreguntar: z.boolean().optional(),
        proveedor: z.string().optional(),
        modelo: z.string().optional(),
      })
      .optional(),
    herramientas: z
      .object({
        navegador: z.boolean().optional(),
        terminal: z
          .object({ entorno: z.enum(ENTORNOS_TERMINAL).optional(), imagen: z.string().min(1).optional(), ssh: z.string().optional() })
          .optional(),
        guardian: z.object({ activo: z.boolean().optional(), proveedor: z.string().optional(), modelo: z.string().optional() }).optional(),
      })
      .optional(),
  }),
  /** Clave de API para este proceso (no se guarda: la app la guarda en el llavero y la pasa al arrancar). */
  "ajustes.clave": z.object({ proveedor: z.string().min(1), clave: z.string() }),
  "sesion.crear": z.object({
    cwd: z.string().min(1).optional(),
    modoAprobacion: z.enum(MODOS_APROBACION).optional(),
    proveedor: z.string().min(1).optional(),
    modelo: z.string().optional(),
    esfuerzo: z.string().optional(),
  }),
  "sesion.listar": z.object({}),
  "sesion.reanudar": z.object({ sesionId: idSesion }),
  /** Cambia proveedor, modelo o permisos de una sesión (vale desde el siguiente turno). */
  "sesion.ajustar": z.object({
    sesionId: idSesion,
    proveedor: z.string().min(1).optional(),
    modelo: z.string().optional(),
    /** "" = el del modelo. Un nivel que el modelo no admite se ignora. */
    esfuerzo: z.string().optional(),
    modoAprobacion: z.enum(MODOS_APROBACION).optional(),
  }),
  "sesion.renombrar": z.object({ sesionId: idSesion, titulo: z.string().min(1).max(120) }),
  "sesion.borrar": z.object({ sesionId: idSesion }),
  /** Texto y, si hay, ficheros adjuntos (documentos, imágenes…). Puede ir sin texto si lleva adjuntos. */
  "prompt.enviar": z
    .object({ sesionId: idSesion, texto: z.string(), adjuntos: z.array(adjunto).max(MAX_ADJUNTOS).optional() })
    .refine((p) => p.texto.trim().length > 0 || (p.adjuntos?.length ?? 0) > 0, "Hace falta texto o algún adjunto"),
  /** Contenido de un adjunto guardado (para las miniaturas y para abrirlo), en base64. */
  "adjuntos.leer": z.object({ sesionId: idSesion, id: z.string().min(1) }),
  "prompt.steer": z.object({ sesionId: idSesion, texto: z.string().min(1) }),
  "prompt.parar": z.object({ sesionId: idSesion }),
  /** Memoria del perfil; con `cwd`, también la del proyecto de esa carpeta. */
  "memoria.leer": z.object({ cwd: z.string().min(1).optional() }),
  /** Sustituye todas las entradas de un destino (la interfaz edita la lista entera). */
  "memoria.guardar": z.object({
    destino: z.enum(["usuario", "agente", "proyecto"]),
    cwd: z.string().min(1).optional(),
    entradas: z.array(z.string()),
  }),
  /** Personalidad (SOUL.md). Vale para las sesiones nuevas. */
  "memoria.alma": z.object({ texto: z.string() }),
  /** Con `archivadas`, también las que el curador archivó. */
  "skills.listar": z.object({ cwd: z.string().min(1).optional(), archivadas: z.boolean().optional() }),
  "skills.leer": z.object({ nombre: z.string().min(1), cwd: z.string().min(1).optional() }),
  "skills.ajustar": z.object({ nombre: z.string().min(1), activa: z.boolean(), cwd: z.string().min(1).optional() }),
  /** Curador (solo skills del perfil): fijar evita que se marquen obsoletas o se archiven. */
  "skills.fijar": z.object({ nombre: z.string().min(1), fijada: z.boolean() }),
  "skills.archivar": z.object({ nombre: z.string().min(1) }),
  "skills.restaurar": z.object({ nombre: z.string().min(1) }),
  /** Copias guardadas antes de cada cambio de una skill del perfil. */
  "skills.versiones": z.object({ nombre: z.string().min(1) }),
  "skills.restaurarVersion": z.object({ nombre: z.string().min(1), version: z.string().min(1) }),
  /** Pasa el curador ahora (también corre al arrancar y una vez al día). */
  "skills.curar": z.object({}),
  /** Propuestas de lo aprendido; por defecto solo las pendientes. */
  "aprendizaje.listar": z.object({ todas: z.boolean().optional() }),
  "aprendizaje.decidir": z.object({ id: z.string().min(1), decision: z.enum(["aceptar", "descartar"]) }),
  /** Lanza ahora la revisión de lo aprendido en una sesión (en segundo plano). */
  "aprendizaje.revisar": z.object({ sesionId: idSesion }),
  /** Lo aprendido, del más reciente al más antiguo, con su origen. */
  "aprendizaje.historial": z.object({ limite: z.number().int().min(1).max(1000).optional() }),
  /** Tareas programadas (fase 5). */
  "cron.listar": z.object({}),
  "cron.crear": z.object({
    nombre: z.string().min(1).max(120),
    prompt: z.string().min(1),
    cuando: z.string().min(1),
    cwd: z.string().min(1).optional(),
    proveedor: z.string().min(1).optional(),
    modelo: z.string().optional(),
    modoAprobacion: z.enum(MODOS_APROBACION).optional(),
    entrega: z.array(z.object({ canal: z.enum(CANALES), destino: z.string().min(1).optional() })).optional(),
  }),
  "cron.editar": z.object({
    id: z.string().min(1),
    nombre: z.string().min(1).max(120).optional(),
    prompt: z.string().min(1).optional(),
    cuando: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    proveedor: z.string().optional(),
    modelo: z.string().optional(),
    modoAprobacion: z.enum(MODOS_APROBACION).optional(),
    entrega: z.array(z.object({ canal: z.enum(CANALES), destino: z.string().min(1).optional() })).optional(),
    activa: z.boolean().optional(),
  }),
  "cron.borrar": z.object({ id: z.string().min(1) }),
  /** Ejecuta la tarea ahora, sin esperar a su hora. */
  "cron.ejecutar": z.object({ id: z.string().min(1) }),
  "cron.ejecuciones": z.object({ id: z.string().min(1).optional(), limite: z.number().int().min(1).max(500).optional() }),
  /** Comprueba una expresión de «cuando» sin crear nada: descripción y próximas ejecuciones. */
  "cron.interpretar": z.object({ cuando: z.string().min(1) }),
  "canales.listar": z.object({}),
  /** Opciones de un canal que no son secretas (los tokens van con ajustes.clave). */
  "canales.configurar": z.object({ canal: z.enum(CANALES), opciones: z.record(z.string(), z.string()) }),
  /** Código de un solo uso para emparejar un chat: se le envía al bot desde ese chat. */
  "canales.emparejar": z.object({ canal: z.enum(CANALES) }),
  "canales.desemparejar": z.object({ canal: z.enum(CANALES), chatId: z.string().min(1) }),
  "canales.probar": z.object({ canal: z.enum(CANALES), destino: z.string().min(1).optional() }),
  /** Servidores MCP (fase 6): sus herramientas se ofrecen al agente como mcp__<servidor>__<herramienta>. */
  "mcp.listar": z.object({}),
  "mcp.guardar": z.object({
    nombre: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    comando: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
    activo: z.boolean().optional(),
  }),
  "mcp.borrar": z.object({ nombre: z.string().min(1) }),
  "mcp.reconectar": z.object({ nombre: z.string().min(1) }),
  /** Voz local: dictado con el reconocedor del sistema y lectura con sus voces. */
  "voz.estado": z.object({}),
  "voz.dictar": z.object({ segundos: z.number().int().min(1).max(120).optional() }),
  "voz.leer": z.object({ texto: z.string().min(1).max(20_000) }),
  "voz.parar": z.object({}),
  /** Perfiles (fase 7): cada uno con sus sesiones, memoria, skills y ajustes. Cambiar de perfil reinicia el núcleo. */
  "perfiles.listar": z.object({}),
  "perfiles.crear": z.object({ nombre: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/) }),
  /** Copias del perfil actual en %APPDATA%\\Aquiles\\copias (zip). Restaurar reinicia el núcleo. */
  "copias.listar": z.object({}),
  "copias.crear": z.object({}),
  "copias.restaurar": z.object({ nombre: z.string().min(1) }),
  /** Objetivo de una sesión (fase 8): tras cada turno un juez decide si se cumplió; si no, Aquiles sigue solo. */
  "sesion.objetivo": z.object({ sesionId: idSesion, objetivo: z.string().max(2000).nullable(), maxIntentos: z.number().int().min(1).max(20).optional() }),
  /** Kanban multiagente: cada tarjeta se puede encargar a un agente, que trabaja en su propia sesión. */
  "kanban.listar": z.object({}),
  "kanban.crear": z.object({ titulo: z.string().min(1).max(200), descripcion: z.string().max(20_000).optional(), columna: z.enum(COLUMNAS_KANBAN).optional(), cwd: z.string().min(1).optional() }),
  "kanban.editar": z.object({ id: z.string().min(1), titulo: z.string().min(1).max(200).optional(), descripcion: z.string().max(20_000).optional(), columna: z.enum(COLUMNAS_KANBAN).optional(), orden: z.number().optional() }),
  "kanban.borrar": z.object({ id: z.string().min(1) }),
  /** Encarga la tarjeta a un agente: sesión nueva con la descripción como tarea; la tarjeta pasa a «en curso». */
  "kanban.ejecutar": z.object({ id: z.string().min(1) }),
  /** Plugins: código propio del usuario en <perfil>/plugins que añade herramientas. Desactivados hasta que se activan. */
  "plugins.listar": z.object({}),
  "plugins.activar": z.object({ nombre: z.string().min(1), activo: z.boolean() }),
  /** Estadísticas de uso y línea temporal de lo aprendido. */
  "estadisticas.leer": z.object({ dias: z.number().int().min(1).max(365).optional() }),
  "buscar.sesiones": z.object({ consulta: z.string().min(1), limite: z.number().int().min(1).max(100).optional() }),
  /**
   * Ficheros de una carpeta de trabajo para mencionarlos con `@` (sin .git, node_modules… ni lo del .gitignore).
   * Al enviar, cada `@ruta` que sea un fichero de la carpeta de la sesión llega al modelo como adjunto.
   */
  "ficheros.buscar": z.object({ cwd: z.string().min(1), consulta: z.string().max(200), limite: z.number().int().min(1).max(100).optional() }),
  /** Un documento para el visor: .md tal cual; .docx convertido a HTML (se ve aislado con artefactos.vista). */
  "documentos.leer": z.object({ ruta: z.string().min(1) }),
  /** Guarda un texto en markdown como documento de Word en la carpeta de trabajo de la sesión (como artefactos.guardar). */
  "documentos.exportar": z.object({
    sesionId: idSesion,
    nombre: z.string().min(1).max(200),
    markdown: z.string().max(20_000_000),
    sobrescribir: z.boolean().optional(),
  }),
  /** Comandos con «/» para la caja de texto: los de Aquiles y uno por skill activa. */
  "comandos.listar": z.object({ sesionId: idSesion.optional() }),
  /**
   * Publica un artefacto HTML o SVG para verlo en un iframe aislado: el núcleo lo sirve en `/vista/<clave>` (clave
   * aleatoria, sin token) con CSP `sandbox`, fuera del origen de la app. Caduca a la hora o al publicar 50 más.
   */
  "artefactos.vista": z.object({ tipo: z.enum(["html", "svg"]), contenido: z.string().max(5_000_000) }),
  /** Guarda un artefacto como fichero en la carpeta de trabajo de la sesión. Sin `sobrescribir`, falla si ya existe. */
  "artefactos.guardar": z.object({
    sesionId: idSesion,
    nombre: z.string().min(1).max(200),
    contenido: z.string().max(20_000_000),
    sobrescribir: z.boolean().optional(),
  }),
  /** Modelos GGUF de Hugging Face (los ejecuta llama.cpp como proveedor `llamacpp`). */
  "modelos.buscar": z.object({ consulta: z.string().min(1).max(200) }),
  "modelos.repo": z.object({ repo: z.string().min(3).max(200) }),
  /** `fichero` y `proyector` son el `nombre` de un FicheroModeloHF del repositorio; el núcleo resuelve partes y tamaños. */
  "modelos.descargar": z.object({ repo: z.string().min(3).max(200), fichero: z.string().min(1), proyector: z.string().min(1).optional() }),
  "modelos.cancelar": z.object({ id: z.string().min(1) }),
  "modelos.borrar": z.object({ id: z.string().min(1) }),
  "modelos.listar": z.object({}),
  /** Instala llama.cpp con winget (paquete del usuario, sin administrador). Lo pide el usuario con un botón. */
  "modelos.instalarMotor": z.object({}),
};

export type NombreMetodo = keyof typeof metodos;
export type Params<M extends NombreMetodo> = z.infer<(typeof metodos)[M]>;

export interface InfoProveedor {
  /** Lo que se pasa como `proveedor` (agy, anthropic, ollama…). */
  id: string;
  nombre: string;
  disponible: boolean;
  /** Por qué no está disponible (falta la clave, no está instalado, no responde…). */
  motivo?: string;
  necesitaClave: boolean;
  /** Modelos conocidos; vacío = se escribe el id a mano. */
  modelos: string[];
  /** Modelo que se usa si no se elige ninguno; ausente = el del propio proveedor. */
  modeloPorDefecto?: string;
  /**
   * Niveles de esfuerzo de razonamiento, tal como los declara el proveedor (su CLI, su catálogo o su API); nunca
   * supuestos. Para un modelo valen los de `porModelo[modelo]` si existen, y si no los generales. Sin niveles, no hay
   * selector. Sin `porDefecto`, el proveedor no dice cuál usa si no se pasa ninguno.
   */
  esfuerzo?: EsfuerzoModelo & { porModelo?: Record<string, EsfuerzoModelo> };
}

export interface EsfuerzoModelo {
  niveles: string[];
  porDefecto?: string;
}

export interface Ajustes {
  proveedor: string;
  modelo?: string;
  esfuerzo?: string;
  modoAprobacion: ModoAprobacion;
  /** Carpeta de trabajo de las sesiones nuevas. */
  carpeta: string;
  aprendizaje: AjustesAprendizaje;
  herramientas: AjustesHerramientas;
}

export interface AjustesHerramientas {
  /** Navegador controlado (Edge por CDP). Desactivado por defecto. */
  navegador: boolean;
  /** Dónde corre la terminal de las sesiones nuevas; imagen = la de Docker; ssh = destino (usuario@host). */
  terminal: { entorno: EntornoTerminal; imagen: string; ssh?: string };
  /** Guardián: un modelo auxiliar aprueba lo claramente seguro antes de preguntarte; lo demás se pregunta igual. */
  guardian: { activo: boolean; proveedor?: string; modelo?: string };
}

export interface AjustesAprendizaje {
  /** Revisar lo aprendido en segundo plano al pasar los umbrales. */
  activo: boolean;
  /** Herramientas ejecutadas desde la última revisión de la sesión. */
  cadaHerramientas: number;
  /** Mensajes del usuario desde la última revisión de la sesión. */
  cadaMensajes: number;
  /** Aplica lo que proponga la revisión sin pasar por la cola de propuestas. */
  aplicarSinPreguntar: boolean;
  /** Modelo auxiliar de la revisión; si falta, el de la sesión revisada. */
  proveedor?: string;
  modelo?: string;
}

export interface InfoSesion {
  sesionId: string;
  cwd: string;
  titulo?: string;
  creada: string;
  actualizada: string;
  mensajes: number;
  modoAprobacion: ModoAprobacion;
  proveedor: string;
  modelo?: string;
  /** Esfuerzo elegido; ausente = el del modelo. */
  esfuerzo?: string;
  /** Hay un turno en marcha. */
  trabajando: boolean;
  /** Quién la abrió si no fue la app: una tarea programada (cron) o un chat de un canal. */
  origen?:
    | { tipo: "cron"; tareaId: string }
    | { tipo: "canal"; canal: IdCanal; chatId: string }
    | { tipo: "subagente"; padre: string }
    | { tipo: "kanban"; tarjetaId: string };
  /** El núcleo se cerró a mitad de un turno de esta sesión: se puede continuar. */
  interrumpida?: boolean;
  objetivo?: ObjetivoSesion;
}

export interface ObjetivoSesion {
  texto: string;
  estado: "activo" | "cumplido" | "agotado";
  intentos: number;
  maxIntentos: number;
  /** Último veredicto del juez. */
  motivo?: string;
}

/** Cambios de una herramienta de escritura en un fichero, como diff por bloques con 3 líneas de contexto. */
export interface Diff {
  ruta: string;
  /** El fichero no existía antes. */
  nuevo: boolean;
  anadidas: number;
  quitadas: number;
  bloques: {
    /** Primera línea del bloque en el fichero antes / después (desde 1). */
    lineaAntes: number;
    lineaDespues: number;
    lineas: { tipo: "+" | "-" | " "; texto: string }[];
  }[];
  /** Se recortó por ser demasiado largo. */
  truncado?: boolean;
}

/** Un adjunto ya guardado por el núcleo (en <perfil>/adjuntos/<sesión>/). */
export interface InfoAdjunto {
  id: string;
  nombre: string;
  tipo: string;
  bytes: number;
  /** imagen = la ven los modelos que aceptan imágenes; documento = PDF u Office, del que se extrae el texto; texto = se lee tal cual. */
  clase: "imagen" | "documento" | "texto" | "otro";
  /** Caracteres de texto extraído que recibe el modelo (documentos y texto). */
  caracteres?: number;
  /** Ruta del fichero guardado. */
  ruta: string;
}

export interface InfoComando {
  /** Sin la barra: «aprender», «objetivo», el nombre de una skill… */
  nombre: string;
  descripcion: string;
  /** Pista de lo que va detrás, si lleva algo («<texto>», «[fuente]»). */
  argumentos?: string;
  origen: "aquiles" | "skill";
}

export type MensajeHistorial =
  | { rol: "usuario"; texto: string; adjuntos?: InfoAdjunto[] }
  | { rol: "asistente"; texto: string; /** Resumen del razonamiento, si el proveedor lo da. */ pensamiento?: string }
  | { rol: "resumen"; texto: string }
  | { rol: "herramienta"; id: string; nombre: string; resumen?: string; resultado: string; error: boolean; diffs?: Diff[] };

export interface Resultados {
  "nucleo.info": { version: string; protocolo: number; proveedor: string; modelo?: string };
  "proveedores.listar": { proveedores: InfoProveedor[] };
  "ajustes.leer": Ajustes;
  "ajustes.guardar": Ajustes;
  "ajustes.clave": { ok: true };
  "sesion.crear": InfoSesion;
  "sesion.listar": { sesiones: InfoSesion[] };
  "sesion.reanudar": InfoSesion & { historial: MensajeHistorial[] };
  "sesion.ajustar": InfoSesion;
  "sesion.renombrar": InfoSesion;
  "sesion.borrar": { borrada: true };
  "prompt.enviar": { aceptado: true };
  "adjuntos.leer": { tipo: string; datos: string };
  "prompt.steer": { encolado: true };
  "prompt.parar": { parado: boolean };
  "memoria.leer": { usuario: BloqueMemoria; agente: BloqueMemoria; proyecto?: BloqueMemoria & { cwd: string }; alma: string };
  "memoria.guardar": BloqueMemoria;
  "memoria.alma": { texto: string };
  "skills.listar": { skills: InfoSkill[] };
  "skills.leer": InfoSkill & { contenido: string; ficheros: string[] };
  "skills.ajustar": InfoSkill;
  "skills.fijar": InfoSkill;
  "skills.archivar": InfoSkill;
  "skills.restaurar": InfoSkill;
  "skills.versiones": { versiones: VersionSkill[] };
  "skills.restaurarVersion": InfoSkill;
  "skills.curar": { cambios: CambioCurador[] };
  "buscar.sesiones": { resultados: ResultadoBusqueda[] };
  /** Rutas relativas a `cwd`, con `/`. */
  "ficheros.buscar": { ficheros: string[] };
  "documentos.leer": { nombre: string; formato: "markdown" | "html"; contenido: string };
  "documentos.exportar": { ruta: string };
  "comandos.listar": { comandos: InfoComando[] };
  /** Ruta en el servidor del núcleo (`/vista/…`); la app le antepone http(s)://host:puerto de su conexión. */
  "artefactos.vista": { ruta: string };
  "artefactos.guardar": { ruta: string };
  "modelos.buscar": { resultados: ResultadoModeloHF[] };
  "modelos.repo": RepoModeloHF;
  "modelos.descargar": { id: string };
  "modelos.cancelar": { cancelada: boolean };
  "modelos.borrar": { borrado: true };
  "modelos.listar": EstadoModelosLocales;
  "modelos.instalarMotor": { ruta: string };
  "aprendizaje.listar": { propuestas: Propuesta[] };
  "aprendizaje.decidir": Propuesta;
  "aprendizaje.revisar": { iniciada: boolean };
  "aprendizaje.historial": { entradas: EntradaAprendizaje[] };
  "cron.listar": { tareas: TareaProgramada[] };
  "cron.crear": TareaProgramada;
  "cron.editar": TareaProgramada;
  "cron.borrar": { borrada: true };
  "cron.ejecutar": { ejecucionId: string };
  "cron.ejecuciones": { ejecuciones: EjecucionCron[] };
  "cron.interpretar": { descripcion: string; proximas: string[]; repite: boolean };
  "canales.listar": { canales: InfoCanal[] };
  "canales.configurar": InfoCanal;
  "canales.emparejar": { codigo: string; caduca: string };
  "canales.desemparejar": InfoCanal;
  "canales.probar": { ok: true };
  "mcp.listar": { servidores: InfoServidorMcp[] };
  "mcp.guardar": InfoServidorMcp;
  "mcp.borrar": { borrado: true };
  "mcp.reconectar": InfoServidorMcp;
  "voz.estado": EstadoVoz;
  "voz.dictar": { texto: string };
  "voz.leer": { ok: true };
  "voz.parar": { ok: true };
  "perfiles.listar": { actual: string; perfiles: InfoPerfil[] };
  "perfiles.crear": InfoPerfil;
  "copias.listar": { copias: InfoCopia[] };
  "copias.crear": InfoCopia;
  "copias.restaurar": { reiniciando: true };
  "sesion.objetivo": InfoSesion;
  "kanban.listar": { tarjetas: TarjetaKanban[] };
  "kanban.crear": TarjetaKanban;
  "kanban.editar": TarjetaKanban;
  "kanban.borrar": { borrada: true };
  "kanban.ejecutar": TarjetaKanban;
  "plugins.listar": { plugins: InfoPlugin[] };
  "plugins.activar": InfoPlugin;
  "estadisticas.leer": Estadisticas;
}

export interface InfoPerfil {
  nombre: string;
  sesiones: number;
  /** Última actividad (ISO). */
  actualizado?: string;
}

export interface InfoCopia {
  nombre: string;
  perfil: string;
  fecha: string;
  bytes: number;
}

export interface TarjetaKanban {
  id: string;
  titulo: string;
  descripcion: string;
  columna: ColumnaKanban;
  /** Posición dentro de la columna (menor = más arriba). */
  orden: number;
  cwd: string;
  /** Sesión del agente que la trabaja (si se encargó). */
  sesionId?: string;
  /** Estado del agente: trabajando, terminó (pasa a revisión) o falló. */
  agente?: "trabajando" | "terminado" | "error";
  error?: string;
  creada: string;
  actualizada: string;
}

export interface InfoPlugin {
  nombre: string;
  descripcion: string;
  ruta: string;
  activo: boolean;
  /** Cargado ahora; si falló, por qué. */
  cargado: boolean;
  error?: string;
  herramientas: string[];
}

export interface Estadisticas {
  dias: number;
  /** Por día (AAAA-MM-DD, del más antiguo al más reciente). */
  porDia: { dia: string; sesiones: number; mensajes: number; herramientas: number; tokensEntrada: number; tokensSalida: number; aprendido: number }[];
  herramientas: { nombre: string; usos: number }[];
  skills: { nombre: string; usos: number }[];
  proveedores: { proveedor: string; sesiones: number }[];
  /** Lo aprendido en el periodo, del más reciente al más antiguo. */
  aprendido: EntradaAprendizaje[];
}

export interface InfoServidorMcp {
  nombre: string;
  /** stdio = un programa local; http = una URL (Streamable HTTP). */
  tipo: "stdio" | "http";
  comando?: string;
  args?: string[];
  /** Nombres de las variables de entorno que se le pasan (los valores no se devuelven). */
  env?: string[];
  url?: string;
  activo: boolean;
  estado: "conectado" | "desconectado" | "error";
  error?: string;
  herramientas: { nombre: string; descripcion: string }[];
}

export interface EstadoVoz {
  /** Hay reconocedor de voz instalado (y su idioma). */
  dictado: boolean;
  idiomaDictado?: string;
  lectura: boolean;
  voces: string[];
  /** Dictando o leyendo ahora. */
  ocupada: boolean;
}

/** Tarea programada: cada ejecución arranca una sesión nueva y entrega el resultado en los canales elegidos. */
export interface TareaProgramada {
  id: string;
  nombre: string;
  prompt: string;
  /** Tal como se escribió: «en 30m», «cada lunes 9:00», «cada 2h», «0 9 * * 1-5»… */
  cuando: string;
  /** Descripción legible de `cuando`. */
  descripcion: string;
  /** Próxima ejecución (ISO); falta si era de una sola vez y ya se ejecutó. */
  proxima?: string;
  activa: boolean;
  cwd: string;
  proveedor?: string;
  modelo?: string;
  /** Sin nadie delante, lo que pida permiso se deniega. */
  modoAprobacion: ModoAprobacion;
  entrega: { canal: IdCanal; destino?: string }[];
  creada: string;
  ultima?: EjecucionCron;
}

export interface EjecucionCron {
  id: string;
  tareaId: string;
  nombre: string;
  inicio: string;
  fin?: string;
  estado: "en-curso" | "ok" | "error";
  sesionId?: string;
  /** Respuesta final del agente (recortada). */
  resumen?: string;
  error?: string;
  entregas: { canal: IdCanal; destino?: string; ok: boolean; intentos: number; error?: string }[];
}

export interface InfoCanal {
  id: IdCanal;
  nombre: string;
  /** Tiene lo necesario (token, servidor…) para funcionar. */
  configurado: boolean;
  /** Puede recibir mensajes (conversar), no solo entregar. */
  conversa: boolean;
  /** Conectado ahora mismo (para los que reciben mensajes). */
  conectado: boolean;
  error?: string;
  /** Opciones no secretas guardadas (servidor, usuario, destinatario…). */
  opciones: Record<string, string>;
  /** Variables secretas que necesita (se guardan con ajustes.clave): nombre → si ya está puesta. */
  secretos: Record<string, boolean>;
  chats: ChatCanal[];
}

export interface ChatCanal {
  id: string;
  nombre: string;
  emparejado: string;
  /** Sesión de Aquiles de este chat. */
  sesionId?: string;
}

export type DestinoMemoria = "usuario" | "agente" | "proyecto";

/** Memoria acotada: entradas cortas con un límite de caracteres por destino. */
export interface BloqueMemoria {
  entradas: string[];
  /** Caracteres usados y límite. */
  usados: number;
  limite: number;
}

export interface InfoSkill {
  nombre: string;
  descripcion: string;
  /** incluida = viene con Aquiles; manual = la puso alguien a mano; aprendida = la creó el agente. */
  origen: "incluida" | "manual" | "aprendida";
  /** Dónde está: carpeta del perfil, del proyecto (`<cwd>/.aquiles/skills`) o las incluidas. */
  ubicacion: "perfil" | "proyecto" | "incluida";
  ruta: string;
  activa: boolean;
  usos: number;
  ultimoUso?: string;
  creada?: string;
  actualizada: string;
  /** Curador: obsoleta = sin usar en 14 días; archivada = sin usar en 30 (se mueve a skills-archivadas/, no se borra). */
  vigencia: "vigente" | "obsoleta" | "archivada";
  /** El curador no la toca. */
  fijada: boolean;
}

/** Copia de una skill del perfil guardada antes de un cambio. */
export interface VersionSkill {
  /** Identificador de la copia (marca de tiempo). */
  id: string;
  fecha: string;
  /** Ficheros guardados, relativos a la skill. */
  ficheros: string[];
  /** Qué la provocó: parchear, escribir, propuesta, restaurar… */
  motivo: string;
}

export interface CambioCurador {
  nombre: string;
  antes: InfoSkill["vigencia"];
  despues: InfoSkill["vigencia"];
}

/** De dónde sale algo aprendido. */
export interface OrigenAprendizaje {
  /** sesion = el agente lo guardó trabajando; revision = la revisión en segundo plano; aprender = /aprender; manual = desde la app. */
  tipo: "sesion" | "revision" | "aprender" | "manual";
  sesionId?: string;
  titulo?: string;
}

/** Cambio que propone la revisión; se aplica al aceptarlo. */
export interface Propuesta {
  id: string;
  fecha: string;
  estado: "pendiente" | "aceptada" | "descartada";
  origen: OrigenAprendizaje;
  tipo: "memoria" | "skill";
  /** Una línea: qué cambia. */
  resumen: string;
  /** memoria: destino y entradas que entran o salen. */
  destino?: DestinoMemoria;
  cwd?: string;
  anadidas?: string[];
  quitadas?: string[];
  /** skill: nombre y ficheros con su contenido antes (si existía) y después. */
  nombre?: string;
  nueva?: boolean;
  ficheros?: { ruta: string; antes?: string; despues: string }[];
  /** Por qué falló al aceptarla (sigue pendiente). */
  error?: string;
}

/** Algo que Aquiles aprendió, ya aplicado. */
export interface EntradaAprendizaje {
  id: string;
  fecha: string;
  origen: OrigenAprendizaje;
  tipo: "memoria" | "skill";
  resumen: string;
  propuestaId?: string;
}

export interface ResultadoBusqueda {
  sesionId: string;
  titulo?: string;
  cwd: string;
  /** Fecha del mensaje encontrado (ISO). */
  fecha: string;
  rol: "usuario" | "asistente" | "herramienta" | "resumen";
  /** Trozo del mensaje con la coincidencia marcada con «» */
  fragmento: string;
}

/** Peticiones del núcleo al cliente. */
export interface PeticionesCliente {
  "aprobacion.pedir": {
    params: { sesionId: string; id: string; herramienta: string; nivel: string; resumen: string; argumentos: unknown; motivo: string };
    resultado: { decision: "permitir" | "siempre" | "denegar" };
  };
  "pregunta.hacer": {
    params: { sesionId: string; texto: string; opciones?: string[]; multiple?: boolean };
    resultado: { respuesta: string };
  };
}
export type NombrePeticionCliente = keyof PeticionesCliente;

export interface Uso {
  entrada: number;
  salida: number;
  razonamiento?: number;
}

export type MotivoFin = "fin" | "parado" | "limite" | "error";

export interface ResultadoModeloHF {
  repo: string;
  descargas: number;
  likes: number;
  /** Hay que aceptar sus condiciones en huggingface.co y poner una clave de Hugging Face (Ajustes → Modelos → Claves de API). */
  protegido: boolean;
  /** Hugging Face lo declara de imagen y texto (ve imágenes si se descarga su proyector). */
  imagenes?: boolean;
  actualizado?: string;
}

export interface FicheroModeloHF {
  /** Ruta de la primera parte en el repositorio. */
  nombre: string;
  partes: string[];
  bytes: number;
  /** Del nombre del fichero (Q4_K_M, IQ3_XXS, BF16…). */
  cuantizacion?: string;
}

export interface RepoModeloHF {
  repo: string;
  protegido: boolean;
  /** Contexto de entrenamiento según los metadatos GGUF de Hugging Face. */
  ventana?: number;
  arquitectura?: string;
  ficheros: FicheroModeloHF[];
  /** Proyectores de visión (mmproj). */
  proyectores: FicheroModeloHF[];
}

export interface ModeloLocalInfo {
  /** `dueño/repo/ruta.gguf`: el `modelo` del proveedor `llamacpp`. */
  id: string;
  repo: string;
  nombre: string;
  bytes: number;
  /** Tiene proyector de visión descargado: acepta imágenes. */
  imagenes: boolean;
}

export interface ProgresoDescargaModelo {
  id: string;
  repo: string;
  nombre: string;
  bytes: number;
  total: number;
  estado: "descargando" | "terminada" | "error" | "cancelada";
  error?: string;
}

export interface EstadoModelosLocales {
  /** Carpeta donde se guardan (fuera del perfil, para que no entren en las copias). */
  carpeta: string;
  locales: ModeloLocalInfo[];
  descargas: ProgresoDescargaModelo[];
  /** llama.cpp instalado (ruta de llama-server) y modelo que tiene cargado ahora, si hay. */
  motor: { ruta?: string; cargado?: string };
}

export interface TareaVisible {
  texto: string;
  estado: "pendiente" | "en-curso" | "hecha";
}

export type Evento =
  | { tipo: "mensaje.delta"; sesionId: string; texto: string }
  /** Razonamiento del modelo mientras piensa (resumen; claude, codex y las API que lo dan). */
  | { tipo: "pensamiento.delta"; sesionId: string; texto: string }
  | { tipo: "herramienta.inicio"; sesionId: string; id: string; nombre: string; argumentos: unknown; resumen?: string }
  | { tipo: "herramienta.progreso"; sesionId: string; id: string; texto: string }
  | { tipo: "herramienta.fin"; sesionId: string; id: string; nombre: string; resultado: string; error: boolean; diffs?: Diff[] }
  | { tipo: "sesion.actualizada"; sesion: InfoSesion }
  | { tipo: "memoria.actualizada"; destino: DestinoMemoria | "alma"; cwd?: string }
  | { tipo: "skills.actualizadas" }
  | { tipo: "aprendizaje.revision"; sesionId: string; estado: "inicio" | "fin" | "error"; propuestas?: number; aplicadas?: number; error?: string }
  | { tipo: "aprendizaje.actualizado" }
  | { tipo: "cron.ejecucion"; ejecucion: EjecucionCron }
  | { tipo: "cron.actualizado" }
  | { tipo: "canales.actualizados" }
  /** Un subagente (sesión hija) empieza o termina. Sus eventos llegan con su propio sesionId (`subId`). */
  | { tipo: "subagente.inicio"; sesionId: string; subId: string; tarea: string }
  | { tipo: "subagente.fin"; sesionId: string; subId: string; motivo: MotivoFin; texto: string; error?: string }
  | { tipo: "mcp.actualizado" }
  | { tipo: "kanban.actualizado" }
  | { tipo: "plugins.actualizados" }
  /** Progreso de una descarga de modelo (cada ~0,5 s y al acabar). */
  | { tipo: "modelos.progreso"; descarga: ProgresoDescargaModelo }
  /** Cambió la lista de modelos locales o el estado de llama.cpp. */
  | { tipo: "modelos.actualizados" }
  | { tipo: "objetivo.evaluado"; sesionId: string; objetivo: ObjetivoSesion }
  /** El núcleo va a reiniciarse (cambio de perfil, restaurar copia): la interfaz debe reconectar. */
  | { tipo: "nucleo.reinicio"; motivo: string }
  /** Aviso para el escritorio (canal «escritorio»): la app lo muestra como notificación del sistema. */
  | { tipo: "notificacion"; titulo: string; texto: string; sesionId?: string }
  | { tipo: "tareas"; sesionId: string; tareas: TareaVisible[] }
  | { tipo: "contexto.uso"; sesionId: string; tokens: number; ventana?: number }
  | { tipo: "contexto.compactado"; sesionId: string; metodo: "poda" | "resumen"; antes: number; despues: number }
  | { tipo: "turno.reintento"; sesionId: string; intento: number; esperaMs: number; motivo: string }
  | { tipo: "turno.fin"; sesionId: string; motivo: MotivoFin; texto: string; uso?: Uso; error?: string };

export interface PeticionRpc {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface ErrorRpc {
  code: number;
  message: string;
  data?: unknown;
}

export interface RespuestaRpc {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: ErrorRpc;
}

/** Los eventos del núcleo viajan como notificación JSON-RPC con método `evento`. */
export interface NotificacionEvento {
  jsonrpc: "2.0";
  method: "evento";
  params: Evento;
}

export const codigosError = {
  parse: -32700,
  peticionInvalida: -32600,
  metodoNoExiste: -32601,
  paramsInvalidos: -32602,
  interno: -32603,
  sesionNoExiste: 1001,
  sesionOcupada: 1002,
  sinTurno: 1003,
  /** El fichero ya existe (artefactos.guardar sin `sobrescribir`). */
  yaExiste: 1004,
} as const;
