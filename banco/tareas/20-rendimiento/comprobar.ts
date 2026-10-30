import { join } from "node:path";
import { BUN, comprobar, DIR_TAREA, fallar, funcion, igual, importar, importarInicial, resumir, ejecutar } from "../../comun";

const LIMITE_MS = 4000;

await comprobar(async (dir) => {
  // 1. Mismos resultados que la versión original en datos pequeños (con casos raros).
  const nuevo = await importar(dir, "src/contactos.ts");
  const orig = await importarInicial("src/contactos.ts");
  const dedup = funcion(nuevo, "deduplicar");
  const contar = funcion(nuevo, "contarPorDominio");

  let semilla = 99;
  const azar = (n: number) => {
    semilla = (semilla * 1103515245 + 12345) % 2147483648;
    return semilla % n;
  };
  const raros = ["sin-arroba", "", "  ", "a@b@c.es", "X@Y.ES", "x@y.es ", "@solo-dominio.es", "nadie@"];
  for (const n of [0, 1, 5, 50, 400]) {
    const lista = Array.from({ length: n }, (_, i) => ({
      nombre: `C${i}`,
      email: i % 9 === 0 ? raros[azar(raros.length)]! : `${azar(3) ? "u" : "U"}${azar(40)}@${["a.es", "B.es", "c.com", "d.org"][azar(4)]}${azar(5) ? "" : " "}`,
      ...(i % 4 ? {} : { telefono: `6${azar(1e8)}` }),
    }));
    const copia = structuredClone(lista);
    igual(dedup(copia), orig.deduplicar(lista), `deduplicar con ${n} contactos`);
    igual(contar(copia), orig.contarPorDominio(lista), `contarPorDominio con ${n} contactos`);
    igual(copia, lista, "no se deben modificar los contactos de entrada");
  }
  const mismos = dedup([{ nombre: "a", email: "A@x.es" }, { nombre: "b", email: " a@X.es" }]);
  igual(mismos.map((c: { nombre: string }) => c.nombre), ["a"], "deduplicar se queda con la primera aparición");

  // 2. Rendimiento con 200.000 contactos, en un proceso aparte por si se cuelga.
  const r = ejecutar([BUN, join(DIR_TAREA, "carga.ts"), dir], { cwd: DIR_TAREA, tiempoMs: LIMITE_MS });
  if (r.agotado) fallar(`con 200.000 contactos no termina en ${LIMITE_MS / 1000} s`);
  if (r.codigo !== 0) fallar(`la prueba de carga falla:\n${resumir(r.todo)}`);
  const datos = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  igual(
    [datos.unicos, datos.dominios, datos.total],
    [datos.esperadoUnicos, datos.esperadoDominios, 200_000],
    "resultados de la prueba de carga (únicos, dominios, total)",
  );
});
