/**
 * Punto de entrada del núcleo.
 *
 *   aquiles-nucleo [--puerto N] [--host IP] [--proveedor NOMBRE] [--modelo ID] [--cwd RUTA] [--perfil NOMBRE] [--token T]
 *   aquiles-nucleo --cli [--continuar | --reanudar ID] [--modo-aprobacion MODO] ...
 *   aquiles-nucleo --acp   (Agent Client Protocol por stdio, para editores como Zed)
 *
 * En modo servidor, stdout solo lleva la línea `AQUILES_READY port=N` (la lee la app);
 * los registros van a stderr. El token llega en AQUILES_TOKEN (o --token para desarrollo).
 * Con AQUILES_VIGILAR_STDIN=1 el núcleo termina cuando se cierra stdin: si la app muere, él también.
 * `--host 0.0.0.0` (o una IP) es el modo remoto: otra máquina puede conectarse con el token.
 * Sale con el código 75 cuando pide que lo relancen (restaurar una copia); la app lo hace sola.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { LINEA_LISTO, MODOS_APROBACION, type ModoAprobacion } from "@aquiles/protocolo";
import paquete from "../package.json";
import { servirAcp } from "./acp";
import { ejecutarCli } from "./cli";
import { herramientasPorDefecto } from "./herramientas/index";
import { crearProveedor, servidorLlamaCpp } from "./proveedores/index";
import { aplicarRestauracion, NOMBRE_PERFIL } from "./perfiles";
import { directorioDatos, directorioPerfil } from "./rutas";
import { iniciarServidor, ORIGENES_APP } from "./servidor";

const { values: op } = parseArgs({
  args: process.argv.slice(2),
  options: {
    cli: { type: "boolean", default: false },
    acp: { type: "boolean", default: false },
    continuar: { type: "boolean", default: false },
    reanudar: { type: "string" },
    puerto: { type: "string", default: "0" },
    host: { type: "string", default: "127.0.0.1" },
    proveedor: { type: "string", default: process.env.AQUILES_PROVEEDOR ?? "agy" },
    modelo: { type: "string", default: process.env.AQUILES_MODELO },
    cwd: { type: "string", default: process.env.AQUILES_CWD ?? process.cwd() },
    perfil: { type: "string", default: process.env.AQUILES_PERFIL ?? "principal" },
    "modo-aprobacion": { type: "string", default: "preguntar-ejecutar" },
    token: { type: "string" },
  },
});

const log = (m: string) => console.error(`[núcleo] ${m}`);
const modo = op["modo-aprobacion"] as ModoAprobacion;
if (!MODOS_APROBACION.includes(modo)) {
  console.error(`Modo de aprobación desconocido: ${modo} (${MODOS_APROBACION.join(", ")})`);
  process.exit(2);
}

if (!NOMBRE_PERFIL.test(op.perfil!)) {
  console.error(`Nombre de perfil no válido: ${op.perfil}`);
  process.exit(2);
}
const anterior = aplicarRestauracion(op.perfil!);
if (anterior) log(`perfil restaurado desde una copia; el anterior quedó en ${anterior}`);

const herramientas = herramientasPorDefecto();
const perfil = directorioPerfil(op.perfil);
/** Skills que vienen con Aquiles: junto al .exe compilado o, en desarrollo, en `skills/` del repo. */
const skillsIncluidas =
  [join(dirname(process.execPath), "skills"), join(import.meta.dir, "..", "..", "..", "skills")].find((d) => existsSync(d)) ?? null;

if (op.cli) {
  await ejecutarCli({
    proveedor: crearProveedor(op.proveedor!, { modelo: op.modelo }), herramientas, cwd: op.cwd!, perfil, skillsIncluidas, modoAprobacion: modo,
    reanudar: op.continuar ? "ultima" : op.reanudar,
  });
  process.exit(0);
}

if (op.acp) {
  // El servidor solo hace falta por su Motor: escucha en un puerto cualquiera con un token que nadie conoce.
  // stdout es del protocolo; los registros van a stderr.
  const interno = iniciarServidor({
    puerto: 0, token: randomBytes(32).toString("hex"), proveedor: op.proveedor!, modelo: op.modelo, herramientas,
    cwdPorDefecto: op.cwd!, version: paquete.version, perfil, skillsIncluidas, nombrePerfil: op.perfil, datos: directorioDatos(), log,
  });
  await servirAcp({
    motor: interno.motor, entrada: Bun.stdin.stream(), salida: (l) => process.stdout.write(`${l}
`),
    version: paquete.version, cwdPorDefecto: op.cwd!,
  });
  await interno.detener();
  process.exit(0);
}

const token = op.token ?? process.env.AQUILES_TOKEN;
if (!token) {
  console.error("Falta el token: AQUILES_TOKEN o --token. Ejemplo para desarrollo:");
  console.error(`  --token ${randomBytes(16).toString("hex")}`);
  process.exit(2);
}

const extra = (process.env.AQUILES_ORIGENES ?? "").split(",").filter(Boolean);
// Si el núcleo anterior murió con un modelo cargado (la app lo mata sin avisar), su llama-server sigue ocupando la GPU.
servidorLlamaCpp();
const servidor = iniciarServidor({
  puerto: Number(op.puerto),
  token,
  proveedor: op.proveedor!,
  modelo: op.modelo,
  herramientas,
  cwdPorDefecto: op.cwd!,
  version: paquete.version,
  perfil,
  skillsIncluidas,
  nombrePerfil: op.perfil,
  datos: directorioDatos(),
  host: op.host,
  reiniciar: (motivo) => {
    log(`reinicio pedido: ${motivo}`);
    void servidor.detener().finally(() => process.exit(75));
  },
  incluirSimulado: op.proveedor === "simulado" || process.env.AQUILES_DESARROLLO === "1",
  origenesPermitidos: [...ORIGENES_APP, ...extra],
  log,
});
log(`v${paquete.version}, proveedor por defecto ${op.proveedor}${op.modelo ? ` (${op.modelo})` : ""}, carpeta ${op.cwd}, perfil ${perfil}, skills incluidas ${skillsIncluidas ?? "ninguna"}`);
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
