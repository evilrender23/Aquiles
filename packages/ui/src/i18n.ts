/**
 * Idioma de la interfaz. El español es el de siempre y el de por defecto: los textos se escriben en español en el
 * código y esa misma frase es la clave de su traducción (`t("Nueva sesión")`). Sin traducción, se ve en español.
 * Los huecos van entre llaves: `t("{n} ficheros", { n })`.
 */
export const IDIOMAS = ["es", "en"] as const;
export type Idioma = (typeof IDIOMAS)[number];

let actual: Idioma = "es";
const traducciones: Record<Exclude<Idioma, "es">, Map<string, string>> = { en: new Map() };

/** Añade traducciones (español → otro idioma); las de cada parte de la app van en su fichero. */
export function registrarTraducciones(idioma: Exclude<Idioma, "es">, mapa: Readonly<Record<string, string>>): void {
  for (const [es, otro] of Object.entries(mapa)) traducciones[idioma].set(es, otro);
}

export function fijarIdioma(idioma: Idioma): void {
  actual = idioma;
  if (typeof document !== "undefined") document.documentElement.lang = idioma;
}

export const idiomaActual = (): Idioma => actual;

/** ¿Hay traducción de esta frase? (para el test de cobertura). */
export const traducido = (idioma: Exclude<Idioma, "es">, es: string): boolean => traducciones[idioma].has(es);

export function t(es: string, valores?: Readonly<Record<string, string | number>>): string {
  const texto = actual === "es" ? es : (traducciones[actual].get(es) ?? es);
  return valores ? texto.replace(/\{(\w+)\}/g, (hueco, k: string) => (k in valores ? String(valores[k]) : hueco)) : texto;
}
