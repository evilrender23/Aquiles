/** Campos que comparten Ajustes y el formulario de tareas programadas. */
import type { InfoProveedor, ModoAprobacion } from "@aquiles/protocolo";
import { MODOS_APROBACION } from "@aquiles/protocolo";
import { Boton, Campo, Selector, type OpcionSelector } from "@aquiles/ui";
import { useEffect, useId, useRef } from "react";
import { esfuerzoDe, opcionesEsfuerzo } from "../estado/esfuerzo";
import { MODOS } from "../estado/formato";
import { elegirCarpeta } from "../plataforma/dialogo";
import { enTauri } from "../plataforma/tauri";

function opcionesProveedor(proveedores: InfoProveedor[], actual: string): OpcionSelector[] {
  const lista = proveedores.map((p) => ({ valor: p.id, texto: p.disponible ? p.nombre : `${p.nombre} · ${p.motivo ?? "no disponible"}`, deshabilitada: !p.disponible && p.id !== actual }));
  return !actual || lista.some((o) => o.valor === actual) ? lista : [{ valor: actual, texto: actual }, ...lista];
}

/**
 * Proveedor y modelo (lista de modelos si el proveedor la da; si no, el id a mano).
 * Con `vacio`, el proveedor puede quedar sin elegir (y entonces no hay modelo).
 * Con `alEsfuerzo`, también el esfuerzo, si el modelo declara niveles.
 */
export function ProveedorModelo({
  proveedores,
  proveedor,
  modelo,
  vacio,
  alCambiar,
  esfuerzo,
  alEsfuerzo,
}: {
  proveedores: InfoProveedor[];
  proveedor: string;
  modelo?: string;
  vacio?: string;
  alCambiar: (proveedor: string, modelo: string | undefined) => void;
  esfuerzo?: string;
  alEsfuerzo?: (esfuerzo: string) => void;
}) {
  const info = proveedores.find((p) => p.id === proveedor);
  const opciones = opcionesProveedor(proveedores, proveedor);
  const niveles = alEsfuerzo ? esfuerzoDe(proveedores, proveedor, modelo) : undefined;
  return (
    <div className="ajustes__rejilla">
      <Selector
        etiqueta="Proveedor"
        opciones={vacio !== undefined ? [{ valor: "", texto: vacio }, ...opciones] : opciones}
        valor={proveedor}
        alCambiar={(p) => alCambiar(p, undefined)}
      />
      {!proveedor ? null : info && info.modelos.length > 0 ? (
        <Selector
          etiqueta="Modelo"
          mono
          opciones={[{ valor: "", texto: info.modeloPorDefecto ? `Por defecto (${info.modeloPorDefecto})` : "Por defecto" }, ...info.modelos.map((m) => ({ valor: m, texto: m }))]}
          valor={modelo ?? ""}
          alCambiar={(m) => alCambiar(proveedor, m || undefined)}
        />
      ) : (
        <Campo etiqueta="Modelo" mono value={modelo ?? ""} spellCheck={false} onChange={(e) => alCambiar(proveedor, e.target.value || undefined)} />
      )}
      {niveles && alEsfuerzo && (
        <Selector
          etiqueta="Esfuerzo"
          opciones={opcionesEsfuerzo(niveles)}
          valor={esfuerzo && niveles.niveles.includes(esfuerzo) ? esfuerzo : ""}
          alCambiar={alEsfuerzo}
        />
      )}
    </div>
  );
}

/** Carpeta: diálogo nativo en la app; texto a mano en el navegador. */
export function CampoCarpeta({ carpeta, alCambiar, etiqueta = "Carpeta" }: { carpeta: string; alCambiar: (c: string) => void; etiqueta?: string }) {
  return enTauri() ? (
    <Campo
      etiqueta={etiqueta}
      mono
      readOnly
      value={carpeta}
      sufijo={
        <Boton
          variante="chip"
          tamano="pequeno"
          icono="carpeta"
          onClick={async () => {
            const c = await elegirCarpeta(carpeta).catch(() => null);
            if (c) alCambiar(c);
          }}
        >
          Elegir
        </Boton>
      }
    />
  ) : (
    <Campo etiqueta={etiqueta} mono spellCheck={false} value={carpeta} onChange={(e) => alCambiar(e.target.value)} />
  );
}

/** Opciones en chips de radio (permisos, entorno de la terminal…). */
export function OpcionesChip<T extends string>({ leyenda, opciones, valor, alCambiar }: { leyenda: string; opciones: { valor: T; texto: string }[]; valor: T; alCambiar: (v: T) => void }) {
  const nombre = useId();
  return (
    <fieldset className="ajustes__opciones">
      <legend className="nx-sr">{leyenda}</legend>
      {opciones.map((o) => (
        <label key={o.valor} className="nx-chip nx-chip--opcion">
          <input type="radio" name={nombre} className="nx-sr" value={o.valor} checked={valor === o.valor} onChange={() => alCambiar(o.valor)} />
          {o.texto}
        </label>
      ))}
    </fieldset>
  );
}

export function OpcionesPermisos({ valor, alCambiar, leyenda = "Modo de permisos" }: { valor: ModoAprobacion; alCambiar: (m: ModoAprobacion) => void; leyenda?: string }) {
  return <OpcionesChip leyenda={leyenda} opciones={MODOS_APROBACION.map((m) => ({ valor: m, texto: MODOS[m] }))} valor={valor} alCambiar={alCambiar} />;
}

/** Confirmación en el sitio, con el foco en «Cancelar» (Escape también cancela). */
export function ConfirmarBorrado({ ocupado, alBorrar, alCancelar, texto = "Borrar" }: { ocupado?: boolean; alBorrar: () => void; alCancelar: () => void; texto?: string }) {
  const cancelar = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelar.current?.focus(), []);
  return (
    <span className="confirmar">
      <Boton variante="acento" disabled={ocupado} onClick={alBorrar}>
        {texto}
      </Boton>
      <Boton variante="fantasma" ref={cancelar} onClick={alCancelar} onKeyDown={(e) => e.key === "Escape" && alCancelar()}>
        Cancelar
      </Boton>
    </span>
  );
}
