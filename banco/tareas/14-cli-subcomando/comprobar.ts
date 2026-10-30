import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asegurar, borrar, BUN, carpetaTemporal, comprobar, ejecutar, fallar, igual, resumir } from "../../comun";

await comprobar(async (dir) => {
  const datos = carpetaTemporal("aquiles-banco-notas-");
  const fichero = join(datos, "mis-notas.json");
  const cli = (...args: string[]) => ejecutar([BUN, join(dir, "src/cli.ts"), ...args], { cwd: datos, env: { NOTAS_FICHERO: fichero } });
  const bien = (args: string[], esperado: string[]) => {
    const r = cli(...args);
    if (r.codigo !== 0) fallar(`\`${args.join(" ")}\` termina con código ${r.codigo}:\n${resumir(r.todo)}`);
    igual(r.stdout.trimEnd().split("\n"), esperado, `salida de \`${args.join(" ")}\``);
  };
  try {
    bien(["listar"], ["No hay notas"]);
    bien(["agregar", "Comprar", "pan"], ["Nota 1 añadida"]);
    bien(["agregar", "Llamar a Ana"], ["Nota 2 añadida"]);
    bien(["agregar", "Pagar la luz"], ["Nota 3 añadida"]);
    bien(["hecha", "2"], ["Nota 2 marcada como hecha"]);
    bien(["listar"], ["1. [ ] Comprar pan", "2. [x] Llamar a Ana", "3. [ ] Pagar la luz"]);
    bien(["listar", "--pendientes"], ["1. [ ] Comprar pan", "3. [ ] Pagar la luz"]);
    bien(["hecha", "1"], ["Nota 1 marcada como hecha"]);
    bien(["listar", "--pendientes"], ["3. [ ] Pagar la luz"]);

    const guardadas = JSON.parse(readFileSync(fichero, "utf8"));
    igual(
      guardadas,
      [
        { id: 1, texto: "Comprar pan", hecha: true },
        { id: 2, texto: "Llamar a Ana", hecha: true },
        { id: 3, texto: "Pagar la luz", hecha: false },
      ],
      "contenido del fichero de notas",
    );

    const antes = readFileSync(fichero, "utf8");
    for (const malo of [["hecha", "9"], ["hecha", "abc"], ["hecha", "0"]]) {
      const r = cli(...malo);
      if (r.codigo !== 1) fallar(`\`${malo.join(" ")}\` debía terminar con código 1 y termina con ${r.codigo}`);
      asegurar(r.stderr.trim() !== "", `\`${malo.join(" ")}\` debía escribir un error por stderr`);
      asegurar(!/marcada como hecha/.test(r.stdout), `\`${malo.join(" ")}\` no debía decir que ha marcado nada`);
      igual(readFileSync(fichero, "utf8"), antes, `\`${malo.join(" ")}\` no debe tocar el fichero`);
    }

    const ayuda = cli();
    asegurar(ayuda.codigo !== 0, "sin orden debe salir con error");
    asegurar(/hecha/.test(ayuda.todo) && /--pendientes/.test(ayuda.todo), "la ayuda no menciona `hecha` y `--pendientes`");
  } finally {
    borrar(datos);
  }
});
