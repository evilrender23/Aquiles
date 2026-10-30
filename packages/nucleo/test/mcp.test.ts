/**
 * Cliente MCP contra un servidor de prueba hecho con el propio SDK. Este mismo fichero es el servidor
 * cuando se lanza con AQUILES_MCP_PRUEBA=servidor (así no hace falta otro fichero que bun test tome por tests).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ErrorHerramienta } from "../src/herramientas/herramienta";
import { ClienteMcp, nombreHerramientaMcp, textoResultadoMcp } from "../src/mcp";

if (process.env.AQUILES_MCP_PRUEBA === "servidor") {
  const servidor = new McpServer({ name: "prueba", version: "1.0.0" });
  const texto = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  servidor.registerTool("eco", { description: "Devuelve el texto", inputSchema: { texto: z.string() } }, async ({ texto: t }) => texto(`eco: ${t}`));
  servidor.registerTool("fallar", { description: "Siempre falla" }, async () => ({ ...texto("algo salió mal"), isError: true }));
  servidor.registerTool("imagen", { description: "Texto e imagen" }, async () => ({
    content: [
      { type: "text" as const, text: "aquí va" },
      { type: "image" as const, data: Buffer.alloc(3000).toString("base64"), mimeType: "image/png" },
    ],
  }));
  servidor.registerTool("pid", { description: "Pid del servidor" }, async () => texto(String(process.pid)));
  servidor.registerTool("entorno", { description: "Lee PRUEBA_VAR" }, async () => texto(process.env.PRUEBA_VAR ?? "(nada)"));
  servidor.registerTool("ampliar", { description: "Añade la herramienta extra" }, async () => {
    servidor.registerTool("extra", { description: "Recién llegada" }, async () => texto("extra"));
    return texto("ampliado");
  });
  servidor.registerTool("morir", { description: "Termina el proceso" }, async () => process.exit(1));
  await servidor.connect(new StdioServerTransport());
} else {
  const { afterAll, beforeAll, expect, test } = await import("bun:test");
  const { carpetaTemporal, contextoPrueba, vivo } = await import("./contexto-prueba");

  const config = (nombre: string) => ({
    nombre,
    comando: process.execPath,
    args: [import.meta.path],
    env: { AQUILES_MCP_PRUEBA: "servidor", PRUEBA_VAR: "secreto" },
  });
  const esperar = async (cond: () => boolean, ms = 10_000) => {
    const fin = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > fin) throw new Error("tiempo agotado esperando la condición");
      await Bun.sleep(25);
    }
  };

  let tmp: Awaited<ReturnType<typeof carpetaTemporal>>;
  beforeAll(async () => {
    tmp = await carpetaTemporal("mcp");
  });
  afterAll(() => tmp.borrar());

  test("nombres saneados a [a-zA-Z0-9_-] y 64 caracteres", () => {
    expect(nombreHerramientaMcp("fs", "leer.fichero ya")).toBe("mcp__fs__leer_fichero_ya");
    const largo = nombreHerramientaMcp("servidor-con-nombre-largo", "x".repeat(80));
    expect(largo.length).toBe(64);
    expect(largo).toMatch(/^mcp__servidor-con-nombre-largo__x+$/);
  });

  test("resultado: texto de los bloques text y una línea por imagen o recurso", () => {
    const r = textoResultadoMcp({
      content: [
        { type: "text", text: "hola" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "resource_link", uri: "file:///a.txt", name: "a.txt" },
        { type: "resource", resource: { uri: "file:///b.md", mimeType: "text/markdown", text: "# b" } },
      ],
    });
    expect(r).toBe("hola\n[imagen image/png, 3 B]\n[recurso a.txt: file:///a.txt]\n[recurso file:///b.md (text/markdown)]");
    expect(textoResultadoMcp({ content: [], structuredContent: { a: 1 } })).toContain('"a": 1');
    expect(textoResultadoMcp({ content: [] })).toBe("(sin resultado)");
  });

  test("configuración: exactamente uno de comando o url, y nombre válido", async () => {
    const mcp = new ClienteMcp({ ruta: null });
    await expect(mcp.guardar({ nombre: "a", comando: "x", url: "http://localhost:1/mcp" })).rejects.toThrow("no los dos");
    await expect(mcp.guardar({ nombre: "a" })).rejects.toThrow("Falta «comando»");
    await expect(mcp.guardar({ nombre: "Con Espacios", comando: "x" })).rejects.toThrow("no válido");
    await expect(mcp.guardar({ nombre: "a", url: "ftp://x" })).rejects.toThrow("http o https");
    expect(mcp.listar()).toEqual([]);
  });

  test("conecta por stdio, lista, llama, da errores, avisa de list_changed, reconecta y se detiene", async () => {
    const ruta = join(tmp.dir, "perfil", "mcp.json");
    let avisos = 0;
    const mcp = new ClienteMcp({ ruta, alCambiar: () => avisos++ });
    const info = await mcp.guardar(config("prueba"));
    expect(info.error).toBeUndefined();
    expect(info.estado).toBe("conectado");
    expect(info.tipo).toBe("stdio");
    expect(info.env).toEqual(["AQUILES_MCP_PRUEBA", "PRUEBA_VAR"]);
    expect(info.herramientas.map((h) => h.nombre)).toContain("eco");
    expect(avisos).toBeGreaterThan(0);

    // El env se guarda con sus valores; listar solo da los nombres.
    expect(JSON.parse(readFileSync(ruta, "utf8")).servidores.prueba.env.PRUEBA_VAR).toBe("secreto");
    expect(JSON.stringify(mcp.listar())).not.toContain("secreto");

    const ctx = contextoPrueba(tmp.dir);
    const h = (n: string) => {
      const r = mcp.herramientas().find((x) => x.nombre === `mcp__prueba__${n}`);
      if (!r) throw new Error(`falta ${n}`);
      return r;
    };
    const eco = h("eco");
    expect(eco.nivel).toBe("ejecucion");
    expect(eco.clavePermiso?.({ texto: "hola" })).toBe("mcp:prueba:eco");
    expect(eco.resumen?.({ texto: "hola" })).toBe('{"texto":"hola"}');
    expect(eco.resumen?.({ texto: "x".repeat(500) }).length).toBe(160);
    expect((eco.esquema!.properties as Record<string, unknown>).texto).toEqual({ type: "string" });
    expect(eco.parametros.safeParse({ texto: "hola" }).success).toBe(true);
    expect(await eco.ejecutar({ texto: "hola" }, ctx)).toBe("eco: hola");
    expect(await h("entorno").ejecutar({}, ctx)).toBe("secreto");
    expect(await h("imagen").ejecutar({}, ctx)).toBe("aquí va\n[imagen image/png, 3 KB]");

    // `expect(p).rejects` de Bun 1.4 se cuelga si la promesa espera la salida de un proceso hijo: se captura a mano.
    const fallo = await h("fallar").ejecutar({}, ctx).catch((e: unknown) => e);
    expect(fallo).toBeInstanceOf(ErrorHerramienta);
    expect((fallo as Error).message).toBe("algo salió mal");
    // Unos argumentos que el servidor rechaza también llegan como ErrorHerramienta.
    expect(await eco.ejecutar({ texto: 3 }, ctx).catch((e: unknown) => e)).toBeInstanceOf(ErrorHerramienta);

    // tools/list_changed: el servidor añade una herramienta y el cliente la ofrece sin reconectar.
    const antes = avisos;
    expect(await h("ampliar").ejecutar({}, ctx)).toBe("ampliado");
    await esperar(() => mcp.herramientas().some((x) => x.nombre === "mcp__prueba__extra"));
    expect(avisos).toBeGreaterThan(antes);
    expect(await h("extra").ejecutar({}, ctx)).toBe("extra");

    const pid1 = Number(await h("pid").ejecutar({}, ctx));
    const reconectado = await mcp.reconectar("prueba");
    expect(reconectado.estado).toBe("conectado");
    const pid2 = Number(await h("pid").ejecutar({}, ctx));
    expect(pid2).not.toBe(pid1);
    await esperar(() => !vivo(pid1));
    // La herramienta que ya tenía el turno sigue valiendo tras reconectar.
    expect(await eco.ejecutar({ texto: "otra vez" }, ctx)).toBe("eco: otra vez");

    // Si el servidor se cae, queda en error con un mensaje, y reconectar lo levanta.
    await h("morir").ejecutar({}, ctx).catch(() => {});
    await esperar(() => mcp.listar()[0]?.estado === "error");
    expect(mcp.listar()[0]?.error).toContain("se cerró");
    expect(mcp.herramientas()).toEqual([]);
    await expect(eco.ejecutar({ texto: "x" }, ctx)).rejects.toThrow("no está conectado");
    expect((await mcp.reconectar("prueba")).estado).toBe("conectado");

    // Desactivar desconecta y mata el proceso; persiste en disco.
    const pid3 = Number(await h("pid").ejecutar({}, ctx));
    const desactivado = await mcp.guardar({ nombre: "prueba", activo: false });
    expect(desactivado.estado).toBe("desconectado");
    expect(desactivado.comando).toBe(process.execPath);
    expect(desactivado.env).toEqual(["AQUILES_MCP_PRUEBA", "PRUEBA_VAR"]);
    await esperar(() => !vivo(pid3));
    await expect(mcp.reconectar("prueba")).rejects.toThrow("desactivado");

    // Otro cliente con el mismo fichero lo ve tal cual.
    const otro = new ClienteMcp({ ruta });
    expect(otro.listar()[0]).toMatchObject({ nombre: "prueba", activo: false, estado: "desconectado" });
    await mcp.borrar("prueba");
    expect(mcp.listar()).toEqual([]);
    expect(JSON.parse(readFileSync(ruta, "utf8")).servidores).toEqual({});
    await expect(mcp.borrar("prueba")).rejects.toThrow("No hay ningún servidor");
  }, 60_000);

  test("iniciar: un servidor que no arranca no impide conectar a los demás; detener mata los procesos", async () => {
    const ruta = join(tmp.dir, "varios", "mcp.json");
    const env = { AQUILES_MCP_PRUEBA: "servidor" };
    const servidores = {
      bueno: { comando: process.execPath, args: [import.meta.path], env, activo: true },
      roto: { comando: "programa-que-no-existe-aquiles", activo: true },
      apagado: { comando: process.execPath, args: [import.meta.path], env, activo: false },
      // Termina sin hablar MCP.
      mudo: { comando: process.execPath, args: ["-e", "console.error('me voy'); process.exit(2)"], activo: true },
      invalido: { comando: "x", url: "http://localhost/", activo: true },
    };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmp.dir, "varios"), { recursive: true });
    writeFileSync(ruta, JSON.stringify({ servidores }));
    const mcp = new ClienteMcp({ ruta, log: () => {} });
    await mcp.iniciar();
    const porNombre = Object.fromEntries(mcp.listar().map((s) => [s.nombre, s]));
    expect(Object.keys(porNombre)).toEqual(["apagado", "bueno", "mudo", "roto"]);
    expect(porNombre.bueno?.estado).toBe("conectado");
    expect(porNombre.apagado?.estado).toBe("desconectado");
    expect(porNombre.roto?.estado).toBe("error");
    expect(porNombre.roto?.error).toContain("No se encuentra «programa-que-no-existe-aquiles»");
    expect(porNombre.mudo?.estado).toBe("error");
    expect(porNombre.mudo?.error).toContain("me voy");

    const ctx = contextoPrueba(tmp.dir);
    const pid = Number(await mcp.herramientas().find((h) => h.nombre === "mcp__bueno__pid")!.ejecutar({}, ctx));
    await mcp.detener();
    expect(mcp.listar().every((s) => s.estado === "desconectado")).toBe(true);
    expect(mcp.herramientas()).toEqual([]);
    expect(vivo(pid)).toBe(false);
  }, 60_000);

  test("conecta por Streamable HTTP", async () => {
    const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
    const servidor = new McpServer({ name: "http", version: "1.0.0" });
    servidor.registerTool("suma", { description: "Suma", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }));
    const transporte = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
    await servidor.connect(transporte);
    const web = Bun.serve({ port: 0, fetch: (req) => transporte.handleRequest(req) });
    try {
      const mcp = new ClienteMcp({ ruta: null });
      const info = await mcp.guardar({ nombre: "remoto", url: `http://127.0.0.1:${web.port}/mcp` });
      expect(info).toMatchObject({ tipo: "http", estado: "conectado", url: `http://127.0.0.1:${web.port}/mcp` });
      expect(info.comando).toBeUndefined();
      const suma = mcp.herramientas().find((h) => h.nombre === "mcp__remoto__suma")!;
      expect(await suma.ejecutar({ a: 2, b: 3 }, contextoPrueba(tmp.dir))).toBe("5");
      await mcp.detener();
      expect(mcp.listar()[0]?.estado).toBe("desconectado");
    } finally {
      web.stop(true);
      await servidor.close();
    }
  }, 30_000);

  test.skipIf(process.platform !== "win32")("Windows: un comando .cmd (como npx) arranca y al detener no deja huérfanos", async () => {
    const cmd = join(tmp.dir, "servidor-prueba.cmd");
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${import.meta.path}"\r\n`);
    expect(existsSync(cmd)).toBe(true);
    const mcp = new ClienteMcp({ ruta: null });
    const info = await mcp.guardar({ nombre: "cmd", comando: cmd, env: { AQUILES_MCP_PRUEBA: "servidor" } });
    expect(info.error).toBeUndefined();
    const pid = Number(await mcp.herramientas().find((h) => h.nombre === "mcp__cmd__pid")!.ejecutar({}, contextoPrueba(tmp.dir)));
    expect(vivo(pid)).toBe(true);
    await mcp.detener();
    await esperar(() => !vivo(pid), 5000);
  }, 60_000);
}
