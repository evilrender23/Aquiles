import { expect, test } from "bun:test";
import type { AjustesVoz } from "@aquiles/protocolo";
import { ejecutarPowershell, reproducirMp3, textoParaLeer, Voz } from "../src/voz";

const ESTADO = JSON.stringify({
  reconocedores: ["es-ES"],
  voces: [
    { nombre: "Microsoft Helena Desktop", idioma: "es-ES" },
    { nombre: "Microsoft Zira Desktop", idioma: "en-US" },
  ],
});

/** `ejecutar` falso: guarda los scripts y responde lo que diga `responder`. */
function falso(responder: (script: string, senal: AbortSignal) => Promise<string> | string) {
  const scripts: string[] = [];
  const ejecutar = async (script: string, senal: AbortSignal) => {
    scripts.push(script);
    return responder(script, senal);
  };
  return { scripts, ejecutar };
}

/** Responde cuando lo aborten, como el PowerShell real al matarlo. */
const hastaAbortar = (_s: string, senal: AbortSignal) =>
  new Promise<string>((_r, rechazar) => senal.addEventListener("abort", () => rechazar(new Error("matado")), { once: true }));

test("estado: reconocedor y voces, calculado una sola vez", async () => {
  const f = falso(() => `aviso que no es JSON\r\n${ESTADO}\r\n`);
  const voz = new Voz({ ejecutar: f.ejecutar });
  const e = await voz.estado();
  expect(e).toEqual({ dictado: true, idiomaDictado: "es-ES", lectura: true, motor: "sistema", voces: ["Microsoft Helena Desktop", "Microsoft Zira Desktop"], ocupada: false });
  await voz.estado();
  expect(f.scripts).toHaveLength(1);
  expect(f.scripts[0]).toContain("InstalledRecognizers");
});

test("estado: sin PowerShell o sin nada instalado, todo a false (y se reintenta)", async () => {
  let llamadas = 0;
  const voz = new Voz({
    ejecutar: async () => {
      llamadas++;
      throw new Error("no hay powershell");
    },
  });
  expect(await voz.estado()).toEqual({ dictado: false, lectura: false, motor: "sistema", voces: [], ocupada: false });
  await voz.estado();
  expect(llamadas).toBe(2);
  const vacia = new Voz({ ejecutar: async () => JSON.stringify({ reconocedores: [], voces: [] }) });
  expect(await vacia.estado()).toEqual({ dictado: false, lectura: false, motor: "sistema", voces: [], ocupada: false });
});

test("dictar: DictationGrammar en es-ES, hasta silencio o los segundos pedidos", async () => {
  const f = falso(() => JSON.stringify({ texto: " hola mundo ", idioma: "es-ES" }));
  const voz = new Voz({ ejecutar: f.ejecutar });
  expect(await voz.dictar(7)).toBe("hola mundo");
  const s = f.scripts[0]!;
  expect(s).toContain("DictationGrammar");
  expect(s).toContain("'es-ES'");
  expect(s).toContain("SetInputToDefaultAudioDevice");
  expect(s).toContain("InitialSilenceTimeout = [TimeSpan]::FromSeconds(7)");
  expect(s).toContain("EndSilenceTimeout = [TimeSpan]::FromSeconds(1.5)");
  expect(s).toContain("Wait-Event -SourceIdentifier fin -Timeout 7");
  await voz.dictar();
  expect(f.scripts[1]).toContain("FromSeconds(15)");
});

test("dictar: sin reconocedor o sin micrófono, error claro", async () => {
  const sinMicro = new Voz({ ejecutar: async () => JSON.stringify({ error: "sin-microfono" }) });
  await expect(sinMicro.dictar(2)).rejects.toThrow("No hay micrófono");
  const sinReconocedor = new Voz({ ejecutar: async () => JSON.stringify({ error: "sin-reconocedor" }) });
  await expect(sinReconocedor.dictar(2)).rejects.toThrow("reconocedor de voz");
  const roto = new Voz({ ejecutar: async () => "" });
  await expect(roto.dictar(2)).rejects.toThrow("no devolvió lo esperado");
});

test("leer: el texto va en base64, nunca crudo, y sin marcas de Markdown", async () => {
  const f = falso(() => JSON.stringify({ ok: true }));
  const voz = new Voz({ ejecutar: f.ejecutar });
  const peligroso = `Hola '; Remove-Item C:\\ -Recurse; $(calc) "fin"`;
  await voz.leer(peligroso);
  const s = f.scripts[0]!;
  expect(s).not.toContain("Remove-Item");
  expect(s).not.toContain("$(calc)");
  const b64 = /FromBase64String\('([^']+)'\)/.exec(s)?.[1];
  expect(Buffer.from(b64!, "base64").toString("utf8")).toBe(peligroso);
  expect(s).toContain("'es-ES'");
  expect(s).toContain("$s.Speak($texto)");

  await voz.leer("   ");
  expect(f.scripts).toHaveLength(1);
  const fallo = new Voz({ ejecutar: async () => JSON.stringify({ error: "lectura", detalle: "sin altavoz" }) });
  await expect(fallo.leer("hola")).rejects.toThrow("No se pudo leer en voz alta: sin altavoz");
});

test("textoParaLeer quita títulos, negritas, código, viñetas y deja el texto de los enlaces", () => {
  const md = "# Título\n\n**Hola** y `código` con [un enlace](https://x.org).\n\n- uno\n- dos\n\n```ts\nconst a = 1;\n```";
  expect(textoParaLeer(md)).toBe("Título\n\nHola y código con un enlace.\n\nuno\ndos\n\nconst a = 1;");
});

test("parar corta la operación en marcha sin dar error; una nueva corta la anterior", async () => {
  const f = falso(hastaAbortar);
  const voz = new Voz({ ejecutar: f.ejecutar });
  const leyendo = voz.leer("un texto largo");
  await Bun.sleep(5);
  expect((await new Voz({ ejecutar: async () => ESTADO }).estado()).ocupada).toBe(false);
  voz.parar();
  await leyendo;

  const dictando = voz.dictar(30);
  await Bun.sleep(5);
  const leyendo2 = voz.leer("otro");
  expect(await dictando).toBe("");
  voz.parar();
  await leyendo2;
  expect(f.scripts).toHaveLength(3);
});

test("ocupada mientras dicta o lee", async () => {
  let soltar = () => {};
  const voz = new Voz({
    ejecutar: async (script) => {
      if (script.includes("InstalledRecognizers()") && !script.includes("DictationGrammar")) return ESTADO;
      await new Promise<void>((r) => (soltar = r));
      return JSON.stringify({ ok: true });
    },
  });
  const leyendo = voz.leer("hola");
  await Bun.sleep(5);
  expect((await voz.estado()).ocupada).toBe(true);
  soltar();
  await leyendo;
  expect((await voz.estado()).ocupada).toBe(false);
});

test.skipIf(process.platform !== "win32")("Windows: estado real con System.Speech y scripts que PowerShell acepta", async () => {
  const e = await new Voz().estado();
  expect(typeof e.dictado).toBe("boolean");
  expect(Array.isArray(e.voces)).toBe(true);
  // En esta máquina hay reconocedor es-ES y la voz Helena; en otra basta con que la detección no falle.
  if (e.dictado) expect(e.idiomaDictado).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
  if (e.lectura) expect(e.voces.length).toBeGreaterThan(0);

  // Los scripts de dictar y leer se comprueban con el analizador de PowerShell, sin abrir el micrófono ni sonar.
  const f = falso(() => JSON.stringify({ ok: true, texto: "" }));
  const voz = new Voz({ ejecutar: f.ejecutar });
  await voz.dictar(3);
  await voz.leer("Prueba con «comillas» y 'apóstrofos'");
  await reproducirMp3(new Uint8Array(6000), new AbortController().signal, f.ejecutar);
  expect(f.scripts.at(-1)).toContain("System.Windows.Media.MediaPlayer");
  for (const script of f.scripts) {
    const b64 = Buffer.from(script, "utf8").toString("base64");
    const comprobar = `$errores = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')), [ref]$null, [ref]$errores)
ConvertTo-Json -Compress @{ errores = @($errores | ForEach-Object { $_.Message }) }`;
    const salida = await ejecutarPowershell(comprobar, new AbortController().signal);
    expect(JSON.parse(salida.trim()).errores).toEqual([]);
  }
}, 60_000);

const EDGE: AjustesVoz = { motor: "edge", vozEdge: "es-MX-DaliaNeural", velocidad: 20 };

test("Edge: pide el trozo siguiente mientras suena el anterior, con la voz y la velocidad de los ajustes", async () => {
  const pasos: string[] = [];
  const voz = new Voz({
    ajustes: () => EDGE,
    conReproductor: true,
    ejecutar: async () => ESTADO,
    sintetizar: async (t, o) => {
      pasos.push(`pide ${t.slice(0, 6)} ${o.voz} ${o.velocidad}`);
      return new TextEncoder().encode(t.slice(0, 6));
    },
    reproducir: async (mp3) => {
      pasos.push(`suena ${new TextDecoder().decode(mp3)}`);
      await Bun.sleep(5);
    },
  });
  expect((await voz.estado()).lectura).toBe(true);
  expect((await voz.estado()).motor).toBe("edge");
  // El primer trozo es corto (~500 bytes), así que esto son al menos dos.
  await voz.leer(`**Uno.** ${"palabra ".repeat(80)}fin. Dos ${"otra ".repeat(80)}fin.`);
  expect(pasos[0]).toBe("pide Uno. es-MX-DaliaNeural 20");
  expect(pasos[1]).toStartWith("pide ");
  expect(pasos[2]).toBe("suena Uno.");
  expect(pasos.filter((p) => p.startsWith("suena")).length).toBeGreaterThanOrEqual(2);
});

test("Edge: sin conexión, las voces del sistema si las hay; si ya sonó algo o no hay respaldo, el error", async () => {
  const sinRed = async () => {
    throw new Error("No se pudo conectar con el servicio de voz de Edge");
  };
  const f = falso((s) => (s.includes("GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach") ? ESTADO : JSON.stringify({ ok: true })));
  const conRespaldo = new Voz({ ajustes: () => EDGE, conReproductor: true, respaldoSistema: true, ejecutar: f.ejecutar, sintetizar: sinRed });
  await conRespaldo.leer("hola");
  expect(f.scripts.some((s) => s.includes("$s.Speak($texto)"))).toBe(true);

  const sinRespaldo = new Voz({ ajustes: () => EDGE, conReproductor: true, respaldoSistema: false, ejecutar: f.ejecutar, sintetizar: sinRed });
  await expect(sinRespaldo.leer("hola")).rejects.toThrow("servicio de voz de Edge");

  let n = 0;
  const aMedias = new Voz({
    ajustes: () => EDGE,
    conReproductor: true,
    respaldoSistema: true,
    ejecutar: f.ejecutar,
    sintetizar: async () => {
      if (n++ > 0) throw new Error("se cortó");
      return new Uint8Array(10);
    },
    reproducir: async () => {},
  });
  await expect(aMedias.leer(`Uno. ${"palabra ".repeat(120)}fin.`)).rejects.toThrow("se cortó");
});

test("Edge: parar corta la síntesis o el audio sin dar error; sin reproductor no hay lectura", async () => {
  const voz = new Voz({
    ajustes: () => EDGE,
    conReproductor: true,
    ejecutar: async () => ESTADO,
    sintetizar: async () => new Uint8Array(10),
    reproducir: (_mp3, senal) => new Promise((_r, rechazar) => senal.addEventListener("abort", () => rechazar(new Error("cortado")), { once: true })),
  });
  const leyendo = voz.leer("hola");
  await Bun.sleep(5);
  expect((await voz.estado()).ocupada).toBe(true);
  voz.parar();
  await leyendo;
  expect((await voz.estado()).ocupada).toBe(false);

  const sinAltavoz = new Voz({ ajustes: () => EDGE, conReproductor: false, ejecutar: async () => JSON.stringify({ reconocedores: [], voces: [] }) });
  expect((await sinAltavoz.estado()).lectura).toBe(false);
});
