import type { InfoSesion } from "@aquiles/protocolo";
import { Boton, BranchedMenu, CampoBusqueda, Etiqueta, LogoAscii, clases, type GrupoRamas } from "@aquiles/ui";
import { useEffect, useMemo, useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { abrirCarpeta, puedeMostrarRutas } from "../plataforma/aplicacion";
import { usePropuestas } from "../estado/aprendizaje";
import { nombreCarpeta } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import { AvisoActualizacion } from "./AvisoActualizacion";
import { FilaSesion } from "./FilaSesion";
import { ResultadosBusqueda } from "./ResultadosBusqueda";

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
  const { nuevaSesion, nuevaSesionEn, abrirSesion, abrirHabilidades, abrirMemoria, abrirAutomatizaciones, abrirEstadisticas, abrirAjustes } = useAcciones();
  const [consulta, setConsulta] = useState("");
  // «Buscar en conversaciones» desde el menú de una selección.
  const pedida = estado.pedidos.busqueda;
  useEffect(() => {
    if (pedida) setConsulta(pedida.texto);
  }, [pedida]);
  // Los subagentes no van sueltos: se ven en el panel de su sesión.
  const grupos = useMemo(() => agrupar(Object.values(estado.sesiones).filter((s) => s.origen?.tipo !== "subagente")), [estado.sesiones]);
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

  // Como en el lienzo: la cifra en lima junto a Memoria son las propuestas pendientes.
  const pendientes = usePropuestas().datos?.length ?? 0;
  const secciones = [
    { n: "01", etiqueta: "Habilidades", activa: estado.vista === "habilidades", ir: ir(abrirHabilidades) },
    {
      n: "02",
      etiqueta: "Memoria",
      activa: estado.vista === "memoria",
      ir: ir(() => abrirMemoria()),
      cuenta: pendientes || undefined,
      tituloCuenta: pendientes === 1 ? "1 propuesta pendiente" : `${pendientes} propuestas pendientes`,
    },
    { n: "03", etiqueta: "Automatizaciones", activa: estado.vista === "automatizaciones", ir: ir(abrirAutomatizaciones) },
    { n: "04", etiqueta: "Estadísticas", activa: estado.vista === "estadisticas", ir: ir(abrirEstadisticas) },
    { n: "05", etiqueta: "Ajustes", activa: estado.vista === "ajustes", ir: ir(abrirAjustes) },
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
            {"cuenta" in s && s.cuenta && (
              <span className="seccion__cuenta" title={s.tituloCuenta}>
                <span aria-hidden="true">{s.cuenta}</span>
                <span className="nx-sr">{s.tituloCuenta}</span>
              </span>
            )}
          </button>
        ))}
      </nav>

      <AvisoActualizacion alVerDetalle={ir(abrirAjustes)} />

      {grupos.length > 0 && (
        <div className="lateral__historial">
          <CampoBusqueda className="lateral__buscar" tamano="pequeno" etiqueta="Buscar en las conversaciones" placeholder="Buscar" valor={consulta} alCambiar={setConsulta} />
          {consulta.trim() ? (
            <ResultadosBusqueda consulta={consulta} ahora={ahora} alAbrir={(id) => ir(() => abrirSesion(id))()} />
          ) : (
            <>
              <Etiqueta className="lateral__titulo-historial">Historial</Etiqueta>
              <BranchedMenu
                etiqueta="Historial de conversaciones"
                grupos={grupos}
                abiertos={abiertos}
                alAlternar={alternar}
                claveHijo={(s) => s.sesionId}
                menuGrupo={(g, abierto) => [
                  { texto: "Nueva sesión en esta carpeta", icono: "mas", alElegir: () => ir(() => void nuevaSesionEn(g.id))() },
                  puedeMostrarRutas() && { texto: "Mostrar carpeta", icono: "carpeta", alElegir: () => abrirCarpeta(g.id) },
                  { tipo: "separador" },
                  { texto: abierto ? "Plegar" : "Desplegar", icono: abierto ? "chevron-abajo" : "chevron-derecha", alElegir: () => alternar(g.id) },
                ]}
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
            </>
          )}
        </div>
      )}
    </aside>
  );
}
