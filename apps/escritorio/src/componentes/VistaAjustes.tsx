import { PASOS_POR_TURNO, type Ajustes, type AjustesVoz, type AvisoAlAcabar, type EntornoTerminal, type Params } from "@aquiles/protocolo";
import { Boton, Campo, Chip, Desplegable, Interruptor, Opcion, Pestanas, Titular, idPestana, t, type Pestana } from "@aquiles/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { esfuerzoTrasCambio } from "../estado/esfuerzo";
import type { PestanaAjustes } from "../estado/tipos";
import { hayClaveLlavero } from "../plataforma/claves";
import { enTauri } from "../plataforma/tauri";
import { esLinux, esMac } from "../plataforma/ventana";
import { Actualizaciones, Arranque, Atajo, Copias, Perfiles, Remoto, SeccionPlugins } from "./Aplicacion";
import { CampoCarpeta, OpcionesChip, OpcionesPermisos, ProveedorModelo } from "./Campos";
import { SeccionMcp } from "./Mcp";
import { SeccionModelos } from "./ModelosLocales";

type Cambios = Params<"ajustes.guardar">;

/** Clave de Hugging Face: no es un proveedor, pero se guarda y se pasa al núcleo igual que las suyas. */
const HF = { id: "huggingface", nombre: "Hugging Face" };
/** Clave de Google AI Studio: solo para generar imágenes con Gemini (generar_imagen). El nombre se pinta con t(). */
const GEMINI = "gemini";
const PANEL = "ajustes-panel";

// Las listas con textos son funciones: se llaman al pintar, para que salgan en el idioma de la interfaz.
const pestanas = (): Pestana<PestanaAjustes>[] => [
  { id: "general", texto: t("General") },
  { id: "modelos", texto: t("Modelos") },
  { id: "herramientas", texto: t("Herramientas") },
  { id: "aprendizaje", texto: t("Aprendizaje") },
  { id: "aplicacion", texto: t("Aplicación") },
];

const entornos = (): { valor: EntornoTerminal; texto: string }[] => [
  { valor: "local", texto: t("Este equipo") },
  { valor: "docker", texto: "Docker" },
  { valor: "ssh", texto: "SSH" },
];

/** Bloque de ajustes relacionados, con su título y, si hace falta, una línea que explica para qué sirve. */
function Grupo({ titulo, descripcion, children }: { titulo?: string; descripcion?: string; children: ReactNode }) {
  return (
    <section className="ajuste-grupo">
      {titulo && (
        <header className="ajuste-grupo__cabecera">
          <h2 className="ajuste-grupo__titulo">{titulo}</h2>
          {descripcion && <p className="ajuste-grupo__descripcion">{descripcion}</p>}
        </header>
      )}
      <div className="ajuste-grupo__cuerpo">{children}</div>
    </section>
  );
}

/** Un ajuste: a la izquierda qué es; a la derecha, el control. */
function Ajuste({ titulo, descripcion, children }: { titulo: string; descripcion?: string; children: ReactNode }) {
  return (
    <div className="ajuste">
      <div className="ajuste__texto">
        <span className="ajuste__titulo">{titulo}</span>
        {descripcion && <span className="ajuste__descripcion">{descripcion}</span>}
      </div>
      <div className="ajuste__control">{children}</div>
    </div>
  );
}

/** Une cambios pendientes: los objetos (aprendizaje, herramientas…) se mezclan; lo demás, el último gana. */
function fusionar<T extends Record<string, unknown>>(a: T, b: T): T {
  const r: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const previo = r[k];
    r[k] =
      v && typeof v === "object" && !Array.isArray(v) && previo && typeof previo === "object"
        ? fusionar(previo as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return r as T;
}

/**
 * Cada cambio se guarda solo, sin botón: los interruptores y listas al momento; lo que se escribe, al parar de escribir.
 * Los cambios que llegan seguidos se juntan en un solo `ajustes.guardar`.
 */
function useAutoguardado() {
  const { guardarAjustes } = useAcciones();
  const pendiente = useRef<Cambios>({});
  const temporizador = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [estado, setEstado] = useState<{ tipo: "guardando" } | { tipo: "ok" } | { tipo: "error"; texto: string }>();

  const enviar = useCallback(async () => {
    const cambios = pendiente.current;
    pendiente.current = {};
    if (!Object.keys(cambios).length) return;
    setEstado({ tipo: "guardando" });
    try {
      await guardarAjustes(cambios);
      setEstado({ tipo: "ok" });
    } catch (e) {
      setEstado({ tipo: "error", texto: e instanceof Error ? e.message : String(e) });
    }
  }, [guardarAjustes]);

  const guardar = useCallback(
    (cambios: Cambios, esperaMs = 0) => {
      pendiente.current = fusionar(pendiente.current, cambios);
      clearTimeout(temporizador.current);
      temporizador.current = setTimeout(() => void enviar(), esperaMs);
    },
    [enviar],
  );

  // Lo que quede pendiente al salir de Ajustes también se guarda.
  useEffect(
    () => () => {
      clearTimeout(temporizador.current);
      void enviar();
    },
    [enviar],
  );

  return { guardar, estado };
}

/** Umbral de la revisión: entero de 1 a 500 (lo que acepta el núcleo). */
function umbral(texto: string): number | undefined {
  const n = Number(texto);
  return texto.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 500 ? n : undefined;
}

const ESCRIBIENDO_MS = 700;

export function VistaAjustes() {
  const estado = useEstado();
  const { ajustes, conexion } = estado;
  const { refrescarProveedores } = useAcciones();
  const [pestana, setPestana] = useState<PestanaAjustes>(estado.pestanaAjustes ?? "general");
  // «Ver en Ajustes» desde otro sitio (el aviso de actualización…) abre su pestaña.
  useEffect(() => {
    if (estado.pestanaAjustes) setPestana(estado.pestanaAjustes);
  }, [estado.pestanaAjustes]);
  const { guardar, estado: guardado } = useAutoguardado();
  // Copia local para que lo que se escribe se vea al momento; se rehace desde el núcleo tras cada guardado.
  const [form, setForm] = useState<Ajustes | undefined>(ajustes);
  useEffect(() => {
    if (ajustes) setForm(ajustes);
  }, [ajustes]);
  const conectada = conexion === "conectada";

  useEffect(() => {
    if (conectada) void refrescarProveedores().catch(() => {});
  }, [conectada, refrescarProveedores]);

  if (!form) return <div className="ajustes" />;

  /** Cambia el formulario y lo guarda (al momento, o al parar de escribir). */
  const cambiar = (local: Partial<Ajustes>, cambios: Cambios, esperaMs = 0) => {
    setForm((f) => (f ? { ...f, ...local } : f));
    guardar(cambios, esperaMs);
  };

  return (
    <div className="ajustes">
      <div className="ajustes__pagina">
        <div className="ajustes__cabecera">
          <Titular texto={t("Ajustes")} tamano="l" />
          <span className={guardado?.tipo === "error" ? "ajustes__estado ajustes__estado--error" : "ajustes__estado"} role={guardado?.tipo === "error" ? "alert" : "status"}>
            {guardado?.tipo === "guardando" ? t("Guardando…") : guardado?.tipo === "ok" ? t("Guardado") : guardado?.tipo === "error" ? guardado.texto : ""}
          </span>
        </div>
        <Pestanas etiqueta={t("Ajustes")} pestanas={pestanas()} activa={pestana} alElegir={setPestana} idPanel={PANEL} />
        <div role="tabpanel" id={PANEL} aria-labelledby={idPestana(PANEL, pestana)} className="ajustes__panel">
          {pestana === "general" && <General form={form} cambiar={cambiar} />}
          {pestana === "modelos" && <Modelos form={form} cambiar={cambiar} />}
          {pestana === "herramientas" && <Herramientas form={form} cambiar={cambiar} />}
          {pestana === "aprendizaje" && <Aprendizaje form={form} cambiar={cambiar} />}
          {pestana === "aplicacion" && <AplicacionAjustes />}
        </div>
      </div>
    </div>
  );
}

interface PropsPestana {
  form: Ajustes;
  cambiar: (local: Partial<Ajustes>, cambios: Cambios, esperaMs?: number) => void;
}

function General({ form, cambiar }: PropsPestana) {
  const tauri = enTauri();
  return (
    <>
      <Grupo titulo={t("Idioma")} descripcion={t("El de la interfaz. Las respuestas del modelo siguen el idioma en que le escribas.")}>
        <OpcionesChip
          leyenda={t("Idioma")}
          opciones={[
            { valor: "es", texto: "Español" },
            { valor: "en", texto: "English" },
          ]}
          valor={form.idioma ?? "es"}
          alCambiar={(idioma) => cambiar({ idioma }, { idioma })}
        />
      </Grupo>
      <Grupo titulo={t("Sesiones nuevas")}>
        <Ajuste titulo={t("Carpeta de trabajo")} descripcion={t("Donde empiezan las sesiones nuevas.")}>
          <CampoCarpeta etiqueta={t("Carpeta")} carpeta={form.carpeta} alCambiar={(carpeta) => cambiar({ carpeta }, { carpeta }, tauri ? 0 : ESCRIBIENDO_MS)} />
        </Ajuste>
        <Ajuste titulo={t("Permisos")} descripcion={t("Qué puede hacer sin preguntarte. Cada sesión puede cambiarlo.")}>
          <OpcionesPermisos valor={form.modoAprobacion} alCambiar={(modoAprobacion) => cambiar({ modoAprobacion }, { modoAprobacion })} />
        </Ajuste>
      </Grupo>
      <Grupo titulo={t("Turnos")}>
        <Ajuste
          titulo={t("Pasos máximos por turno")}
          descripcion={t("Cuántas veces puede responder el modelo (y usar herramientas) en un turno antes de parar. Vale para todas las sesiones desde el turno siguiente.")}
        >
          <CampoPasos valor={form.maxPasos ?? PASOS_POR_TURNO.porDefecto} alCambiar={(maxPasos) => cambiar({ maxPasos }, { maxPasos }, ESCRIBIENDO_MS)} />
        </Ajuste>
      </Grupo>
      {form.voz && (
        <AjustesDeVoz
          voz={form.voz}
          alCambiar={(c) => cambiar({ voz: { ...form.voz, ...c, ...(c.voz === "" ? { voz: undefined } : {}) } }, { voz: c })}
        />
      )}
      {tauri && (
        <Grupo titulo={esMac ? "Mac" : esLinux ? "Linux" : "Windows"}>
          <Ajuste
            titulo={esMac || esLinux ? t("Abrir al iniciar sesión") : t("Arrancar con Windows")}
            descripcion={
              esMac
                ? t("Se queda en la barra de menús al iniciar sesión, para que las tareas programadas y los canales sigan.")
                : t("Se queda en la bandeja al iniciar sesión, para que las tareas programadas y los canales sigan.")
            }
          >
            <Arranque />
          </Ajuste>
          <Ajuste titulo={t("Entrada rápida")} descripcion={t("Un atajo de teclado que abre una caja para dar una tarea desde cualquier sitio.")}>
            <Atajo />
          </Ajuste>
        </Grupo>
      )}
    </>
  );
}

const velocidades = (): { valor: string; texto: string }[] => [
  { valor: "-25", texto: t("Lenta") },
  { valor: "0", texto: t("Normal") },
  { valor: "25", texto: t("Rápida") },
  { valor: "50", texto: t("Muy rápida") },
];

/** Lectura en voz alta con las voces del sistema (Windows: System.Speech; Mac: say; Linux: espeak-ng): cuál, a qué velocidad y una prueba. */
function AjustesDeVoz({ voz, alCambiar }: { voz: AjustesVoz; alCambiar: (c: Partial<AjustesVoz>) => void }) {
  const { voz: estado } = useEstado();
  const { llamar } = useAcciones();
  const [probando, setProbando] = useState(false);
  const [error, setError] = useState<string>();
  const voces = estado?.voces ?? [];
  const AUTOMATICA = t("Automática (la de español)");
  const elegida = voz.voz && voces.some((v) => v.nombre === voz.voz) ? voz.voz : AUTOMATICA;
  const probar = async () => {
    setProbando(true);
    setError(undefined);
    try {
      await llamar("voz.leer", { texto: "Hola, soy Aquiles. Así sueno con esta voz." });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbando(false);
    }
  };
  const avisos: { valor: AvisoAlAcabar; texto: string }[] = [
    { valor: "nada", texto: t("Nada") },
    { valor: "notificacion", texto: t("Notificación") },
    ...(estado?.lectura ? [{ valor: "voz" as const, texto: t("Notificación y voz") }] : []),
  ];
  const alAcabar = (
    <Ajuste titulo={t("Al acabar una tarea")} descripcion={t("Si tarda medio minuto o más, avisa con una frase del modelo: «He acabado de…».")}>
      <OpcionesChip
        leyenda={t("Al acabar una tarea")}
        opciones={avisos}
        valor={voz.alAcabar === "voz" && !estado?.lectura ? "notificacion" : (voz.alAcabar ?? "voz")}
        alCambiar={(v) => alCambiar({ alAcabar: v })}
      />
    </Ajuste>
  );
  if (!estado?.lectura) {
    return (
      <Grupo titulo={t("Voz")} descripcion={t("Para leer las respuestas en voz alta.")}>
        <p className="ajustes__nota">
          {esLinux
            ? t("No se encontró ninguna voz del sistema: instala espeak-ng (o speech-dispatcher) con el gestor de paquetes.")
            : esMac || enTauri()
              ? t("No se encontró ninguna voz del sistema.")
              : t("La voz es de la app de escritorio (Windows, Mac o Linux).")}
        </p>
        {alAcabar}
      </Grupo>
    );
  }
  return (
    <Grupo
      titulo={t("Voz")}
      descripcion={
        esMac
          ? t("Para leer las respuestas en voz alta. Hay voces más naturales para descargar en Ajustes del Sistema › Accesibilidad › Contenido leído.")
          : esLinux
            ? t("Para leer las respuestas en voz alta, con las voces de espeak-ng o de Speech Dispatcher.")
            : t("Para leer las respuestas en voz alta, con las voces de Windows (se añaden en Configuración › Hora e idioma › Voz).")
      }
    >
      <Ajuste titulo={t("Voz")}>
        <Desplegable
          etiqueta={t("Voz")}
          lado="abajo"
          disparador={({ alternar, abierto: _a, ...aria }) => (
            <Boton variante="chip" iconoFinal="chevron-abajo" onClick={alternar} {...aria}>
              {elegida}
            </Boton>
          )}
        >
          {(cerrar) => [
            <Opcion
              key=""
              texto={AUTOMATICA}
              marcada={elegida === AUTOMATICA}
              alElegir={() => {
                alCambiar({ voz: "" });
                cerrar();
              }}
            />,
            ...voces.map((v) => (
              <Opcion
                key={v.nombre}
                texto={`${v.nombre} · ${v.idioma}`}
                marcada={v.nombre === elegida}
                alElegir={() => {
                  alCambiar({ voz: v.nombre });
                  cerrar();
                }}
              />
            )),
          ]}
        </Desplegable>
      </Ajuste>
      <Ajuste titulo={t("Velocidad")}>
        <OpcionesChip leyenda={t("Velocidad")} opciones={velocidades()} valor={String(voz.velocidad)} alCambiar={(v) => alCambiar({ velocidad: Number(v) })} />
      </Ajuste>
      <Ajuste titulo={t("Probar")} descripcion={error}>
        <Boton variante="chip" icono={probando ? "detener" : "altavoz"} onClick={() => (probando ? void llamar("voz.parar", {}).catch(() => {}) : void probar())}>
          {probando ? t("Parar") : t("Escuchar")}
        </Boton>
      </Ajuste>
      {alAcabar}
    </Grupo>
  );
}

/** Pasos por turno: se edita como texto para poder vaciar el campo mientras se escribe; solo se guarda un entero válido. */
function CampoPasos({ valor, alCambiar }: { valor: number; alCambiar: (n: number) => void }) {
  const { min, max } = PASOS_POR_TURNO;
  const [texto, setTexto] = useState(String(valor));
  const n = Number(texto);
  const valido = texto.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
  return (
    <Campo
      etiqueta={t("Pasos")}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={texto}
      error={valido ? undefined : t("De {min} a {max}", { min, max })}
      onChange={(e) => {
        setTexto(e.target.value);
        const m = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isInteger(m) && m >= min && m <= max) alCambiar(m);
      }}
    />
  );
}

function Modelos({ form, cambiar }: PropsPestana) {
  const { proveedores, ajustes } = useEstado();
  const { guardarAjustes } = useAcciones();
  const conClave = [
    ...proveedores.filter((p) => p.necesitaClave),
    { id: HF.id, nombre: HF.nombre, disponible: false },
    { id: GEMINI, nombre: t("Gemini (imágenes)"), disponible: false },
  ];

  /** «Usar por defecto» de un modelo descargado: se guarda ya. */
  const usarModeloLocal = async (id: string) => {
    const esfuerzo = esfuerzoTrasCambio(proveedores, "llamacpp", id, ajustes?.esfuerzo);
    await guardarAjustes({ proveedor: "llamacpp", modelo: id, ...(esfuerzo !== undefined ? { esfuerzo } : {}) });
  };

  return (
    <>
      <Grupo titulo={t("Modelo por defecto")} descripcion={t("El de las sesiones nuevas. Cada sesión puede usar otro.")}>
        <ProveedorModelo
          proveedores={proveedores}
          proveedor={form.proveedor}
          modelo={form.modelo}
          alCambiar={(proveedor, modelo) => {
            const esfuerzo = esfuerzoTrasCambio(proveedores, proveedor, modelo, form.esfuerzo);
            const cambios = { proveedor, modelo: modelo ?? "", ...(esfuerzo !== undefined ? { esfuerzo } : {}) };
            // Un id de modelo escrito a mano se guarda al parar de escribir.
            const escrito = !proveedores.find((p) => p.id === proveedor)?.modelos.length && proveedor === form.proveedor;
            cambiar({ proveedor, modelo, ...(esfuerzo !== undefined ? { esfuerzo } : {}) }, cambios, escrito ? ESCRIBIENDO_MS : 0);
          }}
          esfuerzo={form.esfuerzo}
          alEsfuerzo={(esfuerzo) => cambiar({ esfuerzo }, { esfuerzo })}
        />
      </Grupo>
      <Grupo
        titulo={t("Claves de API")}
        descripcion={
          esMac
            ? t("Se guardan en el llavero de macOS, no en ficheros.")
            : esLinux
              ? t("Se guardan en el llavero del sistema (GNOME Keyring o KWallet), no en ficheros.")
              : t("Se guardan en el almacén de credenciales de Windows, no en ficheros.")
        }
      >
        <div className="ajustes__claves">
          {conClave.map((p) => (
            <CampoClave key={p.id} id={p.id} nombre={p.nombre} disponible={p.disponible} />
          ))}
        </div>
      </Grupo>
      <Grupo titulo={t("Modelos de Hugging Face")} descripcion={t("Descárgalos y úsalos en este equipo, sin conexión, con llama.cpp.")}>
        <SeccionModelos porDefecto={form.proveedor === "llamacpp" ? form.modelo : undefined} alUsar={usarModeloLocal} />
      </Grupo>
    </>
  );
}

/** Una clave de API: se escribe y se guarda con su botón (en el llavero); si ya hay una, se puede borrar. */
function CampoClave({ id, nombre, disponible }: { id: string; nombre: string; disponible: boolean }) {
  const { guardarClave, borrarClave, refrescarProveedores } = useAcciones();
  const [texto, setTexto] = useState("");
  const [guardada, setGuardada] = useState<boolean>();
  const [error, setError] = useState<string>();
  const [ocupado, setOcupado] = useState(false);

  const leer = useCallback(() => hayClaveLlavero(id).then((h) => setGuardada(h ?? disponible), () => setGuardada(disponible)), [id, disponible]);
  useEffect(() => {
    void leer();
  }, [leer]);

  const actuar = async (f: () => Promise<void>) => {
    setOcupado(true);
    try {
      await f();
      setTexto("");
      setError(undefined);
      await Promise.all([refrescarProveedores(), leer()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <form
      className="ajustes__clave"
      onSubmit={(e) => {
        e.preventDefault();
        if (texto.trim()) void actuar(() => guardarClave(id, texto.trim()));
      }}
    >
      <Campo
        etiqueta={nombre}
        type="password"
        mono
        autoComplete="off"
        spellCheck={false}
        placeholder={guardada ? "••••••••••••" : undefined}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        error={error}
        sufijo={guardada ? <Chip destacado>{t("Guardada")}</Chip> : undefined}
      />
      {texto.trim() ? (
        <Boton type="submit" variante="secundario" tamano="pequeno" disabled={ocupado}>
          {t("Guardar")}
        </Boton>
      ) : (
        guardada && (
          <Boton variante="fantasma" tamano="pequeno" icono="papelera" disabled={ocupado} onClick={() => void actuar(() => borrarClave(id))}>
            {t("Borrar")}
          </Boton>
        )
      )}
    </form>
  );
}

function Herramientas({ form, cambiar }: PropsPestana) {
  const { proveedores } = useEstado();
  const h = form.herramientas;
  const terminal = (c: Partial<typeof h.terminal>, esperaMs = 0) =>
    cambiar({ herramientas: { ...h, terminal: { ...h.terminal, ...c } } }, { herramientas: { terminal: c } }, esperaMs);
  const guardian = (g: Partial<typeof h.guardian>) =>
    cambiar(
      { herramientas: { ...h, guardian: { ...h.guardian, ...g } } },
      { herramientas: { guardian: { ...g, ...("proveedor" in g ? { proveedor: g.proveedor ?? "", modelo: g.modelo ?? "" } : {}) } } },
    );
  return (
    <>
      <Grupo titulo={t("Terminal")}>
        <Ajuste titulo={t("Dónde se ejecutan los comandos")} descripcion={t("En este equipo, en un contenedor Docker o en otra máquina por SSH.")}>
          <OpcionesChip leyenda={t("Terminal")} opciones={entornos()} valor={h.terminal.entorno} alCambiar={(entorno) => terminal({ entorno })} />
          {h.terminal.entorno === "docker" && (
            <Campo etiqueta={t("Imagen")} mono spellCheck={false} value={h.terminal.imagen} onChange={(e) => terminal({ imagen: e.target.value }, ESCRIBIENDO_MS)} />
          )}
          {h.terminal.entorno === "ssh" && (
            <Campo
              etiqueta={t("Destino")}
              mono
              spellCheck={false}
              placeholder={t("usuario@host")}
              value={h.terminal.ssh ?? ""}
              onChange={(e) => terminal({ ssh: e.target.value }, ESCRIBIENDO_MS)}
            />
          )}
        </Ajuste>
      </Grupo>
      <Grupo titulo={t("Navegador y permisos")}>
        <Ajuste titulo={t("Navegador")} descripcion={t("Le deja abrir y manejar una ventana de Edge.")}>
          <Interruptor aria-label={t("Navegador")} activo={h.navegador} alCambiar={(navegador) => cambiar({ herramientas: { ...h, navegador } }, { herramientas: { navegador } })} />
        </Ajuste>
        <Ajuste titulo={t("Guardián")} descripcion={t("Un modelo aprueba lo que es claramente seguro y te pregunta el resto.")}>
          <Interruptor aria-label={t("Guardián")} activo={h.guardian.activo} alCambiar={(activo) => guardian({ activo })} />
          {h.guardian.activo && (
            <ProveedorModelo
              proveedores={proveedores}
              proveedor={h.guardian.proveedor ?? ""}
              modelo={h.guardian.modelo}
              vacio={t("Igual que la sesión")}
              alCambiar={(proveedor, modelo) => guardian({ proveedor: proveedor || undefined, modelo })}
            />
          )}
        </Ajuste>
      </Grupo>
      <Grupo titulo={t("Servidores MCP")} descripcion={t("Herramientas de otros programas que Aquiles puede usar.")}>
        <SeccionMcp />
      </Grupo>
      <Grupo titulo={t("Plugins")}>
        <SeccionPlugins />
      </Grupo>
    </>
  );
}

function Aprendizaje({ form, cambiar }: PropsPestana) {
  const { proveedores } = useEstado();
  const a = form.aprendizaje;
  // Los umbrales se editan como texto para poder vaciar el campo mientras se escribe.
  const [umbrales, setUmbrales] = useState({ herramientas: String(a.cadaHerramientas), mensajes: String(a.cadaMensajes) });
  const aprender = (c: Partial<typeof a>, cambios: Cambios["aprendizaje"], esperaMs = 0) =>
    cambiar({ aprendizaje: { ...a, ...c } }, { aprendizaje: cambios }, esperaMs);
  const campoUmbral = (clave: "herramientas" | "mensajes", etiqueta: string) => (
    <Campo
      etiqueta={etiqueta}
      type="number"
      inputMode="numeric"
      min={1}
      max={500}
      value={umbrales[clave]}
      error={umbral(umbrales[clave]) === undefined ? t("De {min} a {max}", { min: 1, max: 500 }) : undefined}
      onChange={(e) => {
        setUmbrales({ ...umbrales, [clave]: e.target.value });
        const n = umbral(e.target.value);
        if (n === undefined) return;
        if (clave === "herramientas") aprender({ cadaHerramientas: n }, { cadaHerramientas: n }, ESCRIBIENDO_MS);
        else aprender({ cadaMensajes: n }, { cadaMensajes: n }, ESCRIBIENDO_MS);
      }}
    />
  );
  return (
    <Grupo titulo={t("Revisión de lo aprendido")}>
      <Ajuste titulo={t("Revisar las conversaciones")} descripcion={t("De vez en cuando revisa la conversación y propone qué recordar (memoria y habilidades).")}>
        <Interruptor aria-label={t("Revisar las conversaciones")} activo={a.activo} alCambiar={(activo) => aprender({ activo }, { activo })} />
      </Ajuste>
      {a.activo && (
        <>
          <Ajuste titulo={t("Aplicar sin preguntar")} descripcion={t("Guarda lo aprendido directamente, sin pasar por Memoria → Propuestas.")}>
            <Interruptor aria-label={t("Aplicar sin preguntar")}
              activo={a.aplicarSinPreguntar}
              alCambiar={(aplicarSinPreguntar) => aprender({ aplicarSinPreguntar }, { aplicarSinPreguntar })}
            />
          </Ajuste>
          <Ajuste titulo={t("Cada cuánto")} descripcion={t("Revisa al llegar a cualquiera de los dos.")}>
            <div className="ajustes__rejilla">
              {campoUmbral("herramientas", t("Herramientas usadas"))}
              {campoUmbral("mensajes", t("Mensajes"))}
            </div>
          </Ajuste>
          <Ajuste titulo={t("Modelo de la revisión")}>
            <ProveedorModelo
              proveedores={proveedores}
              proveedor={a.proveedor ?? ""}
              modelo={a.modelo}
              vacio={t("Igual que la sesión")}
              alCambiar={(proveedor, modelo) => aprender({ proveedor: proveedor || undefined, modelo }, { proveedor, modelo: modelo ?? "" })}
            />
          </Ajuste>
        </>
      )}
    </Grupo>
  );
}

function AplicacionAjustes() {
  const tauri = enTauri();
  return (
    <>
      {tauri && (
        <Grupo titulo={t("Actualizaciones")} descripcion={t("Aquiles se compila desde la rama main de GitHub.")}>
          <Actualizaciones />
        </Grupo>
      )}
      <Grupo titulo={t("Perfiles")} descripcion={t("Cada perfil tiene sus propias sesiones, memoria, habilidades y ajustes.")}>
        <Perfiles />
      </Grupo>
      <Grupo titulo={t("Copias de seguridad")} descripcion={t("Copias del perfil actual, para restaurarlo si algo sale mal.")}>
        <Copias />
      </Grupo>
      {tauri && (
        <Grupo titulo={t("Núcleo remoto")} descripcion={t("Conecta la app a un núcleo de Aquiles que corre en otra máquina.")}>
          <Remoto />
        </Grupo>
      )}
    </>
  );
}
