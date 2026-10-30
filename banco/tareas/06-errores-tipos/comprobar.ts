import { asegurar, BUN, buscar, comprobar, ejecutar, fallar, funcion, igual, importar, leer, leerInicial, resumir, TSC } from "../../comun";

await comprobar(async (dir) => {
  const trampas = buscar(dir, /@ts-(ignore|nocheck|expect-error)|\bas\s+any\b|:\s*any\b|<any>|\bany\[\]/, /\.tsx?$/);
  if (trampas.length) fallar(`se ha silenciado al compilador:\n${trampas.slice(0, 5).join("\n")}`);
  igual(JSON.parse(leer(dir, "tsconfig.json")), JSON.parse(leerInicial("tsconfig.json")), "tsconfig.json no debía cambiar");

  const tsc = ejecutar([BUN, TSC, "-p", dir], { cwd: dir, tiempoMs: 60_000 });
  if (tsc.codigo !== 0) fallar(`tsc da errores:\n${resumir(tsc.todo, 15)}`);

  const inv = await importar(dir, "src/inventario.ts");
  const { CATALOGO } = await importar(dir, "src/datos.ts");
  const informe = await importar(dir, "src/informe.ts");

  asegurar(Array.isArray(CATALOGO) && CATALOGO.length === 4, "el catálogo debe seguir teniendo 4 productos");
  for (const p of CATALOGO) asegurar(typeof p.precio === "number", `el precio de ${p.sku} no es un número`);
  igual(CATALOGO.map((p: { precio: number }) => p.precio), [0.5, 2.25, 24.9, 12], "precios del catálogo");

  igual(funcion(inv, "buscar")(CATALOGO, "C3")?.nombre, "Mochila", "buscar C3");
  igual(funcion(inv, "buscar")(CATALOGO, "Z9"), undefined, "buscar un SKU inexistente");
  igual(funcion(inv, "valorStock")(CATALOGO), 234, "valorStock del catálogo");
  igual(funcion(inv, "valorStock")([]), 0, "valorStock([])");
  igual(funcion(inv, "primeraEtiqueta")(CATALOGO[1]), "PAPELERÍA", "primeraEtiqueta del cuaderno");
  igual(funcion(inv, "primeraEtiqueta")(CATALOGO[2]), "", "primeraEtiqueta sin etiquetas");
  igual(funcion(inv, "primeraEtiqueta")({ ...CATALOGO[0], etiquetas: [] }), "", "primeraEtiqueta con etiquetas vacías");
  igual(
    funcion(inv, "agruparPorEtiqueta")(CATALOGO),
    { "papelería": ["A1", "B2"], oferta: ["B2"], "electrónica": ["D4"] },
    "agruparPorEtiqueta",
  );
  igual(funcion(inv, "aplicarRebaja")(CATALOGO[3], 25).precio, 9, "aplicarRebaja 25 %");
  igual(
    ["A1", "C3", "D4"].map((s) => funcion(inv, "estadoStock")(funcion(inv, "buscar")(CATALOGO, s))),
    ["ok", "agotado", "bajo"],
    "estadoStock",
  );
  igual(funcion(informe, "rebajasDeVerano")().map((p: { precio: number }) => p.precio), [0.5, 1.8, 24.9, 12], "rebajasDeVerano");
  igual(
    funcion(informe, "resumen")(),
    ["A1 Lápiz: ok", "B2 Cuaderno: ok", "C3 Mochila: agotado", "D4 Calculadora: bajo", "Valor total: 234.00"],
    "resumen",
  );
});
