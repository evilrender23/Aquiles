import { comprobar, fallar, funcion, igual, importar, lanza } from "../../comun";

await comprobar(async (dir) => {
  const m = await importar(dir, "src/versiones.ts");
  const valida = funcion(m, "esVersionValida");
  const comparar = funcion(m, "compararVersiones");
  const ordenar = funcion(m, "ordenarVersiones");

  const validas = [
    "0.0.0", "1.2.3", "v1.2.3", "10.20.30", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-0.3.7", "1.0.0-x.7.z.92",
    "1.0.0-x-y-z.--", "1.0.0+20130313144700", "1.0.0-beta+exp.sha.5114f85", "1.0.0+21AF26D3---117B344092BD",
    "1.0.0-rc.1+build.001", "2.0.0-0a", "1.1.2-prerelease+meta",
  ];
  const invalidas = [
    "", "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "1.2.3-", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+",
    "1.2.3-alpha_beta", "1.2.3+meta+meta", "v", "vv1.2.3", " 1.2.3", "1.2.3 ", "1.2.3-ñ", "a.b.c", "-1.2.3", "1.2.3+a..b",
  ];
  for (const v of validas) igual(valida(v), true, `esVersionValida(${JSON.stringify(v)})`);
  for (const v of invalidas) {
    let r: unknown;
    try {
      r = valida(v);
    } catch (e) {
      fallar(`esVersionValida(${JSON.stringify(v)}) lanza un error y debía devolver false`);
    }
    igual(r, false, `esVersionValida(${JSON.stringify(v)})`);
  }

  const casos: [string, string, number][] = [
    ["1.0.0", "2.0.0", -1], ["2.0.0", "2.1.0", -1], ["2.1.0", "2.1.1", -1], ["1.10.0", "1.9.0", 1],
    ["1.2.3", "1.2.3", 0], ["v1.2.3", "1.2.3", 0], ["1.2.3+a", "1.2.3+b", 0], ["1.0.0-rc.1+x", "1.0.0-rc.1", 0],
    ["1.0.0-alpha", "1.0.0", -1], ["1.0.0", "1.0.0-alpha", 1], ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1], ["1.0.0-beta.2", "1.0.0-beta.11", -1], ["1.0.0-beta.11", "1.0.0-rc.1", -1],
    ["1.0.0-Beta", "1.0.0-beta", -1], ["1.0.0-1", "1.0.0-a", -1], ["1.0.0-a", "1.0.0-1", 1], ["1.0.0-2", "1.0.0-10", -1],
    ["1.0.0-a.b.c", "1.0.0-a.b", 1], ["0.9.9", "0.10.0", -1], ["1.0.0-alpha-2", "1.0.0-alpha-10", 1],
  ];
  for (const [a, b, r] of casos) igual(comparar(a, b), r, `compararVersiones(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
  lanza(() => comparar("1.2", "1.2.3"), "compararVersiones con una versión no válida");
  lanza(() => comparar("1.2.3", "x"), "compararVersiones con una versión no válida");

  const lista = ["1.0.0", "1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-alpha", "1.0.0-beta.2", "1.0.0-alpha.1"];
  const copia = [...lista];
  igual(
    ordenar(lista),
    ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"],
    "ordenarVersiones del ejemplo",
  );
  igual(lista, copia, "ordenarVersiones no debe modificar la lista original");
  igual(
    ordenar(["2.0.0+b", "v1.0.0", "2.0.0", "1.0.0+z", "2.0.0+a", "0.1.0"]),
    ["0.1.0", "v1.0.0", "1.0.0+z", "2.0.0+b", "2.0.0", "2.0.0+a"],
    "ordenarVersiones mantiene el orden de las iguales",
  );
  igual(ordenar([]), [], "ordenarVersiones([])");
  lanza(() => ordenar(["1.0.0", "1.0"]), "ordenarVersiones con una versión no válida");
});
