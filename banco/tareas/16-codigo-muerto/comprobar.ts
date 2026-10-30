import { asegurar, bunTest, buscar, comprobar, existe, fallar, ficheros, igual, importar, importarInicial, resumir, sinCambios } from "../../comun";

const MUERTOS = [
  "UMBRAL_ANTIGUO",
  "invertirCadena",
  "rellenarIzquierda",
  "DEPURAR",
  "precioAntiguo",
  "codigoAntiguo",
  "exportarXml",
  "descuento aplicado",
];

await comprobar(async (dir) => {
  const nuevo = await importar(dir, "src/index.ts");
  const orig = await importarInicial("src/index.ts");
  igual(Object.keys(nuevo).sort(), Object.keys(orig).sort(), "exportaciones de src/index.ts");

  const pedidos = [
    { cliente: "luis pérez", fecha: "2026-12-24", base: 10, descuento: 50 },
    { cliente: "  MARÍA   del mar ", fecha: "2026-01-01", base: 99.99 },
    { cliente: "x", fecha: "2025-07-15", base: 0, descuento: 0 },
  ];
  for (const p of pedidos) igual(nuevo.resumenPedido(p), orig.resumenPedido(p), `resumenPedido(${JSON.stringify(p)})`);
  for (const f of ["2026-03-07", "1999-12-31"]) igual(nuevo.formatearFecha(f), orig.formatearFecha(f), `formatearFecha(${f})`);
  for (const t of ["hola", "  ÁLVARO  de la  fuente"]) igual(nuevo.capitalizar(t), orig.capitalizar(t), `capitalizar(${JSON.stringify(t)})`);
  for (const b of [0, 1, 19.99, 1234.5]) igual(nuevo.precioConIva(b), orig.precioConIva(b), `precioConIva(${b})`);
  for (const [p, d] of [[100, 10], [50, 150], [80, -5], [33.33, 33]] as const) {
    igual(nuevo.aplicarDescuento(p, d), orig.aplicarDescuento(p, d), `aplicarDescuento(${p}, ${d})`);
  }

  const fuentes = ficheros(dir).filter((f) => f.startsWith("src/"));
  asegurar(!existe(dir, "src/legacy/exportador.ts"), "sigue existiendo src/legacy/exportador.ts, que no se usa");
  const vivos = MUERTOS.flatMap((nombre) => buscar(dir, new RegExp(`\\b${nombre}\\b`)).filter((l) => l.startsWith("src/")));
  if (vivos.length) fallar(`queda código muerto:\n${vivos.slice(0, 8).join("\n")}`);
  asegurar(fuentes.some((f) => f === "src/util.ts") && fuentes.some((f) => f === "src/precios.ts"), "faltan ficheros que sí se usan");

  sinCambios(dir, "test/api.test.ts");
  const t = bunTest(dir);
  if (t.codigo !== 0 || t.aprobados < 4) fallar(`bun test no pasa:\n${resumir(t.todo)}`);
});
