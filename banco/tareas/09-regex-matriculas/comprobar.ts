import { comprobar, funcion, igual, importar } from "../../comun";

await comprobar(async (dir) => {
  const m = await importar(dir, "src/matriculas.ts");
  const extraer = funcion(m, "extraerMatriculas");
  const valida = funcion(m, "esMatriculaValida");

  const casos: [string, string[]][] = [
    ["El coche 1234 BCD y la moto 5678-FGH.", ["1234BCD", "5678FGH"]],
    ["matrícula 0000bbb, multada", ["0000BBB"]],
    ["1234BCD,5678FGH;9012JKL", ["1234BCD", "5678FGH", "9012JKL"]],
    ["(1234-xyz)", ["1234XYZ"]],
    ["1234ABC 1234BCE 1234BIC 1234OUU", []],
    ["1234QRS 1234ÑBC 1234BÑC", []],
    ["12345BCD", []],
    ["1234BCDF", []],
    ["A1234BCD", []],
    ["1234  BCD", []],
    ["1234_BCD", []],
    ["1234--BCD", []],
    ["Ref: 9999-ZZZ y 1111 MNP.", ["9999ZZZ", "1111MNP"]],
    ["sin matrículas", []],
    ["", []],
  ];
  for (const [texto, esperado] of casos) igual(extraer(texto), esperado, `extraerMatriculas(${JSON.stringify(texto)})`);
  igual(extraer("1234BCD 1234BCD"), ["1234BCD", "1234BCD"], "extraerMatriculas con repetidas");

  const validas = ["1234BCD", "1234 BCD", "1234-BCD", "1234bcd", "  0001XYZ ", "9876 lmn"];
  const invalidas = ["1234ABC", "1234QBC", "1234ÑBC", "123BCD", "12345BCD", "1234BCDF", "1234  BCD", "1234_BCD", "X1234BCD", "", "BCD1234"];
  for (const v of validas) igual(valida(v), true, `esMatriculaValida(${JSON.stringify(v)})`);
  for (const v of invalidas) igual(valida(v), false, `esMatriculaValida(${JSON.stringify(v)})`);
});
