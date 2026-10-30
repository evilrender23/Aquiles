import { asegurar, bunTest, BUN, buscar, comprobar, ejecutar, fallar, funcion, igual, importar, resumir } from "../../comun";

const SALIDA_ESPERADA = [
  "Base: 984.69 · IVA: 193.89 · Total: 1178.58",
  "  general (21 %): 189.00",
  "  superreducido (4 %): 2.39",
  "  reducido (10 %): 2.50",
  "IVA de 100 € al tipo general: 21.00",
].join("\n");

await comprobar(async (dir) => {
  const restos = buscar(dir, /\bcalcImp\b/);
  if (restos.length) fallar(`sigue apareciendo calcImp:\n${restos.slice(0, 8).join("\n")}`);

  const impuestos = await importar(dir, "src/impuestos.ts");
  const calcular = funcion(impuestos, "calcularImpuesto");
  igual(calcular(100), 21, "calcularImpuesto(100)");
  igual(calcular(50, "superreducido"), 2, "calcularImpuesto(50, 'superreducido')");

  const indice = await importar(dir, "src/index.ts");
  asegurar(typeof indice.calcularImpuesto === "function", "src/index.ts no exporta calcularImpuesto");
  asegurar(!("calcImp" in indice), "src/index.ts sigue exportando calcImp");
  // calcImporteLinea es otra función: no se renombra.
  igual(funcion(indice, "calcImporteLinea")(2.5, 3), 7.5, "calcImporteLinea sigue existiendo");
  asegurar(buscar(dir, /calcularImpuestoorteLinea|calcularImpuesto\w/).length === 0, "se han renombrado nombres que no eran calcImp");
  asegurar(buscar(dir, /calcularImpuesto/, /README\.md$/).length > 0, "el README no habla de calcularImpuesto");

  const demo = ejecutar([BUN, "src/main.ts"], { cwd: dir });
  if (demo.codigo !== 0) fallar(`bun src/main.ts falla:\n${resumir(demo.todo)}`);
  igual(demo.stdout.trim(), SALIDA_ESPERADA, "salida de bun src/main.ts");

  const t = bunTest(dir);
  if (t.codigo !== 0 || t.aprobados < 3) fallar(`bun test no pasa:\n${resumir(t.todo)}`);
});
