#!/usr/bin/env bun
import { cargar, guardar, type Nota } from "./almacen";

const AYUDA = `Uso: bun src/cli.ts <orden> [argumentos]

Órdenes:
  agregar <texto>         añade una nota
  listar [--pendientes]   muestra las notas (o solo las que no están hechas)
  hecha <id>              marca una nota como hecha`;

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
    const pendientes = args.includes("--pendientes");
    const notas = cargar(fichero).filter((n) => !pendientes || !n.hecha);
    if (notas.length === 0) console.log("No hay notas");
    for (const n of notas) console.log(linea(n));
    break;
  }
  case "hecha": {
    const texto = args[0] ?? "";
    const id = /^\d+$/.test(texto) ? Number(texto) : NaN;
    const notas = cargar(fichero);
    const nota = notas.find((n) => n.id === id);
    if (!nota) {
      console.error(`No existe la nota ${texto}`);
      process.exit(1);
    }
    nota.hecha = true;
    guardar(fichero, notas);
    console.log(`Nota ${id} marcada como hecha`);
    break;
  }
  default:
    salirConAyuda();
}
