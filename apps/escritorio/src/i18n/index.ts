/**
 * Traducciones de la app (la base está en @aquiles/ui: t, fijarIdioma). El español es el de por defecto y no
 * necesita catálogo; el inglés va por partes en en/*.ts, cada una con las frases de sus componentes.
 * El idioma sale de los ajustes del perfil; se recuerda en este navegador para no pintar el primer instante en otro.
 */
import { fijarIdioma, type Idioma, registrarTraducciones } from "@aquiles/ui";
import { ajustes } from "./en/ajustes";
import { base } from "./en/base";
import { conversacion } from "./en/conversacion";
import { vistas } from "./en/vistas";

const CLAVE = "aquiles-idioma";

for (const parte of [base, conversacion, ajustes, vistas]) registrarTraducciones("en", parte);

/** El último idioma usado en este navegador (o español). */
export function idiomaGuardado(): Idioma {
  try {
    return localStorage.getItem(CLAVE) === "en" ? "en" : "es";
  } catch {
    return "es";
  }
}

export function aplicarIdioma(idioma: Idioma): void {
  fijarIdioma(idioma);
  try {
    localStorage.setItem(CLAVE, idioma);
  } catch {
    // sin almacenamiento: se queda en el de los ajustes
  }
}

aplicarIdioma(idiomaGuardado());
