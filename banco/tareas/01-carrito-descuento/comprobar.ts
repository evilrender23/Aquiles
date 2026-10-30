import { bunTest, comprobar, funcion, igual, importar, resumir, sinCambios, fallar } from "../../comun";

await comprobar(async (dir) => {
  sinCambios(dir, "test/carrito.test.ts");
  const m = await importar(dir, "src/carrito.ts");
  const total = funcion(m, "total");
  const subtotal = funcion(m, "subtotal");
  const l = (precio: number, cantidad = 1) => ({ producto: "x", precio, cantidad });

  igual(subtotal([l(2.5, 4), l(1)]), 11, "subtotal");
  igual(total([l(100, 2)], 10), 180, "200 € con un 10 %");
  igual(total([l(100, 2)]), 200, "200 € sin descuento");
  igual(total([l(25, 2)]), 50, "50 € justos no pagan envío");
  igual(total([l(55.56)], 10), 50, "50 € justos tras el descuento no pagan envío");
  igual(total([l(19.99, 3)], 20), 52.93, "47,98 € tras el 20 % pagan envío");
  igual(total([l(9.99)]), 14.94, "pedido pequeño con envío");
  igual(total([l(80)], 50), 44.95, "80 € con un 50 % pagan envío");
  igual(total([], 10), 0, "carrito vacío");

  const t = bunTest(dir);
  if (t.codigo !== 0 || t.fallidos > 0) fallar(`bun test no pasa:\n${resumir(t.todo)}`);
});
