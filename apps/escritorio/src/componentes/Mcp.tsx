/** Ajustes → MCP: servidores, su estado y herramientas, y el formulario para añadir o editar. */
import type { InfoServidorMcp } from "@aquiles/protocolo";
import { Boton, BotonIcono, Campo, CampoInterruptor, Etiqueta, clases } from "@aquiles/ui";
import { useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import { useCarga } from "../estado/carga";
import { ConfirmarBorrado, OpcionesChip } from "./Campos";

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NOMBRE_VALIDO = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ESTADOS: Record<InfoServidorMcp["estado"], string> = { conectado: "Conectado", desconectado: "Desconectado", error: "Error" };

/** Argumentos separados por espacios; entre comillas si llevan espacios. */
function partirArgumentos(texto: string): string[] {
  const salida: string[] = [];
  for (const m of texto.matchAll(/"([^"]*)"|(\S+)/g)) salida.push(m[1] ?? m[2] ?? "");
  return salida;
}
const unirArgumentos = (args: string[]) => args.map((a) => (a === "" || /\s/.test(a) ? `"${a}"` : a)).join(" ");

export function SeccionMcp() {
  const { revisiones } = useEstado();
  const { llamar } = useAcciones();
  const servidores = useCarga("mcp", revisiones.mcp, async () => (await llamar("mcp.listar", {})).servidores);
  const [editando, setEditando] = useState<string | "nuevo">();

  const actualizar = (s: InfoServidorMcp) =>
    servidores.fijar((l) => (l.some((x) => x.nombre === s.nombre) ? l.map((x) => (x.nombre === s.nombre ? s : x)) : [...l, s]));

  if (servidores.error) {
    return (
      <p className="ajustes__estado ajustes__estado--error" role="alert">
        {servidores.error}
      </p>
    );
  }
  if (!servidores.datos) return null;
  return (
    <div className="mcp">
      {servidores.datos.map((s) =>
        editando === s.nombre ? (
          <FormularioMcp
            key={s.nombre}
            servidor={s}
            alCancelar={() => setEditando(undefined)}
            alGuardar={(n) => {
              actualizar(n);
              setEditando(undefined);
            }}
          />
        ) : (
          <ServidorMcp
            key={s.nombre}
            s={s}
            alEditar={() => setEditando(s.nombre)}
            alCambiar={actualizar}
            alBorrar={() => servidores.fijar((l) => l.filter((x) => x.nombre !== s.nombre))}
          />
        ),
      )}
      {editando === "nuevo" ? (
        <FormularioMcp
          alCancelar={() => setEditando(undefined)}
          alGuardar={(n) => {
            actualizar(n);
            setEditando(undefined);
          }}
        />
      ) : (
        <div>
          <Boton variante="secundario" icono="mas" onClick={() => setEditando("nuevo")}>
            Añadir
          </Boton>
        </div>
      )}
    </div>
  );
}

function ServidorMcp({ s, alEditar, alCambiar, alBorrar }: { s: InfoServidorMcp; alEditar: () => void; alCambiar: (s: InfoServidorMcp) => void; alBorrar: () => void }) {
  const { llamar } = useAcciones();
  const [verHerramientas, setVerHerramientas] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string>();

  const accion = async (f: () => Promise<void>) => {
    setOcupado(true);
    try {
      await f();
      setError(undefined);
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <article className="servidor-mcp">
      <div className="servidor-mcp__cabecera">
        <div className="servidor-mcp__datos">
          <span className="servidor-mcp__nombre">{s.nombre}</span>
          <span className="servidor-mcp__origen" title={s.tipo === "http" ? s.url : [s.comando, ...(s.args ?? [])].join(" ")}>
            {s.tipo === "http" ? s.url : unirArgumentos([s.comando ?? "", ...(s.args ?? [])])}
          </span>
        </div>
        <span className={clases("servidor-mcp__estado", `servidor-mcp__estado--${s.estado}`)}>
          <i aria-hidden="true" />
          {ESTADOS[s.estado]}
        </span>
      </div>
      {(s.error || error) && (
        <p className="servidor-mcp__error" role="alert">
          {error ?? s.error}
        </p>
      )}
      <CampoInterruptor
        etiqueta="Activo"
        activo={s.activo}
        disabled={ocupado}
        alCambiar={(activo) => void accion(async () => alCambiar(await llamar("mcp.guardar", { nombre: s.nombre, activo })))}
      />
      {s.herramientas.length > 0 && (
        <div className="servidor-mcp__herramientas">
          <button type="button" className="resumen__boton" aria-expanded={verHerramientas} onClick={() => setVerHerramientas((v) => !v)}>
            {s.herramientas.length === 1 ? "1 herramienta" : `${s.herramientas.length} herramientas`}
          </button>
          {verHerramientas && (
            <ul>
              {s.herramientas.map((h) => (
                <li key={h.nombre}>
                  <span className="servidor-mcp__herramienta">{h.nombre}</span>
                  {h.descripcion && <span className="servidor-mcp__descripcion">{h.descripcion}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="servidor-mcp__botones">
        <Boton variante="fantasma" tamano="pequeno" icono="lapiz" onClick={alEditar}>
          Editar
        </Boton>
        <Boton variante="fantasma" tamano="pequeno" icono="recargar" disabled={ocupado || !s.activo} onClick={() => void accion(async () => alCambiar(await llamar("mcp.reconectar", { nombre: s.nombre })))}>
          Reconectar
        </Boton>
        {borrando ? (
          <ConfirmarBorrado
            ocupado={ocupado}
            alBorrar={() =>
              void accion(async () => {
                await llamar("mcp.borrar", { nombre: s.nombre });
                alBorrar();
              })
            }
            alCancelar={() => setBorrando(false)}
          />
        ) : (
          <Boton variante="fantasma" tamano="pequeno" icono="papelera" onClick={() => setBorrando(true)}>
            Borrar
          </Boton>
        )}
      </div>
    </article>
  );
}

type Variable = { nombre: string; valor: string };

function FormularioMcp({ servidor, alGuardar, alCancelar }: { servidor?: InfoServidorMcp; alGuardar: (s: InfoServidorMcp) => void; alCancelar: () => void }) {
  const { llamar } = useAcciones();
  const [nombre, setNombre] = useState(servidor?.nombre ?? "");
  const [tipo, setTipo] = useState<InfoServidorMcp["tipo"]>(servidor?.tipo ?? "stdio");
  const [comando, setComando] = useState(servidor?.comando ?? "");
  const [argumentos, setArgumentos] = useState(unirArgumentos(servidor?.args ?? []));
  const [url, setUrl] = useState(servidor?.url ?? "");
  // El núcleo no devuelve los valores: al editar se ven los nombres y solo se mandan si se tocan.
  const [variables, setVariables] = useState<Variable[]>((servidor?.env ?? []).map((n) => ({ nombre: n, valor: "" })));
  const [variablesTocadas, setVariablesTocadas] = useState(!servidor);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string>();

  const nombreValido = NOMBRE_VALIDO.test(nombre);
  const sinValor = variablesTocadas ? variables.filter((v) => v.nombre.trim() && !v.valor).map((v) => v.nombre.trim()) : [];
  const listo = nombreValido && (tipo === "stdio" ? !!comando.trim() : !!url.trim()) && sinValor.length === 0 && !guardando;

  const cambiarVariable = (i: number, v: Partial<Variable>) => {
    setVariables((l) => l.map((x, j) => (j === i ? { ...x, ...v } : x)));
    setVariablesTocadas(true);
  };

  const guardar = async () => {
    setGuardando(true);
    try {
      const env = Object.fromEntries(variables.filter((v) => v.nombre.trim()).map((v) => [v.nombre.trim(), v.valor]));
      alGuardar(
        await llamar("mcp.guardar", {
          nombre,
          ...(tipo === "stdio" ? { comando: comando.trim(), args: partirArgumentos(argumentos) } : { url: url.trim() }),
          ...(variablesTocadas ? { env } : {}),
          activo: servidor?.activo ?? true,
        }),
      );
    } catch (e) {
      setError(mensaje(e));
      setGuardando(false);
    }
  };

  return (
    <form
      className="formulario-mcp"
      onSubmit={(e) => {
        e.preventDefault();
        if (listo) void guardar();
      }}
    >
      <Campo
        etiqueta="Nombre"
        mono
        spellCheck={false}
        readOnly={!!servidor}
        value={nombre}
        maxLength={40}
        error={nombre && !nombreValido ? "Minúsculas, cifras, - y _" : undefined}
        onChange={(e) => setNombre(e.target.value)}
      />
      <OpcionesChip
        leyenda="Tipo"
        opciones={[
          { valor: "stdio", texto: "Programa local" },
          { valor: "http", texto: "URL" },
        ]}
        valor={tipo}
        alCambiar={setTipo}
      />
      {tipo === "stdio" ? (
        <div className="ajustes__rejilla">
          <Campo etiqueta="Comando" mono spellCheck={false} value={comando} onChange={(e) => setComando(e.target.value)} />
          <Campo etiqueta="Argumentos" mono spellCheck={false} value={argumentos} onChange={(e) => setArgumentos(e.target.value)} />
        </div>
      ) : (
        <Campo etiqueta="URL" mono spellCheck={false} type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
      )}
      <div className="formulario-mcp__variables">
        <Etiqueta>Variables de entorno</Etiqueta>
        {variables.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: filas que se editan en el sitio; el nombre puede cambiar o repetirse mientras se escribe.
          <div key={i} className="formulario-mcp__variable">
            <input
              className="formulario-mcp__entrada formulario-mcp__entrada--nombre"
              aria-label="Nombre de la variable"
              spellCheck={false}
              value={v.nombre}
              onChange={(e) => cambiarVariable(i, { nombre: e.target.value })}
            />
            <input
              className="formulario-mcp__entrada"
              type="password"
              autoComplete="off"
              aria-label={`Valor de ${v.nombre || "la variable"}`}
              placeholder={servidor?.env?.includes(v.nombre) && !variablesTocadas ? "••••••••" : undefined}
              value={v.valor}
              onChange={(e) => cambiarVariable(i, { valor: e.target.value })}
            />
            <BotonIcono
              variante="pequeno"
              etiqueta="Quitar"
              icono="papelera"
              tamanoIcono={14}
              onClick={() => {
                setVariables((l) => l.filter((_, j) => j !== i));
                setVariablesTocadas(true);
              }}
            />
          </div>
        ))}
        <div>
          <Boton
            variante="fantasma"
            tamano="pequeno"
            icono="mas"
            onClick={() => {
              setVariables((l) => [...l, { nombre: "", valor: "" }]);
              setVariablesTocadas(true);
            }}
          >
            Variable
          </Boton>
        </div>
        {sinValor.length > 0 && <p className="ajustes__estado">Falta el valor de {sinValor.join(", ")}</p>}
      </div>
      {error && (
        <p className="ajustes__estado ajustes__estado--error" role="alert">
          {error}
        </p>
      )}
      <div className="formulario-mcp__botones">
        <Boton type="submit" variante="acento" disabled={!listo}>
          Guardar
        </Boton>
        <Boton variante="fantasma" onClick={alCancelar}>
          Cancelar
        </Boton>
      </div>
    </form>
  );
}
