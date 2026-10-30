import { asegurar, comprobar, fallar, ficheros, funcion, importar, importarInicial, leer, leerInicial } from "../../comun";

/** Líneas con código (sin vacías ni comentarios de línea completa). */
const lineasDeCodigo = (s: string) => s.split("\n").filter((l) => l.trim() && !/^\s*(\/\/|\/?\*)/.test(l)).length;

await comprobar(async (dir) => {
  const nuevo = await importar(dir, "src/informes.ts");
  const orig = await importarInicial("src/informes.ts");

  // Datos variados y deterministas.
  let semilla = 7;
  const azar = () => (semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648;
  const nombres = ["Ana", "Construcciones Martínez e Hijos", "Bar Pepe", "Distribuciones del Norte, S. L.", "Lía", "Exactamente20letras!"];
  const fecha = () => `2026-0${1 + Math.floor(azar() * 9)}-${String(1 + Math.floor(azar() * 28)).padStart(2, "0")}`;
  const lote = (n: number) =>
    Array.from({ length: n }, () => ({
      fecha: fecha(),
      nombre: nombres[Math.floor(azar() * nombres.length)]!,
      importe: Math.round(azar() * 200000) / 100,
    }));

  for (const n of [0, 1, 2, 7, 25]) {
    const base = lote(n);
    const ventas = base.map((b) => ({ fecha: b.fecha, cliente: b.nombre, importe: b.importe }));
    const compras = base.map((b, i) => ({ fecha: b.fecha, proveedor: b.nombre, importe: b.importe, iva: [0.21, 0.1, 0.04, 0][i % 4]! }));
    const devoluciones = base.map((b, i) => ({ fecha: b.fecha, cliente: b.nombre, importe: b.importe, motivo: ["roto", "talla", "no llegó"][i % 3]! }));
    const pares: [string, unknown[], string | undefined][] = [
      ["informeVentas", ventas, undefined],
      ["informeVentas", ventas, "ventas de marzo"],
      ["informeCompras", compras, undefined],
      ["informeCompras", compras, "proveedores"],
      ["informeDevoluciones", devoluciones, undefined],
      ["informeDevoluciones", devoluciones, "Devoluciones Q1"],
    ];
    for (const [nombre, datos, titulo] of pares) {
      const copia = structuredClone(datos);
      const esperado = titulo === undefined ? orig[nombre](datos) : orig[nombre](datos, titulo);
      const obtenido = titulo === undefined ? funcion(nuevo, nombre)(copia) : funcion(nuevo, nombre)(copia, titulo);
      if (obtenido !== esperado) {
        fallar(
          `${nombre} con ${n} movimientos${titulo ? ` y título ${JSON.stringify(titulo)}` : ""} ya no devuelve lo mismo.\n` +
            `Esperado:\n${esperado}\nObtenido:\n${obtenido}`,
        );
      }
      asegurar(Bun.deepEquals(copia, datos), `${nombre} no debe modificar los datos de entrada`);
    }
  }

  const fuentes = ficheros(dir).filter((f) => f.startsWith("src/") && f.endsWith(".ts"));
  const codigo = fuentes.map((f) => leer(dir, f)).join("\n");
  const cuenta = (re: RegExp) => (codigo.match(re) ?? []).length;
  const cabeceras = cuenta(/INFORME DE /g);
  const recortes = cuenta(/\.slice\(0,\s*19\)/g);
  const pies = cuenta(/"movimientos"|'movimientos'/g);
  if (cabeceras > 1 || recortes > 1 || pies > 1) {
    fallar(`sigue habiendo código duplicado (cabecera ×${cabeceras}, recorte del nombre ×${recortes}, pie ×${pies})`);
  }
  const antes = lineasDeCodigo(leerInicial("src/informes.ts"));
  const despues = lineasDeCodigo(codigo);
  if (despues > antes * 0.9) fallar(`el código apenas ha encogido: ${despues} líneas frente a ${antes}`);
});
