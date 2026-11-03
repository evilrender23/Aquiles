import { expect, test } from "bun:test";
import { ejecutarPowershell, ordenarVoces, textoParaLeer, vocesDeSay, Voz, vozParaLeer } from "../src/voz";

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
  const voz = new Voz({ sistema: "windows", ejecutar: f.ejecutar });
  const e = await voz.estado();
  expect(e).toEqual({ dictado: true, idiomaDictado: "es-ES", lectura: true, voces: [{ nombre: "Microsoft Helena Desktop", idioma: "es-ES" }, { nombre: "Microsoft Zira Desktop", idioma: "en-US" }], ocupada: false });
  await voz.estado();
  expect(f.scripts).toHaveLength(1);
  expect(f.scripts[0]).toContain("InstalledRecognizers");
});

test("estado: sin PowerShell o sin nada instalado, todo a false (y se reintenta)", async () => {
  let llamadas = 0;
  const voz = new Voz({
    sistema: "windows",
    ejecutar: async () => {
      llamadas++;
      throw new Error("no hay powershell");
    },
  });
  expect(await voz.estado()).toEqual({ dictado: false, lectura: false, voces: [], ocupada: false });
  await voz.estado();
  expect(llamadas).toBe(2);
  const vacia = new Voz({ sistema: "windows", ejecutar: async () => JSON.stringify({ reconocedores: [], voces: [] }) });
  expect(await vacia.estado()).toEqual({ dictado: false, lectura: false, voces: [], ocupada: false });
});

test("dictar: DictationGrammar en es-ES, hasta silencio o los segundos pedidos", async () => {
  const f = falso(() => JSON.stringify({ texto: " hola mundo ", idioma: "es-ES" }));
  const voz = new Voz({ sistema: "windows", ejecutar: f.ejecutar });
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
  const sinMicro = new Voz({ sistema: "windows", ejecutar: async () => JSON.stringify({ error: "sin-microfono" }) });
  await expect(sinMicro.dictar(2)).rejects.toThrow("No hay micrófono");
  const sinReconocedor = new Voz({ sistema: "windows", ejecutar: async () => JSON.stringify({ error: "sin-reconocedor" }) });
  await expect(sinReconocedor.dictar(2)).rejects.toThrow("reconocedor de voz");
  const roto = new Voz({ sistema: "windows", ejecutar: async () => "" });
  await expect(roto.dictar(2)).rejects.toThrow("no devolvió lo esperado");
});

test("leer: el texto va en base64, nunca crudo, y sin marcas de Markdown", async () => {
  const f = falso(() => JSON.stringify({ ok: true }));
  const voz = new Voz({ sistema: "windows", ejecutar: f.ejecutar });
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
  const fallo = new Voz({ sistema: "windows", ejecutar: async () => JSON.stringify({ error: "lectura", detalle: "sin altavoz" }) });
  await expect(fallo.leer("hola")).rejects.toThrow("No se pudo leer en voz alta: sin altavoz");
});

test("textoParaLeer quita títulos, negritas, código, viñetas y deja el texto de los enlaces", () => {
  const md = "# Título\n\n**Hola** y `código` con [un enlace](https://x.org).\n\n- uno\n- dos\n\n```ts\nconst a = 1;\n```";
  expect(textoParaLeer(md)).toBe("Título\n\nHola y código con un enlace.\n\nuno\ndos\n\nconst a = 1;");
});

test("parar corta la operación en marcha sin dar error; una nueva corta la anterior", async () => {
  const f = falso(hastaAbortar);
  const voz = new Voz({ sistema: "windows", ejecutar: f.ejecutar });
  const leyendo = voz.leer("un texto largo");
  await Bun.sleep(5);
  expect((await new Voz({ sistema: "windows", ejecutar: async () => ESTADO }).estado()).ocupada).toBe(false);
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
    sistema: "windows",
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
  const voz = new Voz({ sistema: "windows", ejecutar: f.ejecutar });
  await voz.dictar(3);
  await voz.leer("Prueba con «comillas» y 'apóstrofos'");
  await new Voz({ sistema: "windows", ejecutar: f.ejecutar, ajustes: () => ({ voz: "Microsoft Helena Desktop", velocidad: 30 }) }).leer("Otra prueba");
  for (const script of f.scripts) {
    const b64 = Buffer.from(script, "utf8").toString("base64");
    const comprobar = `$errores = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')), [ref]$null, [ref]$errores)
ConvertTo-Json -Compress @{ errores = @($errores | ForEach-Object { $_.Message }) }`;
    const salida = await ejecutarPowershell(comprobar, new AbortController().signal);
    expect(JSON.parse(salida.trim()).errores).toEqual([]);
  }
}, 60_000);

test("Windows: la voz elegida y la velocidad van al script (el nombre en base64)", async () => {
  const f = falso(() => JSON.stringify({ ok: true }));
  const voz = new Voz({ sistema: "windows", ejecutar: f.ejecutar, ajustes: () => ({ voz: "Microsoft Pablo", velocidad: 50 }) });
  await voz.leer("hola");
  const s = f.scripts[0]!;
  expect(s).toContain(`FromBase64String('${Buffer.from("Microsoft Pablo").toString("base64")}')`);
  expect(s).toContain("$s.Rate = 5");
  await new Voz({ sistema: "windows", ejecutar: f.ejecutar, ajustes: () => ({ velocidad: -50 }) }).leer("hola");
  expect(f.scripts[1]).toContain("$s.Rate = -5");
});

const SAY = `Albert              en_US    # Hello! My name is Albert.
Eddy (Español (España)) es_ES    # ¡Hola! Me llamo Eddy.
Jorge               es_ES    # ¡Hola! Me llamo Jorge.
Mónica              es_ES    # ¡Hola! Me llamo Mónica.
Paulina             es_MX    # ¡Hola! Me llamo Paulina.
línea rara sin idioma`;

test("Mac: voces de say, las de español primero, y cuál se usa", () => {
  const voces = vocesDeSay(SAY);
  expect(voces).toContainEqual({ nombre: "Eddy (Español (España))", idioma: "es-ES" });
  expect(voces).toHaveLength(5);
  expect(ordenarVoces(voces).map((v) => v.nombre)).toEqual(["Eddy (Español (España))", "Jorge", "Mónica", "Paulina", "Albert"]);
  expect(vozParaLeer(voces, "Mónica")).toBe("Mónica");
  expect(vozParaLeer(voces, "No existe")).toBe("Eddy (Español (España))");
  expect(vozParaLeer(vocesDeSay("Albert              en_US    # Hello!"))).toBeUndefined();
});

test("Mac: leer con say (voz, velocidad y el texto por fichero) y dictar con aquiles-dictado", async () => {
  const ordenes: string[][] = [];
  const leidos: string[] = [];
  const voz = new Voz({
    sistema: "mac",
    dictado: import.meta.path,
    ajustes: () => ({ voz: "Mónica", velocidad: 25 }),
    lanzar: async (orden) => {
      ordenes.push(orden);
      if (orden[1] === "-v" && orden[2] === "?") return SAY;
      if (orden[0] === "say") leidos.push(await Bun.file(orden.at(-1)!).text());
      if (orden[0] === import.meta.path) return JSON.stringify({ texto: " hola desde el Mac ", idioma: "es-ES" });
      return "";
    },
  });
  const e = await voz.estado();
  expect(e).toMatchObject({ dictado: true, idiomaDictado: "es-ES", lectura: true });
  expect(e.voces[0]).toEqual({ nombre: "Eddy (Español (España))", idioma: "es-ES" });

  await voz.leer("-rf **hola** «Mac»");
  const say = ordenes.find((o) => o[0] === "say" && o.includes("-f"))!;
  expect(say.slice(0, 5)).toEqual(["say", "-v", "Mónica", "-r", "225"]);
  expect(leidos).toEqual(["-rf hola «Mac»"]);
  expect(await Bun.file(say.at(-1)!).exists()).toBe(false);

  expect(await voz.dictar(8)).toBe("hola desde el Mac");
  expect(ordenes.at(-1)).toEqual([import.meta.path, "8", "es-ES"]);
});

test("Mac: sin aquiles-dictado no hay dictado; los errores del dictado se explican", async () => {
  const sinAyudante = new Voz({ sistema: "mac", dictado: "/no/existe/aquiles-dictado", lanzar: async () => SAY });
  expect((await sinAyudante.estado()).dictado).toBe(false);
  await expect(sinAyudante.dictar()).rejects.toThrow("no trae el dictado de macOS");

  const sinPermiso = new Voz({ sistema: "mac", dictado: import.meta.path, lanzar: async () => JSON.stringify({ error: "sin-permiso-microfono" }) });
  await expect(sinPermiso.dictar()).rejects.toThrow("Privacidad y seguridad › Micrófono");
  const parar = new Voz({
    sistema: "mac",
    dictado: import.meta.path,
    lanzar: (_o, senal) => new Promise((_r, rechazar) => senal.addEventListener("abort", () => rechazar(new Error("matado")), { once: true })),
  });
  const dictando = parar.dictar();
  await Bun.sleep(5);
  parar.parar();
  expect(await dictando).toBe("");
});

test("en otros sistemas no hay voz", async () => {
  const voz = new Voz({ sistema: "ninguno" });
  expect(await voz.estado()).toEqual({ dictado: false, lectura: false, voces: [], ocupada: false });
  await expect(voz.dictar()).rejects.toThrow("solo está en Windows y Mac");
});
