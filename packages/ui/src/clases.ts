/** Une nombres de clase descartando los falsos. */
export function clases(...nombres: (string | false | null | undefined)[]): string {
  return nombres.filter(Boolean).join(" ");
}
