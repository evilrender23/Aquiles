import { copiarTexto, rehypeBlurText, useMenuContextual } from "@aquiles/ui";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

const PLUGINS_REMARK: Options["remarkPlugins"] = [remarkGfm];

// Sin HTML crudo (react-markdown no lo pinta sin rehype-raw). Los enlaces se abren fuera para no sacar a la app de su página.
const COMPONENTES: Components = {
  a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer noopener" />,
  pre: ({ node: _n, ...p }) => <BloqueCodigoMd {...p} />,
};

export function Markdown({ texto, animar = false, cursor = false, compacto = false }: { texto: string; animar?: boolean; cursor?: boolean; compacto?: boolean }) {
  const rehype = useMemo<Options["rehypePlugins"]>(() => (animar ? [[rehypeBlurText, { cursor }]] : []), [animar, cursor]);
  return (
    <div className={compacto ? "md md--compacto" : "md"}>
      <ReactMarkdown remarkPlugins={PLUGINS_REMARK} rehypePlugins={rehype} components={COMPONENTES}>
        {texto}
      </ReactMarkdown>
    </div>
  );
}

/** Respuesta del asistente: BlurText mientras llega y un poco después, para no cortar la animación de los últimos tokens. */
export function TextoAsistente({ texto, abierto }: { texto: string; abierto: boolean }) {
  const [animar, setAnimar] = useState(abierto);
  useEffect(() => {
    if (abierto) {
      setAnimar(true);
      return;
    }
    const t = setTimeout(() => setAnimar(false), 700);
    return () => clearTimeout(t);
  }, [abierto]);
  return <Markdown texto={texto} animar={animar} cursor={abierto} />;
}

/** Bloque de código de una respuesta: Copiar e Insertar en la caja (como bloque, con su lenguaje). */
function BloqueCodigoMd(props: ComponentProps<"pre">) {
  const pre = useRef<HTMLPreElement>(null);
  const { activa } = useEstado();
  const { insertarEnCaja } = useAcciones();
  const menu = useMenuContextual(({ seleccion }) => {
    const codigo = (pre.current?.textContent ?? "").replace(/\n$/, "");
    const lenguaje = pre.current?.querySelector("code")?.className.match(/language-(\S+)/)?.[1] ?? "";
    const valla = "```";
    return [
      { texto: "Copiar", icono: "copiar", atajo: seleccion ? "Ctrl+C" : undefined, alElegir: () => copiarTexto(seleccion || codigo) },
      activa && { texto: "Insertar en la caja", icono: "cita", alElegir: () => insertarEnCaja(valla + lenguaje + "\n" + (seleccion || codigo) + "\n" + valla) },
    ];
  });
  return <pre ref={pre} className="nx-codigo md__pre" {...props} {...menu} />;
}
