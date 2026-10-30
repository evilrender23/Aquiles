import { rehypeBlurText } from "@aquiles/ui";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

const PLUGINS_REMARK: Options["remarkPlugins"] = [remarkGfm];

// Sin HTML crudo (react-markdown no lo pinta sin rehype-raw). Los enlaces se abren fuera para no sacar a la app de su página.
const COMPONENTES: Components = {
  a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer noopener" />,
  pre: ({ node: _n, ...p }) => <pre className="nx-codigo md__pre" {...p} />,
};

export function Markdown({ texto, animar = false, cursor = false }: { texto: string; animar?: boolean; cursor?: boolean }) {
  const rehype = useMemo<Options["rehypePlugins"]>(() => (animar ? [[rehypeBlurText, { cursor }]] : []), [animar, cursor]);
  return (
    <div className="md">
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
