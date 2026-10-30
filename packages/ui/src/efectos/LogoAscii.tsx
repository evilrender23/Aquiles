import type { CSSProperties } from "react";

/** Logo de Aquiles: arte ASCII en cian y gris (12 filas, Courier New) aportado por el usuario, copiado tal cual del lienzo. */
const TONO: Record<string, CSSProperties> = {
  G: { color: "#AAAAAA" },
  W: { color: "#FFFFFF" },
  WG: { color: "#FFFFFF", background: "#AAAAAA" },
  C: { color: "#55FFFF" },
  CG: { color: "#55FFFF", background: "#AAAAAA" },
  GT: { color: "#AAAAAA", background: "#00AAAA" },
  T: { color: "#00AAAA" },
  DT: { color: "#555555", background: "#00AAAA" },
  D: { color: "#555555" },
};

type Tramo = [keyof typeof TONO, string];
const sp = (n: number): Tramo => ["G", " ".repeat(n)];

const ARTE: Tramo[][] = [
  [sp(21), ["W", "▄"], sp(16)],
  [sp(19), ["W", "▄"], sp(1), ["WG", "▓▓"], sp(15)],
  [sp(18), ["WG", "▓▓"], sp(1), ["WG", "▒▒"], sp(15)],
  [sp(7), ["C", "▄▀"], ["CG", "▓▓"], ["G", "        ▀ "], ["C", "██"], sp(15)],
  [sp(1), ["C", "▄▀"], ["CG", "▓▓"], sp(1), ["CG", "▒▒"], sp(1), ["CG", "▒▒"], sp(1), ["CG", "▓"], ["C", "▄"], sp(1), ["C", "▄"], sp(2), ["C", "▄"], sp(2), ["CG", "▓▓"], sp(5), ["C", "▄▀"], ["CG", "▓▓"], sp(2), ["C", "▄▀"], ["CG", "▓▓"]],
  [["CG", "▒▒"], sp(1), ["CG", "▒▒"], sp(1), ["CG", "░░"], sp(1), ["CG", "░░"], sp(1), ["CG", "▒▒"], sp(1), ["CG", "▒▒"], sp(1), ["CG", "▒▓"], sp(1), ["CG", "▒▒"], sp(4), ["CG", "▒▒"], sp(1), ["CG", "▒▒"], sp(1), ["CG", "▒▒"], sp(1), ["CG", "▒▒"]],
  [["CG", "░░"], sp(1), ["CG", "░░"], ["G", " ██ ██ "], ["CG", "░░"], sp(1), ["CG", "░░"], sp(1), ["CG", "░▒"], sp(1), ["CG", "░░"], sp(4), ["CG", "░░"], sp(1), ["CG", "░"], ["G", "▀ "], ["CG", "░░"], sp(1), ["CG", "░"], ["G", "▀"]],
  [["G", "██ ██ "], ["GT", "▓▓"], sp(1), ["GT", "▓▓"], ["G", " ██ ██ "], ["GT", "▓▓"], ["G", " ██ █▄ ██▀   ▀█▄▄ "]],
  [["GT", "▓▓"], sp(1), ["GT", "▓▓"], sp(1), ["GT", "▒▒"], sp(1), ["GT", "▒▒"], sp(1), ["GT", "▓▓"], sp(1), ["GT", "▓▓"], sp(1), ["GT", "▒▒"], sp(1), ["GT", "▓▓"], sp(1), ["GT", "▓▓"], sp(1), ["GT", "▓▓"], sp(1), ["GT", "▓"], ["G", "▄  ▄ "], ["GT", "▓"], ["G", "█"]],
  [["GT", "▒▒"], sp(1), ["GT", "▒▒"], sp(1), ["T", "▀"], ["GT", "░"], ["T", "▄"], ["GT", "░░"], sp(1), ["GT", "▒▒"], sp(1), ["GT", "▒▒"], sp(1), ["GT", "░░"], sp(1), ["GT", "▒▒"], sp(1), ["GT", "▒▒"], sp(1), ["GT", "▒▒"], sp(1), ["GT", "▒▒"], sp(1), ["GT", "▒▒"], sp(1), ["GT", "▒▒"]],
  [["T", "▀"], ["GT", "░"], ["T", "▄"], ["GT", "░░"], sp(4), ["DT", "░░"], sp(1), ["T", "▀"], ["GT", "░"], ["T", "▄"], ["GT", "░"], ["T", "▀"], sp(1), ["T", "▀█"], sp(1), ["T", "▀"], ["GT", "░"], ["T", "▄"], ["GT", "░░"], sp(1), ["T", "▀"], ["GT", "░"], ["T", "▄"], ["GT", "░░"], sp(1), ["T", "▀"], ["GT", "░"], ["T", "▄"], ["GT", "░░"]],
  [sp(9), ["D", "▀"], ["DT", "▒"], sp(27)],
];

export function LogoAscii({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={className ? `nx-logo ${className}` : "nx-logo"}>
      <div className="nx-logo__arte">
        {ARTE.map((fila, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: arte fijo, nunca cambia de orden.
          <div key={i}>
            {fila.map(([tono, texto], j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: arte fijo, nunca cambia de orden.
              <span key={j} style={TONO[tono]}>
                {texto}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
