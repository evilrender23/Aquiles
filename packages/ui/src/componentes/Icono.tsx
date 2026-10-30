import type { SVGProps } from "react";

/** Iconos de trazo de 2px con extremos redondeados, en currentColor (README de NOX: «Iconografía»). */
const TRAZOS = {
  mas: <path d="M12 5v14M5 12h14" />,
  menos: <path d="M5 12h14" />,
  maximizar: <rect x="4" y="4" width="16" height="16" rx="2" />,
  restaurar: (
    <>
      <rect x="4" y="8" width="12" height="12" rx="2" />
      <path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2" />
    </>
  ),
  cerrar: <path d="M18 6 6 18M6 6l12 12" />,
  "chevron-derecha": <path d="m9 6 6 6-6 6" />,
  "chevron-abajo": <path d="m6 9 6 6 6-6" />,
  "flecha-diagonal": (
    <>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </>
  ),
  terminal: (
    <>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </>
  ),
  fichero: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  lapiz: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  papelera: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m19 6-1 14H6L5 6" />
    </>
  ),
  buscar: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  carpeta: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  check: <path d="M5 12.5 10 17l9-10" />,
  alerta: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </>
  ),
  herramienta: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />,
  recargar: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  reloj: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z" />,
  microfono: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  altavoz: (
    <>
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </>
  ),
  enviar: <path d="M5 12h14M13 6l6 6-6 6" />,
  pausa: <path d="M9 6v12M15 6v12" />,
  columnas: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </>
  ),
  diana: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  circulo: <circle cx="12" cy="12" r="7" />,
} as const;

export type NombreIcono = keyof typeof TRAZOS | "detener";

export interface PropsIcono extends Omit<SVGProps<SVGSVGElement>, "name"> {
  nombre: NombreIcono;
  tamano?: number;
  grosor?: number;
}

export function Icono({ nombre, tamano = 16, grosor = 2, ...resto }: PropsIcono) {
  if (nombre === "detener") {
    return (
      <svg aria-hidden="true" width={tamano} height={tamano} viewBox="0 0 24 24" fill="currentColor" {...resto}>
        <rect x="5" y="5" width="14" height="14" rx="2" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      width={tamano}
      height={tamano}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={grosor}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...resto}
    >
      {TRAZOS[nombre]}
    </svg>
  );
}
