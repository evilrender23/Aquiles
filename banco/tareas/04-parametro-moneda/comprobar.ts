import { BUN, comprobar, ejecutar, fallar, funcion, igual, importar, importarInicial, resumir } from "../../comun";

await comprobar(async (dir) => {
  const formato = await importar(dir, "src/formato.ts");
  const ticket = await importar(dir, "src/ticket.ts");
  const orig = { formato: await importarInicial("src/formato.ts"), ticket: await importarInicial("src/ticket.ts") };
  const fp = funcion(formato, "formatearPrecio");

  for (const n of [0, 1.5, 12.5, 999.999, 1234.5, 1234567.891, -3, -1234.5]) {
    igual(fp(n), orig.formato.formatearPrecio(n), `formatearPrecio(${n}) sin moneda`);
    igual(fp(n, "EUR"), orig.formato.formatearPrecio(n), `formatearPrecio(${n}, "EUR")`);
  }
  igual(fp(1234.5, "USD"), "$1,234.50", 'formatearPrecio(1234.5, "USD")');
  igual(fp(1234.5, "GBP"), "£1,234.50", 'formatearPrecio(1234.5, "GBP")');
  igual(fp(-3, "USD"), "-$3.00", 'formatearPrecio(-3, "USD")');
  igual(fp(0.5, "GBP"), "£0.50", 'formatearPrecio(0.5, "GBP")');
  igual(fp(1234567.891, "USD"), "$1,234,567.89", 'formatearPrecio(1234567.891, "USD")');

  const lineas = [
    { concepto: "Pan", precio: 1.2, cantidad: 3 },
    { concepto: "Aceite de oliva", precio: 1045.5, cantidad: 2 },
  ];
  const lt = funcion(ticket, "lineaTicket");
  const gt = funcion(ticket, "generarTicket");
  igual(lt(lineas[1]), orig.ticket.lineaTicket(lineas[1]), "lineaTicket sin moneda");
  const fila = (cant: number, concepto: string, precio: string) => `${String(cant).padStart(3)} x ${concepto.padEnd(20)}${precio.padStart(14)}`;
  igual(lt(lineas[1], "USD"), fila(2, "Aceite de oliva", "$2,091.00"), 'lineaTicket(l, "USD")');
  igual(gt(lineas), orig.ticket.generarTicket(lineas), "generarTicket sin moneda");
  igual(gt(lineas, "EUR"), orig.ticket.generarTicket(lineas), 'generarTicket(l, "EUR")');
  igual(
    gt(lineas, "GBP"),
    [
      fila(3, "Pan", "£3.60"),
      fila(2, "Aceite de oliva", "£2,091.00"),
      "-".repeat(40),
      `TOTAL${"£2,094.60".padStart(35)}`,
    ].join("\n"),
    'generarTicket(l, "GBP")',
  );

  const original = ejecutar([BUN, "src/main.ts"], { cwd: dir });
  if (original.codigo !== 0) fallar(`bun src/main.ts falla:\n${resumir(original.todo)}`);
  igual(original.stdout, ejecutar([BUN, "src/main.ts"], { cwd: `${import.meta.dir}/inicial` }).stdout, "salida de bun src/main.ts sin argumentos");
  const usd = ejecutar([BUN, "src/main.ts", "USD"], { cwd: dir });
  if (usd.codigo !== 0) fallar(`bun src/main.ts USD falla:\n${resumir(usd.todo)}`);
  if (usd.stdout.includes("€") || !usd.stdout.includes("$1,304.05")) fallar(`bun src/main.ts USD no sale en dólares:\n${usd.stdout}`);
});
