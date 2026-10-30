/**
 * Punto de entrada del núcleo.
 *
 *   aquiles-nucleo [--puerto N] [--proveedor agy|simulado] [--modelo ID] [--cwd RUTA] [--token T]
 *   aquiles-nucleo --cli ...
 *
 * En modo servidor, stdout solo lleva la línea `AQUILES_READY port=N` (la lee la app);
 * los registros van a stderr. El token llega en AQUILES_TOKEN (o --token para desarrollo).
 * Con AQUILES_VIGILAR_STDIN=1 el núcleo termina cuando se cierra stdin: si la app muere, él también.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { LINEA_LISTO } from "@aquiles/protocolo";
import paquete from "../package.json";
import { ejecutarCli } from "./cli";
import { leer } from "./herramientas/leer";
import { ProveedorAgy } from "./proveedores/agy";
import { guionDemo, ProveedorSimulado } from "./proveedores/simulado";
import { iniciarServidor, ORIGENES_APP } from "./servidor";
import type { Proveedor } from "./tipos";

const { values: op } = parseArgs({
  args: process.argv.slice(2),
  options: {
    cli: { type: "boolean", default: false },
    puerto: { type: "string", default: "0" },
    proveedor: { type: "string", default: process.env.AQUILES_PROVEEDOR ?? "agy" },
    modelo: { type: "string", default: process.env.AQUILES_MODELO },
    cwd: { type: "string", default: process.env.AQUILES_CWD ?? process.cwd() },
    token: { type: "string" },
  },
});

const log = (m: string) => console.error(`[núcleo] ${m}`);

function crearProveedor(nombre: string): Proveedor {
  if (nombre === "agy") return new ProveedorAgy({ modelo: op.modelo });
  if (nombre === "simulado") return new ProveedorSimulado(guionDemo(), 15);
  throw new Error(`Proveedor desconocido: ${nombre} (disponibles: agy, simulado)`);
}

const proveedor = crearProveedor(op.proveedor!);
const herramientas = [leer];

if (op.cli) {
  await ejecutarCli(proveedor, herramientas, op.cwd!);
  process.exit(0);
}

const token = op.token ?? process.env.AQUILES_TOKEN;
if (!token) {
  console.error("Falta el token: AQUILES_TOKEN o --token. Ejemplo para desarrollo:");
  console.error(`  --token ${randomBytes(16).toString("hex")}`);
  process.exit(2);
}

const extra = (process.env.AQUILES_ORIGENES ?? "").split(",").filter(Boolean);
const servidor = iniciarServidor({
  puerto: Number(op.puerto),
  token,
  proveedor,
  herramientas,
  cwdPorDefecto: op.cwd!,
  version: paquete.version,
  origenesPermitidos: [...ORIGENES_APP, ...extra],
  log,
});
log(`v${paquete.version}, proveedor ${proveedor.nombre}, carpeta ${op.cwd}`);
console.log(`${LINEA_LISTO} port=${servidor.puerto}`);

const salir = async () => {
  await servidor.detener();
  process.exit(0);
};
process.on("SIGINT", salir);
process.on("SIGTERM", salir);
if (process.env.AQUILES_VIGILAR_STDIN === "1") {
  process.stdin.on("end", salir);
  process.stdin.on("close", salir);
  process.stdin.resume();
}
