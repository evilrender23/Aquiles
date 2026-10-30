import type { InfoProveedor, ModoAprobacion } from "@aquiles/protocolo";
import { MODOS_APROBACION } from "@aquiles/protocolo";
import { Boton, Desplegable, GrupoOpciones, Icono, Medidor, Opcion } from "@aquiles/ui";
import { useState } from "react";
import { MODOS, nombreModelo, tokens } from "../estado/formato";
import { esfuerzoDe, nombreEsfuerzo, opcionesEsfuerzo } from "../estado/esfuerzo";

export interface PropsSelectorModelo {
  proveedor: string;
  modelo?: string;
  proveedores: InfoProveedor[];
  alElegir: (proveedor: string, modelo?: string) => void;
  deshabilitado?: boolean;
  alineacion?: "izquierda" | "derecha";
}

/** Chip con el modelo; abre la lista de proveedores con sus modelos. Si un proveedor no lista modelos, se escribe el id. */
export function SelectorModelo({ proveedor, modelo, proveedores, alElegir, deshabilitado, alineacion = "derecha" }: PropsSelectorModelo) {
  return (
    <Desplegable
      etiqueta="Modelo"
      alineacion={alineacion}
      disparador={({ alternar, abierto: _a, ...aria }) => (
        <Boton variante="chip" iconoFinal="chevron-abajo" disabled={deshabilitado} onClick={alternar} {...aria}>
          <span className="chip-modelo">{nombreModelo(proveedor, modelo, proveedores)}</span>
        </Boton>
      )}
    >
      {(cerrar) =>
        proveedores.length === 0 ? (
          <GrupoOpciones titulo={proveedor} />
        ) : (
          proveedores.map((p) => (
            <div key={p.id} data-proveedor={p.id}>
              <GrupoOpciones titulo={p.nombre} motivo={p.disponible ? undefined : p.motivo} />
              {p.modelos.length > 0 ? (
                p.modelos.map((m) => (
                  <Opcion
                    key={m}
                    texto={m}
                    marcada={p.id === proveedor && (modelo ?? p.modeloPorDefecto) === m}
                    deshabilitada={!p.disponible}
                    alElegir={() => {
                      alElegir(p.id, m);
                      cerrar();
                    }}
                  />
                ))
              ) : (
                <ModeloEscrito
                  activo={p.id === proveedor}
                  valor={p.id === proveedor ? (modelo ?? "") : ""}
                  deshabilitado={!p.disponible}
                  alUsar={(m) => {
                    alElegir(p.id, m || undefined);
                    cerrar();
                  }}
                />
              )}
            </div>
          ))
        )
      }
    </Desplegable>
  );
}

/** Chip del esfuerzo de razonamiento del modelo elegido. Si el modelo no declara niveles, no hay chip. */
export function SelectorEsfuerzo({
  proveedor,
  modelo,
  esfuerzo,
  proveedores,
  alElegir,
  deshabilitado,
  alineacion = "derecha",
}: {
  proveedor: string;
  modelo?: string;
  esfuerzo?: string;
  proveedores: InfoProveedor[];
  alElegir: (esfuerzo: string) => void;
  deshabilitado?: boolean;
  alineacion?: "izquierda" | "derecha";
}) {
  const e = esfuerzoDe(proveedores, proveedor, modelo);
  if (!e) return null;
  const actual = esfuerzo && e.niveles.includes(esfuerzo) ? esfuerzo : "";
  const visible = actual || e.porDefecto;
  return (
    <Desplegable
      etiqueta="Esfuerzo"
      alineacion={alineacion}
      disparador={({ alternar, abierto: _a, ...aria }) => (
        <Boton variante="chip" icono="esfuerzo" iconoFinal="chevron-abajo" disabled={deshabilitado} onClick={alternar} title="Esfuerzo" {...aria}>
          {visible ? nombreEsfuerzo(visible) : "Por defecto"}
        </Boton>
      )}
    >
      {(cerrar) =>
        opcionesEsfuerzo(e).map((o) => (
          <Opcion
            key={o.valor || "-"}
            texto={o.texto}
            marcada={o.valor === actual}
            alElegir={() => {
              alElegir(o.valor);
              cerrar();
            }}
          />
        ))
      }
    </Desplegable>
  );
}

function ModeloEscrito({ activo, valor, deshabilitado, alUsar }: { activo: boolean; valor: string; deshabilitado: boolean; alUsar: (m: string) => void }) {
  const [texto, setTexto] = useState(valor);
  // Sin <form>: el menú vive dentro del formulario de la caja de texto y los formularios no se anidan.
  return (
    <div className="modelo-escrito">
      <input
        className="modelo-escrito__entrada"
        aria-label="Id del modelo"
        placeholder="id del modelo"
        value={texto}
        disabled={deshabilitado}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          e.stopPropagation();
          alUsar(texto.trim());
        }}
      />
      <button type="button" className="nx-opcion modelo-escrito__usar" role="menuitemradio" aria-checked={activo} disabled={deshabilitado} onClick={() => alUsar(texto.trim())}>
        Usar
        {activo && <Icono nombre="check" tamano={14} grosor={2.5} className="nx-opcion__marca" />}
      </button>
    </div>
  );
}

export function SelectorPermisos({
  modo,
  alElegir,
  deshabilitado,
  alineacion = "izquierda",
}: {
  modo: ModoAprobacion;
  alElegir: (m: ModoAprobacion) => void;
  deshabilitado?: boolean;
  alineacion?: "izquierda" | "derecha";
}) {
  return (
    <Desplegable
      etiqueta="Permisos"
      alineacion={alineacion}
      disparador={({ alternar, abierto: _a, ...aria }) => (
        <Boton variante="chip" iconoFinal="chevron-abajo" disabled={deshabilitado} onClick={alternar} {...aria}>
          {MODOS[modo]}
        </Boton>
      )}
    >
      {(cerrar) =>
        MODOS_APROBACION.map((m) => (
          <Opcion
            key={m}
            texto={MODOS[m]}
            marcada={m === modo}
            alElegir={() => {
              alElegir(m);
              cerrar();
            }}
          />
        ))
      }
    </Desplegable>
  );
}

/** Uso del contexto: compacto junto a la caja de texto, o grande en la columna lateral (como en el lienzo). */
export function MedidorContexto({ uso, grande }: { uso?: { tokens: number; ventana?: number }; grande?: boolean }) {
  if (!uso) return null;
  const fraccion = uso.ventana ? uso.tokens / uso.ventana : undefined;
  const etiqueta = uso.ventana ? `Contexto: ${tokens(uso.tokens)} de ${tokens(uso.ventana)} tokens` : `Contexto: ${tokens(uso.tokens)} tokens`;
  if (grande) {
    return (
      <div className="contexto-grande">
        <span className="nx-etiqueta">Contexto</span>
        <div className="contexto-grande__cifras">
          <span className="contexto-grande__valor">{tokens(uso.tokens)}</span>
          <span className="contexto-grande__total">{uso.ventana ? `de ${tokens(uso.ventana)} tokens` : "tokens"}</span>
        </div>
        {fraccion !== undefined && <Medidor valor={fraccion} etiqueta={etiqueta} />}
      </div>
    );
  }
  return (
    <div className="contexto-compacto" title={etiqueta}>
      <span>{uso.ventana ? `${tokens(uso.tokens)} / ${tokens(uso.ventana)}` : tokens(uso.tokens)}</span>
      {fraccion !== undefined && <Medidor valor={fraccion} etiqueta={etiqueta} className="contexto-compacto__barra" />}
    </div>
  );
}
