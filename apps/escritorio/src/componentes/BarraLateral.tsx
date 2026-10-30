import type { InfoSesion } from "@aquiles/protocolo";
import { Boton, BranchedMenu, Etiqueta, LogoAscii, clases, type GrupoRamas } from "@aquiles/ui";
import { useEffect, useMemo, useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { nombreCarpeta } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import { FilaSesion } from "./FilaSesion";

/** Sesiones agrupadas por carpeta de trabajo; grupos y sesiones, de la más reciente a la más antigua. */
function agrupar(sesiones: InfoSesion[]): GrupoRamas<InfoSesion>[] {
  const porCwd = new Map<string, InfoSesion[]>();
  for (const s of [...sesiones].sort((a, b) => b.actualizada.localeCompare(a.actualizada))) {
    const lista = porCwd.get(s.cwd) ?? [];
    lista.push(s);
    porCwd.set(s.cwd, lista);
  }
  return [...porCwd].map(([cwd, hijos]) => ({ id: cwd, etiqueta: nombreCarpeta(cwd), titulo: cwd, hijos }));
}

export function BarraLateral({ alElegir }: { alElegir: () => void }) {
  const estado = useEstado();
  const { nuevaSesion, abrirSesion, abrirAjustes } = useAcciones();
  const grupos = useMemo(() => agrupar(Object.values(estado.sesiones)), [estado.sesiones]);
  const [abiertos, setAbiertos] = useState<ReadonlySet<string>>(new Set());
  const cwdActiva = estado.activa ? estado.sesiones[estado.activa]?.cwd : undefined;
  const primerGrupo = grupos[0]?.id;
  const ahora = useReloj(60_000);

  // Abre el grupo de la sesión activa y, al principio, el más reciente.
  useEffect(() => {
    setAbiertos((a) => {
      const extra = [cwdActiva, a.size === 0 ? primerGrupo : undefined].filter((x): x is string => !!x && !a.has(x));
      return extra.length ? new Set([...a, ...extra]) : a;
    });
  }, [cwdActiva, primerGrupo]);

  const alternar = (id: string) =>
    setAbiertos((a) => {
      const n = new Set(a);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const ir = (f: () => void) => () => {
    f();
    alElegir();
  };

  const secciones = [
    { n: "01", etiqueta: "Conversaciones", activa: estado.vista === "conversacion", ir: ir(() => (estado.activa ? abrirSesion(estado.activa) : nuevaSesion())) },
    { n: "02", etiqueta: "Ajustes", activa: estado.vista === "ajustes", ir: ir(abrirAjustes) },
  ];

  return (
    <aside className="lateral">
      <button type="button" className="lateral__logo" aria-label="Aquiles, nueva sesión" onClick={ir(nuevaSesion)}>
        <LogoAscii />
      </button>

      <Boton variante="secundario" tamano="alto" ancho icono="mas" onClick={ir(nuevaSesion)}>
        Nueva sesión
      </Boton>

      <nav aria-label="Secciones" className="lateral__secciones">
        {secciones.map((s) => (
          <button key={s.n} type="button" className={clases("seccion", s.activa && "seccion--activa")} aria-current={s.activa ? "page" : undefined} onClick={s.ir}>
            <span className="seccion__numero">{s.n}</span>
            <span className="seccion__nombre">{s.etiqueta}</span>
          </button>
        ))}
      </nav>

      {grupos.length > 0 && (
        <div className="lateral__historial">
          <Etiqueta className="lateral__titulo-historial">Historial</Etiqueta>
          <BranchedMenu
            etiqueta="Historial de conversaciones"
            grupos={grupos}
            abiertos={abiertos}
            alAlternar={alternar}
            claveHijo={(s) => s.sesionId}
            esActual={(s) => estado.vista === "conversacion" && s.sesionId === estado.activa}
            renderHijo={(s, actual) => (
              <FilaSesion
                sesion={s}
                actual={actual}
                pendiente={estado.pendientes.find((p) => p.sesionId === s.sesionId)?.tipo}
                ahora={ahora}
                alAbrir={ir(() => abrirSesion(s.sesionId))}
              />
            )}
          />
        </div>
      )}
    </aside>
  );
}
