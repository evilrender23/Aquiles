export interface Contacto {
  nombre: string;
  email: string;
  telefono?: string;
}

function claveEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Quita los contactos repetidos: dos contactos son el mismo si tienen el mismo email, sin
 * distinguir mayúsculas ni espacios alrededor. Se queda la primera aparición, en el orden original.
 */
export function deduplicar(contactos: Contacto[]): Contacto[] {
  const resultado: Contacto[] = [];
  for (const c of contactos) {
    if (!resultado.some((r) => claveEmail(r.email) === claveEmail(c.email))) resultado.push(c);
  }
  return resultado;
}

/**
 * Cuántos contactos hay de cada dominio de email (en minúsculas), de más a menos;
 * los empates, por orden alfabético del dominio. Los emails sin @ cuentan con dominio "".
 */
export function contarPorDominio(contactos: Contacto[]): [string, number][] {
  const dominios = contactos.map((c) => claveEmail(c.email).split("@")[1] ?? "");
  const unicos = dominios.filter((d, i) => dominios.indexOf(d) === i);
  return unicos
    .map((d): [string, number] => [d, dominios.filter((x) => x === d).length])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
