import { expect, test } from "bun:test";
import { calcularDiff, lineas, operaciones } from "../src/diff";

const aplicar = (ops: ReturnType<typeof operaciones>) => ({
  antes: ops.filter((o) => o.tipo !== "+").map((o) => o.texto),
  despues: ops.filter((o) => o.tipo !== "-").map((o) => o.texto),
});

test("las operaciones reconstruyen ambos textos y son mínimas", () => {
  const casos: [string[], string[], number][] = [
    [["a", "b", "c"], ["a", "x", "c"], 2],
    [[], ["a", "b"], 2],
    [["a", "b"], [], 2],
    [["a", "b", "c", "d"], ["a", "c", "d", "e"], 2],
    [["x", "y"], ["x", "y"], 0],
  ];
  for (const [a, b, cambios] of casos) {
    const ops = operaciones(a, b);
    expect(aplicar(ops)).toEqual({ antes: a, despues: b });
    expect(ops.filter((o) => o.tipo !== " ").length).toBe(cambios);
  }
});

test("aleatorio: siempre reconstruye", () => {
  let semilla = 7;
  const azar = (n: number) => ((semilla = (semilla * 1103515245 + 12345) % 2 ** 31), semilla % n);
  for (let i = 0; i < 200; i++) {
    const a = Array.from({ length: azar(15) }, () => "abcd"[azar(4)]!);
    const b = Array.from({ length: azar(15) }, () => "abcd"[azar(4)]!);
    expect(aplicar(operaciones(a, b))).toEqual({ antes: a, despues: b });
  }
});

test("bloques con 3 líneas de contexto y números de línea", () => {
  const antes = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
  const despues = antes.replace("l10", "L10").replace("l11\n", "");
  const d = calcularDiff("a.txt", antes, despues);
  expect(d).toMatchObject({ ruta: "a.txt", nuevo: false, anadidas: 1, quitadas: 2 });
  expect(d.bloques.length).toBe(1);
  expect(d.bloques[0]).toMatchObject({ lineaAntes: 7, lineaDespues: 7 });
  expect(d.bloques[0]!.lineas.map((l) => `${l.tipo}${l.texto}`)).toEqual([" l7", " l8", " l9", "-l10", "-l11", "+L10", " l12", " l13", " l14"]);
});

test("cambios lejanos van en bloques separados; fichero nuevo; CRLF", () => {
  const antes = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n");
  const despues = antes.replace("l2\n", "X\n").replace("l28", "Y");
  expect(calcularDiff("a", antes, despues).bloques.length).toBe(2);
  expect(calcularDiff("n.txt", undefined, "a\nb\n")).toMatchObject({ nuevo: true, anadidas: 2, quitadas: 0 });
  expect(lineas("a\r\nb\r\n")).toEqual(["a", "b"]);
  expect(calcularDiff("c", "a\r\nb\r\n", "a\nb\n").bloques).toEqual([]);
});
