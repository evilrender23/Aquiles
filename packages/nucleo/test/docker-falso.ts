/**
 * Imita la CLI de docker para los tests de la terminal en contenedor: run, exec (con o sin -i), rm -f y ps.
 * El «contenedor» es la carpeta montada: exec lanza Git Bash ($AQUILES_FALSO_BASH) en ella, y rm -f mata
 * lo que se lanzó dentro, como hace Docker al borrarlo. Cada orden se apunta en $AQUILES_FALSO_DIR/ordenes.log
 * (una línea JSON; los exec, también al terminar solos). Con AQUILES_FALSO_CAIDO=1 contesta como un Docker sin demonio.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.AQUILES_FALSO_DIR;
const bash = process.env.AQUILES_FALSO_BASH;
if (!dir || !bash) {
  console.error("docker falso: faltan AQUILES_FALSO_DIR o AQUILES_FALSO_BASH");
  process.exit(2);
}
const [orden, ...args] = process.argv.slice(2);
const apuntar = (o: unknown) => appendFileSync(join(dir, "ordenes.log"), `${JSON.stringify(o)}\n`);
apuntar({ orden: [orden, ...args] });

if (process.env.AQUILES_FALSO_CAIDO === "1") {
  console.error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
  process.exit(1);
}

interface Contenedor {
  imagen: string;
  montaje: string;
}
const fichero = join(dir, "contenedores.json");
const contenedores: Record<string, Contenedor> = existsSync(fichero) ? JSON.parse(readFileSync(fichero, "utf8")) : {};
const guardar = () => writeFileSync(fichero, JSON.stringify(contenedores));
/**
 * Pids de MSYS de lo lanzado con exec en cada contenedor, para que rm -f lo mate. Se mata por grupo de MSYS
 * y no con taskkill /T, porque los exec de MSYS dejan huérfanos en el árbol de Windows.
 */
const pids = (nombre: string) => join(dir, "pids", nombre);

if (orden === "run") {
  const conValor = new Set(["--name", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "-v", "-w", "-e"]);
  const opciones = new Map<string, string>();
  let i = 0;
  for (; i < args.length && args[i]!.startsWith("-"); i++) if (conValor.has(args[i]!)) opciones.set(args[i]!, args[++i]!);
  const nombre = opciones.get("--name")!;
  const volumen = opciones.get("-v")!;
  if (contenedores[nombre]) {
    console.error(`docker: Error response from daemon: Conflict. The container name "/${nombre}" is already in use by container "abc123".`);
    process.exit(125);
  }
  contenedores[nombre] = { imagen: args[i]!, montaje: volumen.slice(0, volumen.lastIndexOf(":")) };
  guardar();
  console.log("f".repeat(64));
} else if (orden === "ps") {
  const filtro = args[args.indexOf("--filter") + 1]!.replace(/^name=/, "");
  const formato = args[args.indexOf("--format") + 1]!;
  for (const nombre of Object.keys(contenedores).filter((n) => n.includes(filtro))) {
    console.log(formato.replace("{{.Names}}", nombre).replace("{{.State}}", "running"));
  }
} else if (orden === "rm") {
  const nombre = args.at(-1)!;
  if (!contenedores[nombre]) {
    console.error(`Error response from daemon: No such container: ${nombre}`);
    process.exit(1);
  }
  delete contenedores[nombre];
  guardar();
  for (const f of existsSync(pids(nombre)) ? readdirSync(pids(nombre)) : []) {
    const pid = readFileSync(join(pids(nombre), f), "utf8").trim();
    if (pid) Bun.spawnSync([bash, "-c", `kill -9 -${pid}`], { stdout: "ignore", stderr: "ignore" });
  }
  rmSync(pids(nombre), { recursive: true, force: true });
  console.log(nombre);
} else if (orden === "exec") {
  let i = 0;
  for (; args[i]!.startsWith("-"); i++) if (["-e", "-w", "-u"].includes(args[i]!)) i++;
  const nombre = args[i]!;
  const contenedor = contenedores[nombre];
  if (!contenedor) {
    console.error(`Error response from daemon: No such container: ${nombre}`);
    process.exit(1);
  }
  mkdirSync(pids(nombre), { recursive: true });
  const fichPid = join(pids(nombre), randomUUID());
  const proc = Bun.spawn({
    // Lanzado desde un proceso de Windows, su pid de MSYS es también su grupo.
    cmd: [bash, "-c", 'printf %s "$$" > "$0"; exec "$@"', fichPid.replace(/\\/g, "/"), ...args.slice(i + 1)],
    cwd: contenedor.montaje,
    stdin: args.slice(0, i).includes("-i") ? "inherit" : "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const codigo = await proc.exited;
  rmSync(fichPid, { force: true });
  apuntar({ fin: [orden, ...args], codigo });
  process.exit(codigo);
} else {
  console.error(`docker falso: orden no imitada: ${orden}`);
  process.exit(2);
}
