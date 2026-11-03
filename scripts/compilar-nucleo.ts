#!/usr/bin/env bun
/**
 * Compila el núcleo en un único ejecutable, el sidecar de la app, con el nombre que Tauri espera
 * (apps/escritorio/src-tauri/binaries/aquiles-nucleo-<triple>[.exe]).
 *
 *   bun scripts/compilar-nucleo.ts              para este equipo (sistema y arquitectura)
 *   bun scripts/compilar-nucleo.ts --universal  Mac: Apple Silicon e Intel en uno (lipo), aquiles-nucleo-universal-apple-darwin
 *   bun scripts/compilar-nucleo.ts --triple x86_64-apple-darwin   otro destino concreto
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const RAIZ = resolve(import.meta.dir, "..");
const BINARIOS = join(RAIZ, "apps/escritorio/src-tauri/binaries");
const ENTRADA = join(RAIZ, "packages/nucleo/src/main.ts");

/** Triple de Rust → destino de `bun build --compile`. */
const DESTINOS: Record<string, string> = {
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};

export function tripleDeEsteEquipo(plataforma = process.platform, arquitectura = process.arch): string {
  if (plataforma === "win32") return "x86_64-pc-windows-msvc";
  if (plataforma === "darwin") return arquitectura === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return arquitectura === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

export const salidaDe = (triple: string) => join(BINARIOS, `aquiles-nucleo-${triple}${triple.includes("windows") ? ".exe" : ""}`);

async function compilar(triple: string): Promise<string> {
  const destino = DESTINOS[triple];
  if (!destino) throw new Error(`Destino desconocido: ${triple} (válidos: ${Object.keys(DESTINOS).join(", ")})`);
  const salida = salidaDe(triple);
  // Para este mismo equipo, sin --target: Bun usa el ejecutable que ya tiene (no descarga nada).
  const propio = triple === tripleDeEsteEquipo();
  const p = Bun.spawn(["bun", "build", ENTRADA, "--compile", ...(propio ? [] : [`--target=${destino}`]), "--outfile", salida], { stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`bun build falló para ${triple}`);
  return salida;
}

async function principal(): Promise<void> {
  const args = Bun.argv.slice(2);
  mkdirSync(BINARIOS, { recursive: true });
  if (args.includes("--universal")) {
    const arm = await compilar("aarch64-apple-darwin");
    const intel = await compilar("x86_64-apple-darwin");
    const universal = salidaDe("universal-apple-darwin");
    const p = Bun.spawn(["lipo", "-create", "-output", universal, arm, intel], { stdout: "inherit", stderr: "inherit" });
    if ((await p.exited) !== 0) throw new Error("lipo falló (¿estás en un Mac con las herramientas de Xcode?)");
    // Los dos sueltos se quedan también: valen para compilar la app de una sola arquitectura.
    console.log(`Núcleo universal: ${universal}`);
    return;
  }
  const i = args.indexOf("--triple");
  const triple = i >= 0 ? args[i + 1] : tripleDeEsteEquipo();
  if (!triple) throw new Error("--triple necesita un valor");
  console.log(`Núcleo: ${await compilar(triple)}`);
}

if (import.meta.main) {
  principal().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
