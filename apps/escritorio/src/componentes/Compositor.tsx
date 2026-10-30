import { Boton, BotonIcono, clases } from "@aquiles/ui";
import { useState, type ReactNode } from "react";

export interface PropsCompositor {
  etiqueta: string;
  placeholder: string;
  textoEnviar: string;
  filas?: number;
  deshabilitado?: boolean;
  /** Con turno en marcha y sin texto, el botón detiene. */
  trabajando?: boolean;
  alEnviar: (texto: string) => void | Promise<void>;
  alDetener?: () => void;
  izquierda?: ReactNode;
  derecha?: ReactNode;
  /** Dictado (voz.dictar): devuelve lo reconocido, que se añade a la caja. Sin él, no hay micrófono. */
  dictar?: () => Promise<string>;
}

/** Caja de texto: Enter envía, Mayús+Enter salta de línea. */
export function Compositor({ etiqueta, placeholder, textoEnviar, filas = 2, deshabilitado, trabajando, alEnviar, alDetener, izquierda, derecha, dictar }: PropsCompositor) {
  const [texto, setTexto] = useState("");
  const [escuchando, setEscuchando] = useState(false);
  const [errorVoz, setErrorVoz] = useState<string>();
  const limpio = texto.trim();

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

  const enviar = () => {
    if (!limpio || deshabilitado) return;
    setTexto("");
    void alEnviar(limpio);
  };

  return (
    <form
      className="compositor"
      onSubmit={(e) => {
        e.preventDefault();
        enviar();
      }}
    >
      <textarea
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
        {trabajando && !limpio && alDetener ? (
          <Boton variante="secundario" className="compositor__detener" icono="detener" onClick={alDetener}>
            Detener
          </Boton>
        ) : (
          <Boton type="submit" variante="principal" iconoFinal="flecha-diagonal" disabled={!limpio || deshabilitado}>
            {textoEnviar}
          </Boton>
        )}
      </div>
      {errorVoz && (
        <p className="compositor__error-voz" role="alert">
          {errorVoz}
        </p>
      )}
    </form>
  );
}
