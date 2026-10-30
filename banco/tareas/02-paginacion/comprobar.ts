import { comprobar, funcion, igual, importar } from "../../comun";

await comprobar(async (dir) => {
  const paginar = funcion(await importar(dir, "src/paginar.ts"), "paginar");
  const n = (k: number) => Array.from({ length: k }, (_, i) => i + 1);
  const rango = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const pag = (elementos: number[], pagina: number, totalPaginas: number, hayAnterior: boolean, haySiguiente: boolean) => ({
    elementos, pagina, totalPaginas, hayAnterior, haySiguiente,
  });

  igual(paginar(n(25), 1, 10), pag(rango(1, 10), 1, 3, false, true), "25 elementos, página 1");
  igual(paginar(n(25), 2, 10), pag(rango(11, 20), 2, 3, true, true), "25 elementos, página 2");
  igual(paginar(n(25), 3, 10), pag(rango(21, 25), 3, 3, true, false), "25 elementos, página 3 (incompleta)");
  igual(paginar(n(20), 2, 10), pag(rango(11, 20), 2, 2, true, false), "20 elementos, última página exacta");
  igual(paginar(n(20), 3, 10), pag(rango(11, 20), 2, 2, true, false), "página fuera de rango por arriba");
  igual(paginar(n(5), 0, 10), pag(rango(1, 5), 1, 1, false, false), "página 0");
  igual(paginar(n(5), -3, 2), pag([1, 2], 1, 3, false, true), "página negativa");
  igual(paginar([], 1, 10), pag([], 1, 1, false, false), "lista vacía");
  igual(paginar(n(3), 2, 1), pag([2], 2, 3, true, true), "un elemento por página");
  igual(paginar(n(12), 2), pag([11, 12], 2, 2, true, false), "porPagina por defecto");
});
