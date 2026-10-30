import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { borrar, bunTest, comprobar, copiaTemporal, fallar, ficheros, leerInicial, resumir, sinCambios } from "../../comun";

/** Versiones rotas de src/validador.ts: los tests del agente tienen que detectar todas. */
const MUTANTES: [string, string, string][] = [
  ["no comprueba la letra de control", "return LETRAS[numero % 23] === m[3];", "return LETRAS.includes(m[3]!);"],
  ["no acepta minúsculas", "documento.toUpperCase().replace(/[\\s-]/g, \"\")", "documento.replace(/[\\s-]/g, \"\")"],
  ["no ignora espacios ni guiones del documento", "documento.toUpperCase().replace(/[\\s-]/g, \"\")", "documento.toUpperCase().trim()"],
  ["no acepta NIE", "/^([XYZ]|\\d)(\\d{7})([A-Z])$/", "/^(\\d)(\\d{7})([A-Z])$/"],
  ["calcula mal los NIE con Z", "\"XYZ\".indexOf(m[1]!)", "\"XY\".indexOf(m[1]!)"],
  ["no quita el prefijo +34", "if (cifras.startsWith(\"+34\")) cifras = cifras.slice(3);", "if (cifras.startsWith(\"+3400\")) cifras = cifras.slice(3);"],
  ["no quita el prefijo 0034", "else if (cifras.startsWith(\"0034\")) cifras = cifras.slice(4);", ""],
  ["no quita los puntos del teléfono", "telefono.replace(/[\\s.-]/g, \"\")", "telefono.replace(/[\\s-]/g, \"\")"],
  ["acepta teléfonos que empiezan por cualquier cifra", "/^[6-9]\\d{8}$/", "/^\\d{9}$/"],
  ["acepta teléfonos de 10 cifras", "/^[6-9]\\d{8}$/", "/^[6-9]\\d{8,9}$/"],
  ["devuelve el teléfono sin +34", "return `+34${cifras}`;", "return cifras;"],
];

await comprobar(async (dir) => {
  sinCambios(dir, "src/validador.ts");
  const tests = ficheros(dir).filter((f) => /(\.|_)(test|spec)\.(ts|tsx|js|mjs)$/.test(f));
  if (tests.length === 0) fallar("no hay ningún fichero de tests (*.test.ts)");

  const t = bunTest(dir);
  if (t.codigo !== 0 || t.fallidos > 0) fallar(`los tests no pasan con el código actual:\n${resumir(t.todo)}`);
  if (t.aprobados < 6) fallar(`muy pocos tests: ${t.aprobados}`);

  const original = leerInicial("src/validador.ts");
  const copia = copiaTemporal(dir);
  const vivos: string[] = [];
  try {
    for (const [nombre, buscar, poner] of MUTANTES) {
      if (!original.includes(buscar)) throw new Error(`mutante mal definido: ${nombre}`);
      writeFileSync(join(copia, "src/validador.ts"), original.replace(buscar, poner));
      const r = bunTest(copia);
      // Solo cuenta como detectado si algún test falla (no por un error al cargar o por no encontrar tests).
      if (r.fallidos === 0) vivos.push(nombre);
    }
  } finally {
    borrar(copia);
  }
  if (vivos.length) fallar(`los tests no detectan ${vivos.length} de ${MUTANTES.length} fallos inyectados: ${vivos.join("; ")}`);
});
