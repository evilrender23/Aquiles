/**
 * BlurText (React Bits) para el texto que llega en streaming: cada token entra desenfocado
 * (blur 17px → 0 en 0,65 s) y un cursor lima marca el final mientras escribe.
 * React conserva los tokens ya montados, así que solo se animan los nuevos.
 */

const TOKENS = /\S+\s*|\s+/g;

export function trocearTokens(texto: string): string[] {
  return texto.match(TOKENS) ?? [];
}

export function BlurText({ texto, animar = true, cursor = false }: { texto: string; animar?: boolean; cursor?: boolean }) {
  return (
    <>
      {animar
        ? trocearTokens(texto).map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: clave por posición a propósito: el texto solo crece y así no se re-animan los tokens ya montados.
            <span key={i} className="nx-tok">
              {t}
            </span>
          ))
        : texto}
      {cursor && <span className="nx-caret" aria-hidden="true" />}
    </>
  );
}

/** Nodo hast mínimo (sin depender de @types/hast). */
interface NodoHast {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: NodoHast[];
}

const SIN_TOCAR = new Set(["code", "pre", "kbd", "samp"]);

/**
 * Plugin de rehype (react-markdown) que envuelve cada palabra en `span.nx-tok` y, con `cursor`,
 * añade el cursor tras el último token. No toca el código ni el espacio entre bloques.
 */
export function rehypeBlurText(opciones: { cursor?: boolean } = {}) {
  return (arbol: NodoHast) => {
    let ultimo: NodoHast | undefined;
    const recorrer = (nodo: NodoHast) => {
      if (!nodo.children) return;
      if (nodo.type === "element" && nodo.tagName && SIN_TOCAR.has(nodo.tagName)) {
        ultimo = nodo;
        return;
      }
      nodo.children = nodo.children.flatMap((hijo): NodoHast[] => {
        if (hijo.type === "text") {
          if (!hijo.value?.trim()) return [hijo];
          ultimo = nodo;
          return trocearTokens(hijo.value).map((t) => ({
            type: "element",
            tagName: "span",
            properties: { className: ["nx-tok"] },
            children: [{ type: "text", value: t }],
          }));
        }
        recorrer(hijo);
        return [hijo];
      });
    };
    recorrer(arbol);
    if (opciones.cursor && ultimo?.children) {
      ultimo.children.push({ type: "element", tagName: "span", properties: { className: ["nx-caret"], ariaHidden: "true" }, children: [] });
    }
  };
}
