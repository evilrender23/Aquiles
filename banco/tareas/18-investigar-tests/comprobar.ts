import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { borrar, bunTest, carpetaTemporal, comprobar, fallar, funcion, igual, importar, leer, leerInicial, resumir, sinCambios } from "../../comun";

await comprobar(async (dir) => {
  sinCambios(dir, "test/catalogo.test.ts");
  igual(JSON.parse(leer(dir, "datos/catalogo.json")), JSON.parse(leerInicial("datos/catalogo.json")), "datos/catalogo.json no debía cambiar");

  const t = bunTest(dir);
  if (t.codigo !== 0 || t.fallidos > 0 || t.aprobados < 4) fallar(`bun test no pasa:\n${resumir(t.todo)}`);

  // Otra exportación en el mismo formato, para que no valga ajustar el código a los datos de ejemplo.
  const m = await importar(dir, "src/catalogo.ts");
  const tmp = carpetaTemporal("aquiles-banco-catalogo-");
  try {
    const ruta = join(tmp, "otro.json");
    writeFileSync(
      ruta,
      JSON.stringify({
        exportado: "2026-10-20T08:00:00Z",
        origen: "ERP v7",
        version_formato: 2,
        productos: [
          { sku: "A", nombre: "Uno", precio_centimos: 1999, categorias: "x|y", activo: "sí" },
          { sku: "B", nombre: "Dos", precio_centimos: 5, categorias: "y", activo: "no" },
          { sku: "C", nombre: "Tres", precio_centimos: 100001, categorias: "z|x|w", activo: "sí" },
        ],
      }),
    );
    const cat = funcion(m, "cargarCatalogo")(ruta);
    igual(
      cat,
      [
        { sku: "A", nombre: "Uno", precio: 19.99, categorias: ["x", "y"], activo: true },
        { sku: "B", nombre: "Dos", precio: 0.05, categorias: ["y"], activo: false },
        { sku: "C", nombre: "Tres", precio: 1000.01, categorias: ["z", "x", "w"], activo: true },
      ],
      "cargarCatalogo con otra exportación",
    );
    igual(funcion(m, "precioMedio")(cat, "x"), 510, "precioMedio de otra exportación");
    igual(funcion(m, "precioMedio")(cat, "y"), 19.99, "precioMedio sin contar inactivos");
    igual(funcion(m, "masCaros")(cat, 5).map((p: { sku: string }) => p.sku), ["C", "A"], "masCaros de otra exportación");
  } finally {
    borrar(tmp);
  }
});
