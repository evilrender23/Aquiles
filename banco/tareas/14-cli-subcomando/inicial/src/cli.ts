#!/usr/bin/env bun
import { cargar, guardar, type Nota } from "./almacen";

const AYUDA = `Uso: bun src/cli.ts <orden> [argumentos]

Órdenes:
  agregar <texto>   añade una nota
  listar            muestra todas las notas`;

const fichero = process.env.NOTAS_FICHERO ?? "notas.json";
const [orden, ...args] = process.argv.slice(2);

function linea(n: Nota): string {
  return `${n.id}. [${n.hecha ? "x" : " "}] ${n.texto}`;
}

function salirConAyuda(): never {
  console.error(AYUDA);
  process.exit(2);
}

switch (orden) {
  case "agregar": {
    const texto = args.join(" ").trim();
    if (!texto) salirConAyuda();
    const notas = cargar(fichero);
    const id = notas.reduce((max, n) => Math.max(max, n.id), 0) + 1;
    notas.push({ id, texto, hecha: false });
    guardar(fichero, notas);
    console.log(`Nota ${id} añadida`);
    break;
  }
  case "listar": {
    const notas = cargar(fichero);
    if (notas.length === 0) console.log("No hay notas");
    for (const n of notas) console.log(linea(n));
    break;
  }
  default:
    salirConAyuda();
}
