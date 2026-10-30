import { cargarConfig } from "./config";

const entorno = process.env.ENTORNO ?? "produccion";
const config = cargarConfig(entorno);

console.log(`Arrancando en ${entorno} (registro: ${config.registro})`);
for (const [nombre, s] of Object.entries(config.servicios)) {
  console.log(`- ${nombre}: ${s.replicas} réplica(s)`);
}
