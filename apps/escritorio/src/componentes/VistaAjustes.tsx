import type { Ajustes, AjustesAprendizaje, AjustesHerramientas, EntornoTerminal } from "@aquiles/protocolo";
import { Boton, Campo, CampoInterruptor, Chip, Etiqueta, Tarjeta, Titular } from "@aquiles/ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { hayClaveLlavero } from "../plataforma/claves";
import { CampoCarpeta, OpcionesChip, OpcionesPermisos, ProveedorModelo } from "./Campos";
import { SeccionAplicacion, SeccionPlugins } from "./Aplicacion";
import { SeccionMcp } from "./Mcp";

type Guardado = { tipo: "guardando" } | { tipo: "ok" } | { tipo: "error"; texto: string };

function Seccion({ numero, titulo, children }: { numero: string; titulo: string; children: ReactNode }) {
  return (
    <Tarjeta como="section" className="ajustes__seccion" aria-labelledby={`ajustes-${numero}`}>
      <div className="ajustes__encabezado">
        <span className="ajustes__numero">{numero}</span>
        <h2 id={`ajustes-${numero}`} className="ajustes__titulo">
          {titulo}
        </h2>
      </div>
      <div className="ajustes__cuerpo">{children}</div>
    </Tarjeta>
  );
}

/** Umbral de la revisión: entero de 1 a 500 (lo que acepta el núcleo). */
function umbral(texto: string): number | undefined {
  const n = Number(texto);
  return texto.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 500 ? n : undefined;
}

const ENTORNOS: { valor: EntornoTerminal; texto: string }[] = [
  { valor: "local", texto: "Local" },
  { valor: "docker", texto: "Docker" },
  { valor: "ssh", texto: "SSH" },
];

export function VistaAjustes() {
  const { ajustes, proveedores, conexion } = useEstado();
  const { guardarAjustes, guardarClave, borrarClave, refrescarProveedores } = useAcciones();
  const [form, setForm] = useState<Ajustes | undefined>(ajustes);
  const [claves, setClaves] = useState<Record<string, string>>({});
  const [enLlavero, setEnLlavero] = useState<Record<string, boolean | undefined>>({});
  const [guardado, setGuardado] = useState<Guardado>();
  // Los umbrales se editan como texto para poder vaciar el campo mientras se escribe.
  const [umbrales, setUmbrales] = useState<{ herramientas: string; mensajes: string }>();
  const conectada = conexion === "conectada";
  const conClave = proveedores.filter((p) => p.necesitaClave);

  useEffect(() => {
    if (conectada) void refrescarProveedores().catch(() => {});
  }, [conectada, refrescarProveedores]);

  useEffect(() => {
    if (ajustes && !form) setForm(ajustes);
  }, [ajustes, form]);

  useEffect(() => {
    if (form && !umbrales) setUmbrales({ herramientas: String(form.aprendizaje.cadaHerramientas), mensajes: String(form.aprendizaje.cadaMensajes) });
  }, [form, umbrales]);

  const idsConClave = conClave.map((p) => p.id).join(",");
  const leerLlavero = useCallback(async () => {
    const ids = idsConClave.split(",").filter(Boolean);
    const pares = await Promise.all(ids.map(async (id) => [id, await hayClaveLlavero(id).catch(() => undefined)] as const));
    setEnLlavero(Object.fromEntries(pares));
  }, [idsConClave]);

  useEffect(() => {
    void leerLlavero();
  }, [leerLlavero]);

  if (!form || !umbrales) return <div className="ajustes" />;

  const cambiar = (c: Partial<Ajustes>) => {
    setForm({ ...form, ...c });
    setGuardado(undefined);
  };
  const cambiarAprendizaje = (c: Partial<AjustesAprendizaje>) => cambiar({ aprendizaje: { ...form.aprendizaje, ...c } });
  const herramientas = form.herramientas;
  const cambiarHerramientas = (c: Partial<AjustesHerramientas>) => cambiar({ herramientas: { ...herramientas, ...c } });
  const cadaHerramientas = umbral(umbrales.herramientas);
  const cadaMensajes = umbral(umbrales.mensajes);
  const valido = cadaHerramientas !== undefined && cadaMensajes !== undefined;

  const guardar = async () => {
    setGuardado({ tipo: "guardando" });
    try {
      for (const [proveedor, clave] of Object.entries(claves)) if (clave.trim()) await guardarClave(proveedor, clave.trim());
      const a = form.aprendizaje;
      const { terminal, guardian } = herramientas;
      const nuevos = await guardarAjustes({
        proveedor: form.proveedor,
        modelo: form.modelo ?? "",
        modoAprobacion: form.modoAprobacion,
        carpeta: form.carpeta,
        // Proveedor y modelo vacíos = los de la sesión (revisada o vigilada).
        aprendizaje: { ...a, cadaHerramientas: cadaHerramientas ?? a.cadaHerramientas, cadaMensajes: cadaMensajes ?? a.cadaMensajes, proveedor: a.proveedor ?? "", modelo: a.modelo ?? "" },
        herramientas: {
          navegador: herramientas.navegador,
          terminal: { entorno: terminal.entorno, ...(terminal.imagen.trim() ? { imagen: terminal.imagen.trim() } : {}), ssh: terminal.ssh?.trim() ?? "" },
          guardian: { activo: guardian.activo, proveedor: guardian.proveedor ?? "", modelo: guardian.modelo ?? "" },
        },
      });
      setForm(nuevos);
      setUmbrales({ herramientas: String(nuevos.aprendizaje.cadaHerramientas), mensajes: String(nuevos.aprendizaje.cadaMensajes) });
      setClaves({});
      await Promise.all([refrescarProveedores(), leerLlavero()]);
      setGuardado({ tipo: "ok" });
    } catch (e) {
      setGuardado({ tipo: "error", texto: e instanceof Error ? e.message : String(e) });
    }
  };

  const quitarClave = async (proveedor: string) => {
    try {
      await borrarClave(proveedor);
      await Promise.all([refrescarProveedores(), leerLlavero()]);
    } catch (e) {
      setGuardado({ tipo: "error", texto: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="ajustes">
      <div className="ajustes__pagina">
        <Titular texto="Ajustes" tamano="l" />

        <Seccion numero="01" titulo="Modelo">
          <ProveedorModelo proveedores={proveedores} proveedor={form.proveedor} modelo={form.modelo} alCambiar={(proveedor, modelo) => cambiar({ proveedor, modelo })} />
        </Seccion>

        <Seccion numero="02" titulo="Permisos">
          <OpcionesPermisos leyenda="Modo de permisos por defecto" valor={form.modoAprobacion} alCambiar={(modoAprobacion) => cambiar({ modoAprobacion })} />
        </Seccion>

        <Seccion numero="03" titulo="Carpeta de trabajo">
          <CampoCarpeta carpeta={form.carpeta} alCambiar={(carpeta) => cambiar({ carpeta })} />
        </Seccion>

        <Seccion numero="04" titulo="Aprendizaje">
          <div className="ajustes__interruptores">
            <CampoInterruptor etiqueta="Activo" activo={form.aprendizaje.activo} alCambiar={(activo) => cambiarAprendizaje({ activo })} />
            <CampoInterruptor
              etiqueta="Aplicar sin preguntar"
              activo={form.aprendizaje.aplicarSinPreguntar}
              alCambiar={(aplicarSinPreguntar) => cambiarAprendizaje({ aplicarSinPreguntar })}
            />
          </div>
          <div className="ajustes__rejilla">
            <Campo
              etiqueta="Herramientas entre revisiones"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={umbrales.herramientas}
              error={cadaHerramientas === undefined ? "De 1 a 500" : undefined}
              onChange={(e) => {
                setUmbrales({ ...umbrales, herramientas: e.target.value });
                setGuardado(undefined);
              }}
            />
            <Campo
              etiqueta="Mensajes entre revisiones"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={umbrales.mensajes}
              error={cadaMensajes === undefined ? "De 1 a 500" : undefined}
              onChange={(e) => {
                setUmbrales({ ...umbrales, mensajes: e.target.value });
                setGuardado(undefined);
              }}
            />
          </div>
          <ProveedorModelo
            proveedores={proveedores}
            proveedor={form.aprendizaje.proveedor ?? ""}
            modelo={form.aprendizaje.modelo}
            vacio="Igual que la sesión"
            alCambiar={(proveedor, modelo) => cambiarAprendizaje({ proveedor: proveedor || undefined, modelo })}
          />
        </Seccion>

        <Seccion numero="05" titulo="Herramientas">
          <div className="ajustes__interruptores">
            <CampoInterruptor etiqueta="Navegador" activo={herramientas.navegador} alCambiar={(navegador) => cambiarHerramientas({ navegador })} />
          </div>
          <div className="ajustes__grupo">
            <Etiqueta aria-hidden="true">Terminal</Etiqueta>
            <OpcionesChip
              leyenda="Terminal"
              opciones={ENTORNOS}
              valor={herramientas.terminal.entorno}
              alCambiar={(entorno) => cambiarHerramientas({ terminal: { ...herramientas.terminal, entorno } })}
            />
            {herramientas.terminal.entorno === "docker" && (
              <Campo
                etiqueta="Imagen"
                mono
                spellCheck={false}
                value={herramientas.terminal.imagen}
                onChange={(e) => cambiarHerramientas({ terminal: { ...herramientas.terminal, imagen: e.target.value } })}
              />
            )}
            {herramientas.terminal.entorno === "ssh" && (
              <Campo
                etiqueta="Destino"
                mono
                spellCheck={false}
                placeholder="usuario@host"
                value={herramientas.terminal.ssh ?? ""}
                onChange={(e) => cambiarHerramientas({ terminal: { ...herramientas.terminal, ssh: e.target.value } })}
              />
            )}
          </div>
          <div className="ajustes__grupo">
            <div className="ajustes__interruptores">
              <CampoInterruptor
                etiqueta="Guardián"
                activo={herramientas.guardian.activo}
                alCambiar={(activo) => cambiarHerramientas({ guardian: { ...herramientas.guardian, activo } })}
              />
            </div>
            {herramientas.guardian.activo && (
              <ProveedorModelo
                proveedores={proveedores}
                proveedor={herramientas.guardian.proveedor ?? ""}
                modelo={herramientas.guardian.modelo}
                vacio="Igual que la sesión"
                alCambiar={(proveedor, modelo) => cambiarHerramientas({ guardian: { ...herramientas.guardian, proveedor: proveedor || undefined, modelo } })}
              />
            )}
          </div>
        </Seccion>

        <Seccion numero="06" titulo="MCP">
          <SeccionMcp />
        </Seccion>

        <Seccion numero="07" titulo="Plugins">
          <SeccionPlugins />
        </Seccion>

        <Seccion numero="08" titulo="Aplicación">
          <SeccionAplicacion />
        </Seccion>

        {conClave.length > 0 && (
          <Seccion numero="09" titulo="Claves de API">
            <div className="ajustes__claves">
              {conClave.map((p) => {
                const guardada = enLlavero[p.id] ?? p.disponible;
                return (
                  <div key={p.id} className="ajustes__clave">
                    <Campo
                      etiqueta={p.nombre}
                      type="password"
                      mono
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={guardada ? "••••••••••••" : undefined}
                      value={claves[p.id] ?? ""}
                      onChange={(e) => {
                        setClaves({ ...claves, [p.id]: e.target.value });
                        setGuardado(undefined);
                      }}
                      sufijo={guardada ? <Chip destacado>Guardada</Chip> : undefined}
                    />
                    {guardada && (
                      <Boton variante="fantasma" tamano="pequeno" icono="papelera" onClick={() => void quitarClave(p.id)}>
                        Borrar
                      </Boton>
                    )}
                  </div>
                );
              })}
            </div>
          </Seccion>
        )}

        <div className="ajustes__pie">
          <Boton variante="principal" iconoFinal="flecha-diagonal" disabled={!conectada || !valido || guardado?.tipo === "guardando"} onClick={() => void guardar()}>
            Guardar
          </Boton>
          {guardado?.tipo === "ok" && <span className="ajustes__estado">Guardado</span>}
          {guardado?.tipo === "error" && (
            <span className="ajustes__estado ajustes__estado--error" role="alert">
              {guardado.texto}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
