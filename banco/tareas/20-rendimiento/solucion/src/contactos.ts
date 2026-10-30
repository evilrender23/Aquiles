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
  const vistos = new Set<string>();
  const resultado: Contacto[] = [];
  for (const c of contactos) {
    const clave = claveEmail(c.email);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    resultado.push(c);
  }
  return resultado;
}

/**
 * Cuántos contactos hay de cada dominio de email (en minúsculas), de más a menos;
 * los empates, por orden alfabético del dominio. Los emails sin @ cuentan con dominio "".
 */
export function contarPorDominio(contactos: Contacto[]): [string, number][] {
  const cuenta = new Map<string, number>();
  for (const c of contactos) {
    const dominio = claveEmail(c.email).split("@")[1] ?? "";
    cuenta.set(dominio, (cuenta.get(dominio) ?? 0) + 1);
  }
  return [...cuenta].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
