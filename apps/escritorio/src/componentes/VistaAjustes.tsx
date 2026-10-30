import type { Ajustes, EntornoTerminal, Params } from "@aquiles/protocolo";
import { Boton, Campo, Chip, Interruptor, Pestanas, Titular, idPestana, type Pestana } from "@aquiles/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { esfuerzoTrasCambio } from "../estado/esfuerzo";
import type { PestanaAjustes } from "../estado/tipos";
import { hayClaveLlavero } from "../plataforma/claves";
import { enTauri } from "../plataforma/tauri";
import { Actualizaciones, Arranque, Atajo, Copias, Perfiles, Remoto, SeccionPlugins } from "./Aplicacion";
import { CampoCarpeta, OpcionesChip, OpcionesPermisos, ProveedorModelo } from "./Campos";
import { SeccionMcp } from "./Mcp";
import { SeccionModelos } from "./ModelosLocales";

type Cambios = Params<"ajustes.guardar">;

/** Clave de Hugging Face: no es un proveedor, pero se guarda y se pasa al núcleo igual que las suyas. */
const HF = { id: "huggingface", nombre: "Hugging Face" };
const PANEL = "ajustes-panel";

const PESTANAS: Pestana<PestanaAjustes>[] = [
  { id: "general", texto: "General" },
  { id: "modelos", texto: "Modelos" },
  { id: "herramientas", texto: "Herramientas" },
  { id: "aprendizaje", texto: "Aprendizaje" },
  { id: "aplicacion", texto: "Aplicación" },
];

const ENTORNOS: { valor: EntornoTerminal; texto: string }[] = [
  { valor: "local", texto: "Este equipo" },
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
          <Titular texto="Ajustes" tamano="l" />
          <span className={guardado?.tipo === "error" ? "ajustes__estado ajustes__estado--error" : "ajustes__estado"} role={guardado?.tipo === "error" ? "alert" : "status"}>
            {guardado?.tipo === "guardando" ? "Guardando…" : guardado?.tipo === "ok" ? "Guardado" : guardado?.tipo === "error" ? guardado.texto : ""}
          </span>
        </div>
        <Pestanas etiqueta="Ajustes" pestanas={PESTANAS} activa={pestana} alElegir={setPestana} idPanel={PANEL} />
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
      <Grupo titulo="Sesiones nuevas">
        <Ajuste titulo="Carpeta de trabajo" descripcion="Donde empiezan las sesiones nuevas.">
          <CampoCarpeta etiqueta="Carpeta" carpeta={form.carpeta} alCambiar={(carpeta) => cambiar({ carpeta }, { carpeta }, tauri ? 0 : ESCRIBIENDO_MS)} />
        </Ajuste>
        <Ajuste titulo="Permisos" descripcion="Qué puede hacer sin preguntarte. Cada sesión puede cambiarlo.">
          <OpcionesPermisos valor={form.modoAprobacion} alCambiar={(modoAprobacion) => cambiar({ modoAprobacion }, { modoAprobacion })} />
        </Ajuste>
      </Grupo>
      {tauri && (
        <Grupo titulo="Windows">
          <Ajuste titulo="Arrancar con Windows" descripcion="Se queda en la bandeja al iniciar sesión, para que las tareas programadas y los canales sigan.">
            <Arranque />
          </Ajuste>
          <Ajuste titulo="Entrada rápida" descripcion="Un atajo de teclado que abre una caja para dar una tarea desde cualquier sitio.">
            <Atajo />
          </Ajuste>
        </Grupo>
      )}
    </>
  );
}

function Modelos({ form, cambiar }: PropsPestana) {
  const { proveedores, ajustes } = useEstado();
  const { guardarAjustes } = useAcciones();
  const conClave = [...proveedores.filter((p) => p.necesitaClave), { id: HF.id, nombre: HF.nombre, disponible: false }];

  /** «Usar por defecto» de un modelo descargado: se guarda ya. */
  const usarModeloLocal = async (id: string) => {
    const esfuerzo = esfuerzoTrasCambio(proveedores, "llamacpp", id, ajustes?.esfuerzo);
    await guardarAjustes({ proveedor: "llamacpp", modelo: id, ...(esfuerzo !== undefined ? { esfuerzo } : {}) });
  };

  return (
    <>
      <Grupo titulo="Modelo por defecto" descripcion="El de las sesiones nuevas. Cada sesión puede usar otro.">
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
      <Grupo titulo="Claves de API" descripcion="Se guardan en el almacén de credenciales de Windows, no en ficheros.">
        <div className="ajustes__claves">
          {conClave.map((p) => (
            <CampoClave key={p.id} id={p.id} nombre={p.nombre} disponible={p.disponible} />
          ))}
        </div>
      </Grupo>
      <Grupo titulo="Modelos de Hugging Face" descripcion="Descárgalos y úsalos en este equipo, sin conexión, con llama.cpp.">
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
        sufijo={guardada ? <Chip destacado>Guardada</Chip> : undefined}
      />
      {texto.trim() ? (
        <Boton type="submit" variante="secundario" tamano="pequeno" disabled={ocupado}>
          Guardar
        </Boton>
      ) : (
        guardada && (
          <Boton variante="fantasma" tamano="pequeno" icono="papelera" disabled={ocupado} onClick={() => void actuar(() => borrarClave(id))}>
            Borrar
          </Boton>
        )
      )}
    </form>
  );
}

function Herramientas({ form, cambiar }: PropsPestana) {
  const { proveedores } = useEstado();
  const h = form.herramientas;
  const terminal = (t: Partial<typeof h.terminal>, esperaMs = 0) =>
    cambiar({ herramientas: { ...h, terminal: { ...h.terminal, ...t } } }, { herramientas: { terminal: t } }, esperaMs);
  const guardian = (g: Partial<typeof h.guardian>) =>
    cambiar(
      { herramientas: { ...h, guardian: { ...h.guardian, ...g } } },
      { herramientas: { guardian: { ...g, ...("proveedor" in g ? { proveedor: g.proveedor ?? "", modelo: g.modelo ?? "" } : {}) } } },
    );
  return (
    <>
      <Grupo titulo="Terminal">
        <Ajuste titulo="Dónde se ejecutan los comandos" descripcion="En este equipo, en un contenedor Docker o en otra máquina por SSH.">
          <OpcionesChip leyenda="Terminal" opciones={ENTORNOS} valor={h.terminal.entorno} alCambiar={(entorno) => terminal({ entorno })} />
          {h.terminal.entorno === "docker" && (
            <Campo etiqueta="Imagen" mono spellCheck={false} value={h.terminal.imagen} onChange={(e) => terminal({ imagen: e.target.value }, ESCRIBIENDO_MS)} />
          )}
          {h.terminal.entorno === "ssh" && (
            <Campo
              etiqueta="Destino"
              mono
              spellCheck={false}
              placeholder="usuario@host"
              value={h.terminal.ssh ?? ""}
              onChange={(e) => terminal({ ssh: e.target.value }, ESCRIBIENDO_MS)}
            />
          )}
        </Ajuste>
      </Grupo>
      <Grupo titulo="Navegador y permisos">
        <Ajuste titulo="Navegador" descripcion="Le deja abrir y manejar una ventana de Edge.">
          <Interruptor aria-label="Navegador" activo={h.navegador} alCambiar={(navegador) => cambiar({ herramientas: { ...h, navegador } }, { herramientas: { navegador } })} />
        </Ajuste>
        <Ajuste titulo="Guardián" descripcion="Un modelo aprueba lo que es claramente seguro y te pregunta el resto.">
          <Interruptor aria-label="Guardián" activo={h.guardian.activo} alCambiar={(activo) => guardian({ activo })} />
          {h.guardian.activo && (
            <ProveedorModelo
              proveedores={proveedores}
              proveedor={h.guardian.proveedor ?? ""}
              modelo={h.guardian.modelo}
              vacio="Igual que la sesión"
              alCambiar={(proveedor, modelo) => guardian({ proveedor: proveedor || undefined, modelo })}
            />
          )}
        </Ajuste>
      </Grupo>
      <Grupo titulo="Servidores MCP" descripcion="Herramientas de otros programas que Aquiles puede usar.">
        <SeccionMcp />
      </Grupo>
      <Grupo titulo="Plugins">
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
      error={umbral(umbrales[clave]) === undefined ? "De 1 a 500" : undefined}
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
    <Grupo titulo="Revisión de lo aprendido">
      <Ajuste titulo="Revisar las conversaciones" descripcion="De vez en cuando revisa la conversación y propone qué recordar (memoria y habilidades).">
        <Interruptor aria-label="Revisar las conversaciones" activo={a.activo} alCambiar={(activo) => aprender({ activo }, { activo })} />
      </Ajuste>
      {a.activo && (
        <>
          <Ajuste titulo="Aplicar sin preguntar" descripcion="Guarda lo aprendido directamente, sin pasar por Memoria → Propuestas.">
            <Interruptor aria-label="Aplicar sin preguntar"
              activo={a.aplicarSinPreguntar}
              alCambiar={(aplicarSinPreguntar) => aprender({ aplicarSinPreguntar }, { aplicarSinPreguntar })}
            />
          </Ajuste>
          <Ajuste titulo="Cada cuánto" descripcion="Revisa al llegar a cualquiera de los dos.">
            <div className="ajustes__rejilla">
              {campoUmbral("herramientas", "Herramientas usadas")}
              {campoUmbral("mensajes", "Mensajes")}
            </div>
          </Ajuste>
          <Ajuste titulo="Modelo de la revisión">
            <ProveedorModelo
              proveedores={proveedores}
              proveedor={a.proveedor ?? ""}
              modelo={a.modelo}
              vacio="Igual que la sesión"
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
        <Grupo titulo="Actualizaciones" descripcion="Aquiles se compila desde la rama main de GitHub.">
          <Actualizaciones />
        </Grupo>
      )}
      <Grupo titulo="Perfiles" descripcion="Cada perfil tiene sus propias sesiones, memoria, habilidades y ajustes.">
        <Perfiles />
      </Grupo>
      <Grupo titulo="Copias de seguridad" descripcion="Copias del perfil actual, para restaurarlo si algo sale mal.">
        <Copias />
      </Grupo>
      {tauri && (
        <Grupo titulo="Núcleo remoto" descripcion="Conecta la app a un núcleo de Aquiles que corre en otra máquina.">
          <Remoto />
        </Grupo>
      )}
    </>
  );
}
