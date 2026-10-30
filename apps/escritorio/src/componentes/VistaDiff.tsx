import type { Diff } from "@aquiles/protocolo";
import { clases } from "@aquiles/ui";

/** Fila de resumen de un fichero cambiado, como la lista de ediciones del lienzo: A/M, ruta, +n, −n. */
export function FilaDiff({ diff }: { diff: Diff }) {
  return (
    <div className="diff__fila">
      <span className="diff__tipo" title={diff.nuevo ? "Nuevo" : "Modificado"}>
        {diff.nuevo ? "A" : "M"}
      </span>
      <span className="diff__ruta" title={diff.ruta}>
        {diff.ruta}
      </span>
      <span className="diff__mas">+{diff.anadidas}</span>
      <span className="diff__menos">−{diff.quitadas}</span>
    </div>
  );
}

/** Bloques del diff con números de línea antes / después. */
export function BloquesDiff({ diff }: { diff: Diff }) {
  return (
    <div className="diff__bloques">
      {diff.bloques.map((b, i) => {
        let antes = b.lineaAntes;
        let despues = b.lineaDespues;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: el diff llega entero y no cambia.
          <div key={i} className="diff__bloque">
            {i > 0 && <div className="diff__salto" aria-hidden="true">⋯</div>}
            {b.lineas.map((l, j) => {
              const nAntes = l.tipo === "+" ? "" : antes++;
              const nDespues = l.tipo === "-" ? "" : despues++;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: el diff llega entero y no cambia.
                <div key={j} className={clases("diff__linea", l.tipo === "+" && "diff__linea--mas", l.tipo === "-" && "diff__linea--menos")}>
                  <span className="diff__num" aria-hidden="true">
                    {nAntes}
                  </span>
                  <span className="diff__num" aria-hidden="true">
                    {nDespues}
                  </span>
                  <span className="diff__signo">
                    <span aria-hidden="true">{l.tipo === "-" ? "−" : l.tipo === "+" ? "+" : ""}</span>
                    {l.tipo !== " " && <span className="nx-sr">{l.tipo === "+" ? "añadida:" : "quitada:"}</span>}
                  </span>
                  <span className="diff__texto">{l.texto}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {diff.truncado && <div className="diff__salto">Recortado</div>}
    </div>
  );
}
