/**
 * Imita `ssh [opciones] destino comando` para los tests de la terminal por SSH: el comando lo ejecuta
 * Git Bash ($AQUILES_FALSO_BASH) como si fuera el shell de inicio remoto, en $AQUILES_FALSO_HOME.
 * Cada llamada se apunta en $AQUILES_FALSO_DIR/ordenes.log (una línea JSON; también al terminar sola).
 * Un destino con "sin-clave" falla como un servidor que pide contraseña con BatchMode.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const { AQUILES_FALSO_DIR: dir, AQUILES_FALSO_BASH: bash, AQUILES_FALSO_HOME: home } = process.env;
if (!dir || !bash || !home) {
  console.error("ssh falso: faltan AQUILES_FALSO_DIR, AQUILES_FALSO_BASH o AQUILES_FALSO_HOME");
  process.exit(2);
}
const args = process.argv.slice(2);
const apuntar = (o: unknown) => appendFileSync(join(dir, "ordenes.log"), `${JSON.stringify(o)}\n`);
apuntar({ orden: args });

let i = 0;
for (; args[i]?.startsWith("-"); i++) if (["-o", "-i", "-p", "-F", "-l"].includes(args[i]!)) i++;
const destino = args[i] ?? "";
if (destino.includes("sin-clave")) {
  console.error(`${destino}: Permission denied (publickey).`);
  process.exit(255);
}

// Como ssh: los argumentos tras el destino se unen con espacios y los interpreta el shell remoto.
const proc = Bun.spawn({
  cmd: [bash, "-c", args.slice(i + 1).join(" ")],
  cwd: home,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const codigo = await proc.exited;
apuntar({ fin: args, codigo });
process.exit(codigo);
