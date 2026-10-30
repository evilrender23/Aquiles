import { comprobar, funcion, igual, importar, leerInicial } from "../../comun";

await comprobar(async (dir) => {
  const m = await importar(dir, "src/csv.ts");
  const csv = funcion(m, "parsearCsv");
  const caso = (texto: string, esperado: string[][], sep?: string) =>
    igual(sep === undefined ? csv(texto) : csv(texto, sep), esperado, `parsearCsv(${JSON.stringify(texto)}${sep ? `, ${JSON.stringify(sep)}` : ""})`);

  caso("a,b,c\n1,2,3", [["a", "b", "c"], ["1", "2", "3"]]);
  caso("a,b,c\n1,2,3\n", [["a", "b", "c"], ["1", "2", "3"]]);
  caso("a,b\r\n1,2\r\n", [["a", "b"], ["1", "2"]]);
  caso('"García, Ana",x', [["García, Ana", "x"]]);
  caso('"Dijo ""hola""",2', [['Dijo "hola"', "2"]]);
  caso('id,nota\n1,"línea 1\nlínea 2"\n2,fin', [["id", "nota"], ["1", "línea 1\nlínea 2"], ["2", "fin"]]);
  caso("a,,c\n,", [["a", "", "c"], ["", ""]]);
  caso('x,""', [["x", ""]]);
  caso("a,b\n\n1,2\n\n", [["a", "b"], ["1", "2"]]);
  caso('"x;y";z\n1;"2"', [["x;y", "z"], ["1", "2"]], ";");
  caso("a;b,c", [["a", "b,c"]], ";");
  caso('"a,b",c\r\n"d""e",f', [["a,b", "c"], ['d"e', "f"]]);
  caso("", []);

  // El fichero original con CRLF; dentro de las notas se acepta tanto \r\n como \n.
  const clientes = funcion(m, "leerClientes")(leerInicial("datos/clientes.csv").replace(/\n/g, "\r\n"));
  igual(
    clientes.map((c: { notas: string }) => ({ ...c, notas: c.notas.replace(/\r\n/g, "\n") })),
    [
      { nombre: "García, Ana", email: "ana@example.com", ciudad: "Sevilla", notas: "Cliente desde 2019" },
      { nombre: "Luis Pérez", email: "luis@example.com", ciudad: "Madrid", notas: 'Prefiere que le llamen "Lucho"' },
      { nombre: "Ruiz Soler, Marta", email: "marta@example.com", ciudad: "Bilbao", notas: "Llamar por la tarde.\nNo enviar publicidad." },
      { nombre: "Jordi Vila", email: "jordi@example.com", ciudad: "Girona, Cataluña", notas: "" },
    ],
    "leerClientes(datos/clientes.csv)",
  );
  igual(
    funcion(m, "leerClientes")('ciudad;nombre;email;notas\n"Vigo";"Iglesias; Pablo";p@example.com;"Nada"\n', ";"),
    [{ nombre: "Iglesias; Pablo", email: "p@example.com", ciudad: "Vigo", notas: "Nada" }],
    "leerClientes con punto y coma",
  );
});
