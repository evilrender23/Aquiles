import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dictadoInstalado, escucharFrase, instalarDictado, ordenGrabadora, principalDictado, type Reconocedor } from "../src/dictado-linux";
import { Voz } from "../src/voz";
import { escribirZip } from "../src/zip";

/** Un reconocedor que sigue un guion: en cada trozo, si cierra frase (y cuál) o qué lleva oído. */
function guion(pasos: ({ fin: string } | { parcial: string } | null)[]): Reconocedor & { trozos: number[] } {
  let i = 0;
  let paso: (typeof pasos)[number] = null;
  const trozos: number[] = [];
  return {
    trozos,
    aceptar(pcm) {
      trozos.push(pcm.length);
      paso = pasos[i++] ?? null;
      return paso !== null && "fin" in paso;
    },
    resultado: () => (paso && "fin" in paso ? paso.fin : ""),
    parcial: () => (paso && "parcial" in paso ? paso.parcial : ""),
    final: () => "",
    cerrar() {},
  };
}

/** Audio de prueba: un trozo cada 100 ms de reloj falso. */
function audio(n: number, reloj: { t: number }, bytes = 3200): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let k = 0; k < n; k++) {
      reloj.t += 100;
      yield new Uint8Array(bytes);
    }
  })();
}

test("una frase: junta los trozos que corta Vosk y acaba tras 1,5 s sin nada nuevo", async () => {
  const reloj = { t: 0 };
  const r = guion([null, { parcial: "abre" }, { parcial: "abre el" }, { fin: "abre el fichero" }, null, { parcial: "y cambia" }, { fin: "y cambia el puerto" }]);
  const { texto } = await escucharFrase(audio(100, reloj), r, 5, () => reloj.t);
  expect(texto).toBe("abre el fichero y cambia el puerto");
  // 7 trozos con voz y 1,5 s (15 trozos) de silencio, más el que lo comprueba.
  expect(r.trozos.length).toBe(7 + 16);
});

test("sin hablar, se rinde a los `segundos`; los bytes sueltos esperan al siguiente trozo", async () => {
  const reloj = { t: 0 };
  const r = guion([]);
  expect(await escucharFrase(audio(100, reloj, 3201), r, 2, () => reloj.t)).toEqual({ texto: "", bytes: 21 * 3201 });
  // Muestras enteras: 3200, y luego 3202 (el byte que sobró más 3201)...
  expect(r.trozos.slice(0, 3)).toEqual([3200, 3202, 3200]);
  // Sin audio (el micrófono no da nada): bytes 0.
  expect(await escucharFrase(audio(0, reloj), guion([]), 2, () => reloj.t)).toEqual({ texto: "", bytes: 0 });
});

test("grabadora: parecord y, si no, arecord, siempre PCM de 16 bits a 16 kHz por stdout", () => {
  expect(ordenGrabadora((p) => (p === "parecord" ? "/usr/bin/parecord" : "/usr/bin/arecord"))?.slice(0, 4)).toEqual(["/usr/bin/parecord", "--raw", "--format=s16le", "--rate=16000"]);
  expect(ordenGrabadora((p) => (p === "arecord" ? "/usr/bin/arecord" : null))).toContain("S16_LE");
  expect(ordenGrabadora(() => null)).toBeUndefined();
});

/** Zips como los de Vosk: todo dentro de una carpeta de primer nivel. */
function zipCon(dir: string, nombre: string, ficheros: Record<string, string>) {
  const ruta = join(dir, nombre);
  escribirZip(ruta, Object.entries(ficheros).map(([n, c]) => ({ nombre: n, datos: () => new TextEncoder().encode(c) })));
  const bytes = readFileSync(ruta);
  return { url: `https://prueba/${nombre}`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}

test("instalar: descarga, comprueba las huellas y deja la biblioteca y el modelo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aquiles-dictado-"));
  const lib = zipCon(dir, "lib.zip", { "vosk-linux-x86_64-0.3.45/libvosk.so": "elf", "vosk-linux-x86_64-0.3.45/vosk_api.h": "h" });
  const modelo = zipCon(dir, "modelo.zip", { "vosk-model-small-es-0.42/am/final.mdl": "mdl", "vosk-model-small-es-0.42/conf/model.conf": "c" });
  const servir = (async (url: string) => {
    const d = [lib, modelo].find((x) => x.url === url);
    return d ? new Response(d.bytes) : new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  const destino = join(dir, "dictado");
  await instalarDictado(destino, { fetch: servir, fuentes: { libreria: lib, modelo } });
  expect(dictadoInstalado(destino)).toBe(true);
  expect(readFileSync(join(destino, "vosk", "libvosk.so"), "utf8")).toBe("elf");
  expect(readFileSync(join(destino, "modelo", "conf", "model.conf"), "utf8")).toBe("c");
  expect(existsSync(`${destino}.nuevo`)).toBe(false);

  // Una descarga cambiada no se instala, y lo que había sigue.
  await expect(instalarDictado(destino, { fetch: servir, fuentes: { libreria: { ...lib, sha256: "0".repeat(64) }, modelo } })).rejects.toThrow("no es la esperada");
  expect(dictadoInstalado(destino)).toBe(true);
  await expect(instalarDictado(join(dir, "otro"), { arquitectura: "ia32" })).rejects.toThrow("arquitectura");
});

test("Voz en Linux: se ofrece instalar el dictado y, instalado, cada frase es un núcleo con --dictado-linux", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "aquiles-dictado-")), "dictado");
  const ordenes: string[][] = [];
  const voz = new Voz({
    sistema: "linux",
    dictado: dir,
    nucleo: ["/opt/aquiles/aquiles-nucleo"],
    buscar: () => null,
    lanzar: async (orden) => (ordenes.push(orden), JSON.stringify({ texto: " hola desde Linux ", idioma: "es-ES" })),
  });
  expect(await voz.estado()).toMatchObject({ dictado: false, dictadoInstalable: true });
  await expect(voz.dictar()).rejects.toThrow("no está instalado");

  mkdirSync(join(dir, "vosk"), { recursive: true });
  mkdirSync(join(dir, "modelo", "am"), { recursive: true });
  writeFileSync(join(dir, "vosk", "libvosk.so"), "");
  writeFileSync(join(dir, "modelo", "am", "final.mdl"), "");
  const nueva = new Voz({ sistema: "linux", dictado: dir, nucleo: ["/opt/aquiles/aquiles-nucleo"], buscar: () => null, lanzar: async (o) => (ordenes.push(o), JSON.stringify({ texto: " hola desde Linux " })) });
  const e = await nueva.estado();
  expect(e).toMatchObject({ dictado: true, idiomaDictado: "es-ES" });
  expect(e.dictadoInstalable).toBeUndefined();
  expect(await nueva.dictar(9)).toBe("hola desde Linux");
  expect(ordenes.at(-1)).toEqual(["/opt/aquiles/aquiles-nucleo", "--dictado-linux", "9", dir]);

  const sinGrabadora = new Voz({ sistema: "linux", dictado: dir, nucleo: ["x"], buscar: () => null, lanzar: async () => JSON.stringify({ error: "sin-grabadora" }) });
  await expect(sinGrabadora.dictar()).rejects.toThrow("pulseaudio-utils");
  await expect(new Voz({ sistema: "windows", ejecutar: async () => "{}" }).instalarDictado()).rejects.toThrow("Solo hace falta");
});

test("el proceso de dictado contesta en JSON aunque falte el motor", async () => {
  const lineas: string[] = [];
  expect(await principalDictado(["5", "/no/existe"], (l) => lineas.push(l))).toBe(0);
  expect(lineas.map((l) => JSON.parse(l))).toEqual([{ error: "sin-motor" }]);

  // Y por la línea de órdenes del núcleo, sin arrancar el servidor.
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "--dictado-linux", "3", "/no/existe"], { stdout: "pipe", stderr: "ignore", env: { ...process.env } });
  expect(JSON.parse((await new Response(p.stdout).text()).trim())).toEqual({ error: "sin-motor" });
  expect(await p.exited).toBe(0);
});
