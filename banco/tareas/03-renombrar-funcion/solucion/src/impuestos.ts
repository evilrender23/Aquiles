/** Tipos de IVA vigentes. */
export const TIPOS_IVA = { general: 0.21, reducido: 0.1, superreducido: 0.04 } as const;

export type TipoIva = keyof typeof TIPOS_IVA;

/** Cuota de IVA de una base imponible, redondeada a céntimos. */
export function calcularImpuesto(base: number, tipo: TipoIva = "general"): number {
  return Math.round(base * TIPOS_IVA[tipo] * 100) / 100;
}
