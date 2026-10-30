import { Boton, BotonIcono, clases, elementosCampoTexto, useMenuContextual } from "@aquiles/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AdjuntoPendiente } from "../estado/adjuntos";
import { BotonAdjuntar, ChipsAdjuntos, ZonaSoltar, useAdjuntos } from "./Adjuntos";

export interface PropsCompositor {
  etiqueta: string;
  placeholder: string;
  textoEnviar: string;
  filas?: number;
  deshabilitado?: boolean;
  /** Con turno en marcha y sin texto, el botón detiene. */
  trabajando?: boolean;
  /** Devolver `false` = no se envió (p. ej. la sesión no se pudo crear): el texto y los adjuntos vuelven a la caja. */
  alEnviar: (texto: string, adjuntos: AdjuntoPendiente[]) => unknown;
  /** Con un turno en marcha (o una pregunta pendiente) los adjuntos esperan: no van con el steer. */
  adjuntosPermitidos?: boolean;
  alDetener?: () => void;
  izquierda?: ReactNode;
  derecha?: ReactNode;
  /** Dictado (voz.dictar): devuelve lo reconocido, que se añade a la caja. Sin él, no hay micrófono. */
  dictar?: () => Promise<string>;
  /** Texto que llega de fuera (citar un mensaje, insertar un bloque de código): se añade al final. */
  insercion?: { texto: string; n: number };
}

/** Última inserción atendida: fuera del componente, porque la caja puede montarse con el pedido ya hecho. */
let ultimaInsercion = 0;

/** Caja de texto: Enter envía, Mayús+Enter salta de línea. */
export function Compositor({
  etiqueta,
  placeholder,
  textoEnviar,
  filas = 2,
  deshabilitado,
  trabajando,
  alEnviar,
  alDetener,
  izquierda,
  derecha,
  dictar,
  insercion,
  adjuntosPermitidos = true,
}: PropsCompositor) {
  const [texto, setTexto] = useState("");
  const adj = useAdjuntos();
  const caja = useRef<HTMLTextAreaElement>(null);

  // Cada inserción nueva (su `n`) se añade una vez, separada de lo que ya hubiera, y el cursor queda al final.
  useEffect(() => {
    if (!insercion || insercion.n <= ultimaInsercion) return;
    ultimaInsercion = insercion.n;
    setTexto((t) => (t.trim() ? `${t.replace(/\s+$/, "")}\n\n${insercion.texto}` : insercion.texto));
    requestAnimationFrame(() => {
      const c = caja.current;
      if (!c) return;
      c.focus();
      c.setSelectionRange(c.value.length, c.value.length);
    });
  }, [insercion]);
  const [escuchando, setEscuchando] = useState(false);
  const [errorVoz, setErrorVoz] = useState<string>();
  const limpio = texto.trim();

  // Menú de la caja: el de los campos de texto y, si hay voz, Dictar.
  const menu = useMenuContextual(
    async () => {
      const c = caja.current;
      if (!c) return [];
      return [...(await elementosCampoTexto(c)), dictar && { tipo: "separador" as const }, dictar && { texto: "Dictar", icono: "microfono" as const, deshabilitado: escuchando || deshabilitado, alElegir: () => void escuchar() }];
    },
    { campos: true },
  );

  const escuchar = async () => {
    if (!dictar || escuchando) return;
    setEscuchando(true);
    setErrorVoz(undefined);
    try {
      const oido = (await dictar()).trim();
      if (oido) setTexto((t) => (t.trim() ? `${t.replace(/\s+$/, "")} ${oido}` : oido));
    } catch (e) {
      setErrorVoz(e instanceof Error ? e.message : String(e));
    } finally {
      setEscuchando(false);
    }
  };

  const hayAlgo = !!limpio || adj.adjuntos.length > 0;
  const enviar = () => {
    if (!hayAlgo || deshabilitado) return;
    if (adj.adjuntos.length && !adjuntosPermitidos) {
      adj.setError("Los adjuntos se envían cuando acabe el turno");
      return;
    }
    const adjuntos = adj.adjuntos;
    const original = texto;
    setTexto("");
    adj.vaciar();
    void Promise.resolve(alEnviar(limpio, adjuntos)).then((enviado) => {
      if (enviado !== false) return;
      // Sin pisar lo que se haya escrito o adjuntado mientras tanto.
      setTexto((t) => t || original);
      adj.restaurar(adjuntos);
    });
  };

  return (
    <form
      className="compositor"
      onSubmit={(e) => {
        e.preventDefault();
        enviar();
      }}
    >
      <ZonaSoltar visible={adj.arrastrando && !deshabilitado} />
      <ChipsAdjuntos adjuntos={adj.adjuntos} alQuitar={adj.quitar} />
      <textarea
        ref={caja}
        {...menu}
        onPaste={adj.pegar}
        className="compositor__texto"
        aria-label={etiqueta}
        placeholder={placeholder}
        rows={filas}
        value={texto}
        disabled={deshabilitado}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            enviar();
          }
        }}
      />
      <div className="compositor__barra">
        <BotonAdjuntar alRutas={adj.anadirRutas} alFicheros={(f) => void adj.anadirFicheros(f)} deshabilitado={deshabilitado} />
        {dictar && (
          <BotonIcono
            etiqueta={escuchando ? "Escuchando" : "Dictar"}
            icono="microfono"
            className={clases("compositor__microfono", escuchando && "compositor__microfono--escuchando")}
            aria-pressed={escuchando}
            disabled={deshabilitado}
            onClick={() => void escuchar()}
          />
        )}
        {izquierda}
        <div className="compositor__hueco" />
        {derecha}
        {trabajando && !hayAlgo && alDetener ? (
          <Boton variante="secundario" className="compositor__detener" icono="detener" onClick={alDetener}>
            Detener
          </Boton>
        ) : (
          <Boton type="submit" variante="principal" iconoFinal="flecha-diagonal" disabled={!hayAlgo || deshabilitado}>
            {textoEnviar}
          </Boton>
        )}
      </div>
      {(errorVoz || adj.error) && (
        <p className="compositor__error-voz" role="alert">
          {[adj.error, errorVoz].filter(Boolean).join(" · ")}
        </p>
      )}
    </form>
  );
}
