import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Nota {
  id: number;
  texto: string;
  hecha: boolean;
}

export function cargar(fichero: string): Nota[] {
  if (!existsSync(fichero)) return [];
  return JSON.parse(readFileSync(fichero, "utf8")) as Nota[];
}

export function guardar(fichero: string, notas: Nota[]): void {
  writeFileSync(fichero, `${JSON.stringify(notas, null, 2)}\n`);
}
