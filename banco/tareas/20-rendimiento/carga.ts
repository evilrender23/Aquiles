/**
 * Prueba de carga de la tarea 20: se ejecuta en un proceso aparte (con límite de tiempo)
 * desde comprobar.ts. Uso: bun carga.ts <carpeta de trabajo>
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2]!;
const m = await import(pathToFileURL(join(dir, "src/contactos.ts")).href);

let semilla = 12345;
const azar = (n: number) => {
  semilla = (semilla * 1103515245 + 12345) % 2147483648;
  return semilla % n;
};
const N = 200_000;
const ids = new Set<number>();
const contactos = Array.from({ length: N }, (_, i) => {
  const id = azar(80_000);
  ids.add(id);
  const email = `usuario${id}@empresa${id % 25_000}.es`;
  return { nombre: `Contacto ${i}`, email: i % 7 === 0 ? `  ${email.toUpperCase()} ` : email };
});
const dominios = new Set([...ids].map((id) => id % 25_000));

const t0 = performance.now();
const unicos = m.deduplicar(contactos);
const t1 = performance.now();
const cuenta = m.contarPorDominio(contactos);
const t2 = performance.now();
console.log(
  JSON.stringify({
    unicos: unicos.length,
    esperadoUnicos: ids.size,
    dominios: cuenta.length,
    esperadoDominios: dominios.size,
    total: cuenta.reduce((s: number, [, n]: [string, number]) => s + n, 0),
    msDeduplicar: Math.round(t1 - t0),
    msContar: Math.round(t2 - t1),
  }),
);
