/**
 * Estadísticas de uso y lo aprendido. Por día, un gráfico de columnas por medida (pequeños múltiplos,
 * una sola serie cada uno: el acento de NOX y sin leyenda); los rankings, en barras horizontales con su valor.
 * Cada gráfico se lee también sin pasar el ratón: total en la cabecera, valores en la tabla.
 */
import type { Estadisticas } from "@aquiles/protocolo";
import { Etiqueta, Titular, clases } from "@aquiles/ui";
import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { tokens } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import { LineaAprendido } from "./Aprendizaje";

type Dia = Estadisticas["porDia"][number];
type Medida = "sesiones" | "mensajes" | "herramientas" | "tokensEntrada" | "tokensSalida";

const MEDIDAS: { clave: Medida; titulo: string }[] = [
  { clave: "sesiones", titulo: "Sesiones" },
  { clave: "mensajes", titulo: "Mensajes" },
  { clave: "herramientas", titulo: "Herramientas" },
  { clave: "tokensEntrada", titulo: "Tokens de entrada" },
  { clave: "tokensSalida", titulo: "Tokens de salida" },
];
const PERIODOS = [7, 30, 90] as const;
/** Siempre con separador de miles («4.960», no «4960» junto a «40.500»): las columnas de cifras se leen igual. */
const cifras = new Intl.NumberFormat("es-ES", { useGrouping: "always" });
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** «2026-10-30» → «30 oct». */
function dia(d: string): string {
  const [, m, n] = d.split("-").map(Number);
  return m && n ? `${n} ${MESES[m - 1]}` : d;
}

/** Tope del eje: el máximo redondeado hacia arriba a una cifra limpia (1, 2, 2,5 o 5 × 10ⁿ). */
function tope(max: number): number {
  if (max <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(max));
  const limpio = [1, 2, 2.5, 5, 10].find((f) => f * base >= max) ?? 10;
  return limpio * base;
}

export function VistaEstadisticas() {
  const { revisiones } = useEstado();
  const { llamar } = useAcciones();
  const [dias, setDias] = useState<(typeof PERIODOS)[number]>(30);
  const [tabla, setTabla] = useState(false);
  // Mismo id para todos los periodos: al cambiar se sigue viendo el anterior (atenuado) hasta que llega el nuevo.
  const datos = useCarga("estadisticas", dias * 1_000_000 + revisiones.aprendizaje, () => llamar("estadisticas.leer", { dias }));
  const ahora = useReloj(60_000);
  const e = datos.datos;

  return (
    <div className="estadisticas">
      <div className={clases("estadisticas__pagina", datos.cargando && e && "estadisticas__pagina--cargando")}>
        <Titular texto="Estadísticas" tamano="l" />

        <div className="estadisticas__filtros">
          <fieldset className="habilidades__chips">
            <legend className="nx-sr">Periodo</legend>
            {PERIODOS.map((p) => (
              <button key={p} type="button" className="nx-chip habilidades__chip" aria-pressed={dias === p} onClick={() => setDias(p)}>
                {p} días
              </button>
            ))}
          </fieldset>
          <button type="button" className="nx-chip habilidades__chip" aria-pressed={tabla} onClick={() => setTabla((t) => !t)}>
            Tabla
          </button>
        </div>

        {datos.error && (
          <p className="automatizaciones__error" role="alert">
            {datos.error}
          </p>
        )}

        {e &&
          (tabla ? (
            <TablaPorDia porDia={e.porDia} />
          ) : (
            <div className="estadisticas__multiples">
              {MEDIDAS.map((m) => (
                <GraficoColumnas key={m.clave} titulo={m.titulo} porDia={e.porDia} medida={m.clave} />
              ))}
            </div>
          ))}

        {e && (
          <div className="estadisticas__rankings">
            <Ranking titulo="Herramientas más usadas" filas={e.herramientas.map((h) => ({ nombre: h.nombre, valor: h.usos }))} />
            <Ranking titulo="Habilidades más usadas" filas={e.skills.map((s) => ({ nombre: s.nombre, valor: s.usos }))} />
            <Ranking titulo="Sesiones por proveedor" filas={e.proveedores.map((p) => ({ nombre: p.proveedor, valor: p.sesiones }))} />
          </div>
        )}

        {e && e.aprendido.length > 0 && (
          <section className="estadisticas__seccion" aria-labelledby="titulo-aprendido">
            <h2 id="titulo-aprendido" className="automatizaciones__titulo">
              Aprendido
            </h2>
            <LineaAprendido entradas={e.aprendido} ahora={ahora} />
          </section>
        )}
      </div>
    </div>
  );
}

/** Columnas por día de una medida: total en la cabecera, tope del eje arriba, primer y último día abajo; el puntero o las flechas leen cada día. */
function GraficoColumnas({ titulo, porDia, medida }: { titulo: string; porDia: Dia[]; medida: Medida }) {
  const [activo, setActivo] = useState<number>();
  const valores = porDia.map((d) => d[medida]);
  const total = valores.reduce((a, b) => a + b, 0);
  const max = tope(Math.max(0, ...valores));
  const sel = activo !== undefined ? porDia[activo] : undefined;

  const porPuntero = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * porDia.length);
    setActivo(Math.min(porDia.length - 1, Math.max(0, i)));
  };
  const porTeclado = (e: KeyboardEvent<HTMLDivElement>) => {
    const pasos: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    const paso = pasos[e.key];
    if (paso === undefined && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    if (e.key === "Home") return setActivo(0);
    if (e.key === "End") return setActivo(porDia.length - 1);
    setActivo((a) => Math.min(porDia.length - 1, Math.max(0, (a ?? porDia.length - 1) + (paso ?? 0))));
  };

  return (
    <section className="grafico" aria-label={titulo}>
      <div className="grafico__cabecera">
        <span className="grafico__titulo">{titulo}</span>
        <span className="grafico__total">{tokens(total)}</span>
      </div>
      <div className="grafico__cuerpo">
        <span className="grafico__tope" aria-hidden="true">
          {tokens(max)}
        </span>
        {/* Con el teclado, las flechas recorren los días como un control deslizante; la tabla da los mismos datos. */}
        <div
          className="grafico__plano"
          role="slider"
          tabIndex={0}
          aria-label={`${titulo} por día`}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, porDia.length - 1)}
          aria-valuenow={activo ?? Math.max(0, porDia.length - 1)}
          aria-valuetext={(() => {
            const d = porDia[activo ?? porDia.length - 1];
            return d ? `${dia(d.dia)}: ${cifras.format(d[medida])}` : undefined;
          })()}
          onPointerMove={porPuntero}
          onPointerLeave={() => setActivo(undefined)}
          onFocus={() => setActivo((a) => a ?? porDia.length - 1)}
          onBlur={() => setActivo(undefined)}
          onKeyDown={porTeclado}
          // Con muchos días, la separación entre columnas baja a 1 px para que no se coma las columnas.
          style={{ gap: porDia.length > 45 ? 1 : 2 }}
        >
          {valores.map((v, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: un día por posición; la serie llega entera.
              key={i}
              className={clases("grafico__columna", activo === i && "grafico__columna--activa", activo !== undefined && activo !== i && "grafico__columna--atenuada")}
              style={{ height: `${(v / max) * 100}%` }}
            />
          ))}
          {sel && activo !== undefined && (
            <span className="grafico__aviso" role="status" style={{ left: `${((activo + 0.5) / porDia.length) * 100}%` }}>
              <strong>{tokens(sel[medida])}</strong>
              <span>{dia(sel.dia)}</span>
            </span>
          )}
        </div>
      </div>
      {porDia.length > 0 && (
        <div className="grafico__eje" aria-hidden="true">
          <span>{dia(porDia[0]!.dia)}</span>
          <span>{dia(porDia.at(-1)!.dia)}</span>
        </div>
      )}
    </section>
  );
}

function TablaPorDia({ porDia }: { porDia: Dia[] }) {
  return (
    <div className="estadisticas__tabla">
      <table>
        <thead>
          <tr>
            <th scope="col">Día</th>
            {MEDIDAS.map((m) => (
              <th key={m.clave} scope="col">
                {m.titulo}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...porDia].reverse().map((d) => (
            <tr key={d.dia}>
              <th scope="row">{dia(d.dia)}</th>
              {MEDIDAS.map((m) => (
                <td key={m.clave}>{cifras.format(d[m.clave])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Barras horizontales ordenadas, con el valor al final de cada barra (las diez primeras). */
function Ranking({ titulo, filas }: { titulo: string; filas: { nombre: string; valor: number }[] }) {
  const lista = [...filas].sort((a, b) => b.valor - a.valor).slice(0, 10);
  const max = Math.max(1, ...lista.map((f) => f.valor));
  if (!lista.length) return null;
  return (
    <section className="ranking" aria-label={titulo}>
      <Etiqueta>{titulo}</Etiqueta>
      {
        <ol className="ranking__lista">
          {lista.map((f) => (
            <li key={f.nombre} className="ranking__fila">
              <span className="ranking__nombre" title={f.nombre}>
                {f.nombre}
              </span>
              <span className="ranking__pista">
                <span className="ranking__barra" style={{ width: `${(f.valor / max) * 100}%` }} />
                <span className="ranking__valor">{cifras.format(f.valor)}</span>
              </span>
            </li>
          ))}
        </ol>
      }
    </section>
  );
}
