import { cargarConfig } from "./config";
import { rutas } from "./rutas";

const config = cargarConfig();
const entorno = process.env.ENTORNO === "produccion" ? "produccion" : "desarrollo";
console.log(`${config.nombre} v${config.version} (${entorno}) en ${config.servidor.host}:${config.servidor.puerto}`);
console.log(`Idiomas: ${config.idiomas.admitidos.join(", ")} · registro: ${config.entornos[entorno].registro}`);
for (const r of rutas(config)) console.log(`  ${r}`);
