import type { Ajustes, InfoProveedor, ModoAprobacion } from "@aquiles/protocolo";
import { MODOS_APROBACION } from "@aquiles/protocolo";
import { Boton, Campo, Chip, Selector, Tarjeta, Titular, type OpcionSelector } from "@aquiles/ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { MODOS } from "../estado/formato";
import { hayClaveLlavero } from "../plataforma/claves";
import { elegirCarpeta } from "../plataforma/dialogo";
import { enTauri } from "../plataforma/tauri";

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

function opcionesProveedor(proveedores: InfoProveedor[], actual: string): OpcionSelector[] {
  const lista = proveedores.map((p) => ({ valor: p.id, texto: p.disponible ? p.nombre : `${p.nombre} · ${p.motivo ?? "no disponible"}`, deshabilitada: !p.disponible && p.id !== actual }));
  return lista.some((o) => o.valor === actual) ? lista : [{ valor: actual, texto: actual }, ...lista];
}

export function VistaAjustes() {
  const { ajustes, proveedores, conexion } = useEstado();
  const { guardarAjustes, guardarClave, borrarClave, refrescarProveedores } = useAcciones();
  const [form, setForm] = useState<Ajustes | undefined>(ajustes);
  const [claves, setClaves] = useState<Record<string, string>>({});
  const [enLlavero, setEnLlavero] = useState<Record<string, boolean | undefined>>({});
  const [guardado, setGuardado] = useState<Guardado>();
  const conectada = conexion === "conectada";
  const conClave = proveedores.filter((p) => p.necesitaClave);

  useEffect(() => {
    if (conectada) void refrescarProveedores().catch(() => {});
  }, [conectada, refrescarProveedores]);

  useEffect(() => {
    if (ajustes && !form) setForm(ajustes);
  }, [ajustes, form]);

  const idsConClave = conClave.map((p) => p.id).join(",");
  const leerLlavero = useCallback(async () => {
    const ids = idsConClave.split(",").filter(Boolean);
    const pares = await Promise.all(ids.map(async (id) => [id, await hayClaveLlavero(id).catch(() => undefined)] as const));
    setEnLlavero(Object.fromEntries(pares));
  }, [idsConClave]);

  useEffect(() => {
    void leerLlavero();
  }, [leerLlavero]);

  if (!form) return <div className="ajustes" />;

  const cambiar = (c: Partial<Ajustes>) => {
    setForm({ ...form, ...c });
    setGuardado(undefined);
  };
  const info = proveedores.find((p) => p.id === form.proveedor);

  const guardar = async () => {
    setGuardado({ tipo: "guardando" });
    try {
      for (const [proveedor, clave] of Object.entries(claves)) if (clave.trim()) await guardarClave(proveedor, clave.trim());
      const nuevos = await guardarAjustes({ proveedor: form.proveedor, modelo: form.modelo ?? "", modoAprobacion: form.modoAprobacion, carpeta: form.carpeta });
      setForm(nuevos);
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
          <div className="ajustes__rejilla">
            <Selector
              etiqueta="Proveedor"
              opciones={opcionesProveedor(proveedores, form.proveedor)}
              valor={form.proveedor}
              alCambiar={(proveedor) => cambiar({ proveedor, modelo: undefined })}
            />
            {info && info.modelos.length > 0 ? (
              <Selector
                etiqueta="Modelo"
                mono
                opciones={[{ valor: "", texto: info.modeloPorDefecto ? `Por defecto (${info.modeloPorDefecto})` : "Por defecto" }, ...info.modelos.map((m) => ({ valor: m, texto: m }))]}
                valor={form.modelo ?? ""}
                alCambiar={(m) => cambiar({ modelo: m || undefined })}
              />
            ) : (
              <Campo etiqueta="Modelo" mono value={form.modelo ?? ""} spellCheck={false} onChange={(e) => cambiar({ modelo: e.target.value || undefined })} />
            )}
          </div>
        </Seccion>

        <Seccion numero="02" titulo="Permisos">
          <fieldset className="ajustes__opciones">
            <legend className="nx-sr">Modo de permisos por defecto</legend>
            {MODOS_APROBACION.map((m: ModoAprobacion) => (
              <label key={m} className="nx-chip nx-chip--opcion">
                <input
                  type="radio"
                  name="modo-aprobacion"
                  className="nx-sr"
                  value={m}
                  checked={form.modoAprobacion === m}
                  onChange={() => cambiar({ modoAprobacion: m })}
                />
                {MODOS[m]}
              </label>
            ))}
          </fieldset>
        </Seccion>

        <Seccion numero="03" titulo="Carpeta de trabajo">
          {enTauri() ? (
            <Campo
              etiqueta="Carpeta"
              mono
              readOnly
              value={form.carpeta}
              sufijo={
                <Boton
                  variante="chip"
                  tamano="pequeno"
                  icono="carpeta"
                  onClick={async () => {
                    const c = await elegirCarpeta(form.carpeta).catch(() => null);
                    if (c) cambiar({ carpeta: c });
                  }}
                >
                  Elegir
                </Boton>
              }
            />
          ) : (
            <Campo etiqueta="Carpeta" mono spellCheck={false} value={form.carpeta} onChange={(e) => cambiar({ carpeta: e.target.value })} />
          )}
        </Seccion>

        {conClave.length > 0 && (
          <Seccion numero="04" titulo="Claves de API">
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
          <Boton variante="principal" iconoFinal="flecha-diagonal" disabled={!conectada || guardado?.tipo === "guardando"} onClick={() => void guardar()}>
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
