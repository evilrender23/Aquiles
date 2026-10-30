import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codigosError, RUTA_RPC } from "@aquiles/protocolo";
import { Document, ImageRun, Packer, Paragraph } from "docx";
import { FicheroYaExiste } from "../src/artefactos";
import { docxAHtml, exportarDocumento, leerDocumento, markdownADocx } from "../src/documentos";
import { escribirDocumento } from "../src/herramientas/documento";
import { ErrorHerramienta } from "../src/herramientas/herramienta";
import { leer } from "../src/herramientas/leer";
import { ProveedorSimulado } from "../src/proveedores/simulado";
import { iniciarServidor, type Servidor } from "../src/servidor";
import { carpetaTemporal, contextoPrueba } from "./contexto-prueba";
import { png, zip } from "./ficheros-prueba";

const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

let dir = "";
let borrar = async () => {};
beforeAll(async () => {
  ({ dir, borrar } = await carpetaTemporal("documentos"));
});
afterAll(() => borrar());

const RICO = `# Informe trimestral

Un párrafo con **negrita**, *cursiva*, ~~tachado~~, \`código\` y un [enlace](https://example.com/informe).

## Listas

- uno
- dos
  - dos punto uno
    1. muy dentro
- tres

3. empieza en tres
4. sigue en cuatro

- [x] hecha
- [ ] pendiente

> Una cita con **fuerza**.

\`\`\`ts
const x = 1;
if (x) {
  return;
}
\`\`\`

| Nombre | Valor |
|:--|--:|
| alfa | 1 |
| beta | **2** |

---

Texto con nota[^n].

[^n]: Lo que dice la nota.
`;

describe("markdown → Word → HTML", () => {
  test("el .docx lleva el texto y la estructura del markdown", async () => {
    const bytes = await markdownADocx(RICO);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("PK");
    const html = await docxAHtml(bytes);
    expect(html).toContain("<h1>Informe trimestral</h1>");
    expect(html).toContain("<h2>Listas</h2>");
    expect(html).toContain("<strong>negrita</strong>");
    expect(html).toContain("<em>cursiva</em>");
    expect(html).toContain("<s>tachado</s>");
    expect(html).toContain("<code>código</code>");
    expect(html).toContain('<a href="https://example.com/informe">enlace</a>');
    // Anidadas: una numerada dentro de una de viñetas dentro de otra.
    expect(html).toContain("<ul><li>uno</li><li>dos<ul><li>dos punto uno<ol><li>muy dentro</li></ol></li></ul></li><li>tres</li></ul>");
    expect(html).toContain("<ol><li>empieza en tres</li><li>sigue en cuatro</li></ol>");
    expect(html).toContain("<li>☑ hecha</li><li>☐ pendiente</li>");
    expect(html).toContain("<blockquote><p>Una cita con <strong>fuerza</strong>.</p></blockquote>");
    expect(html).toContain("<pre>const x = 1;<br />if (x) {<br />  return;<br />}</pre>");
    expect(html).toContain("<thead><tr><th><p><strong>Nombre</strong></p></th><th><p><strong>Valor</strong></p></th></tr></thead>");
    expect(html).toContain("<tbody><tr><td><p>alfa</p></td><td><p>1</p></td></tr>");
    expect(html).toContain('<li id="footnote-1"><p>Lo que dice la nota.');
  });

  test("la numeración respeta el número de inicio, y cada lista numerada vuelve a empezar", async () => {
    // El .docx es un zip: el tar de Windows (bsdtar) lo abre.
    const destino = join(dir, "numeracion");
    await mkdir(destino, { recursive: true });
    await writeFile(join(destino, "n.docx"), await markdownADocx("3. tres\n4. cuatro\n\n- corte\n\n1. otra\n"));
    const tar = Bun.spawn([TAR, "-x", "-f", "n.docx", "word/numbering.xml", "word/document.xml"], { cwd: destino, stdout: "ignore", stderr: "ignore" });
    expect(await tar.exited).toBe(0);
    const numeracion = await readFile(join(destino, "word", "numbering.xml"), "utf8");
    const documento = await readFile(join(destino, "word", "document.xml"), "utf8");
    expect(numeracion).toContain('<w:startOverride w:val="3"/>');
    const ids = [...documento.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe(ids[1]!);
    expect(new Set(ids).size).toBe(3);
  });

  test("markdown vacío: un documento válido sin texto", async () => {
    expect(await docxAHtml(await markdownADocx(""))).toBe("");
  });

  test("las imágenes de un .docx llegan incrustadas en el HTML", async () => {
    const doc = new Document({
      sections: [{ children: [new Paragraph({ children: [new ImageRun({ type: "png", data: png(4, 4, [200, 30, 30]), transformation: { width: 4, height: 4 } })] })] }],
    });
    expect(await docxAHtml(await Packer.toBuffer(doc))).toContain('<img src="data:image/png;base64,');
  });

  test("un fichero que no es un .docx da un error claro", async () => {
    await expect(docxAHtml(new TextEncoder().encode("no soy un zip"))).rejects.toThrow("No se pudo leer el documento de Word");
  });
});

describe("leerDocumento", () => {
  test(".md tal cual (sin BOM), y .txt también como markdown", async () => {
    await writeFile(join(dir, "notas.md"), "﻿# Notas\r\n\n- uno\n");
    expect(await leerDocumento(join(dir, "notas.md"))).toEqual({ nombre: "notas.md", formato: "markdown", contenido: "# Notas\r\n\n- uno\n" });
    await writeFile(join(dir, "léeme.txt"), "texto");
    expect(await leerDocumento(join(dir, "léeme.txt"))).toMatchObject({ formato: "markdown", contenido: "texto" });
  });

  test(".docx convertido a HTML, también uno que no hizo Aquiles", async () => {
    await writeFile(join(dir, "propio.docx"), await markdownADocx("# Hola\n\nmundo"));
    expect(await leerDocumento(join(dir, "propio.docx"))).toEqual({ nombre: "propio.docx", formato: "html", contenido: "<h1>Hola</h1><p>mundo</p>" });

    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    await zip(join(dir, "ajeno.docx"), {
      "[Content_Types].xml":
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "_rels/.rels":
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      "word/document.xml":
        `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>` +
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Acta</w:t></w:r></w:p>' +
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Asistentes</w:t></w:r><w:r><w:t xml:space="preserve"> y orden del día</w:t></w:r></w:p>' +
        "</w:body></w:document>",
    });
    expect((await leerDocumento(join(dir, "ajeno.docx"))).contenido).toBe("<h1>Acta</h1><p><strong>Asistentes</strong> y orden del día</p>");
  });

  test("rechaza rutas relativas, otros formatos y lo que no existe", async () => {
    await expect(leerDocumento("notas.md")).rejects.toThrow("absoluta");
    await writeFile(join(dir, "hoja.xlsx"), "x");
    await expect(leerDocumento(join(dir, "hoja.xlsx"))).rejects.toThrow("no es un documento que se pueda ver");
    await expect(leerDocumento(join(dir, "no-existe.md"))).rejects.toThrow("No existe");
    await mkdir(join(dir, "carpeta.md"), { recursive: true });
    await expect(leerDocumento(join(dir, "carpeta.md"))).rejects.toThrow("no es un fichero");
  });
});

describe("exportarDocumento", () => {
  test("escribe <cwd>/<nombre>.docx; si existe, FicheroYaExiste salvo con sobrescribir", async () => {
    const ruta = await exportarDocumento(dir, "resumen", "# Resumen\n\nuno");
    expect(ruta).toBe(join(dir, "resumen.docx"));
    expect(await docxAHtml(readFileSync(ruta))).toBe("<h1>Resumen</h1><p>uno</p>");
    await expect(exportarDocumento(dir, "resumen.docx", "# Otro")).rejects.toBeInstanceOf(FicheroYaExiste);
    await exportarDocumento(dir, "resumen.docx", "# Otro", true);
    expect(await docxAHtml(readFileSync(ruta))).toBe("<h1>Otro</h1>");
    await expect(exportarDocumento(dir, "../fuera", "x")).rejects.toThrow("Nombre de fichero no válido");
  });
});

describe("escribir_documento", () => {
  test(".docx: convierte el markdown, crea las carpetas y deja reescribir lo que escribió", async () => {
    const ctx = contextoPrueba(dir);
    expect(await escribirDocumento.ejecutar({ ruta: "informes/q3.docx", contenido: RICO }, ctx)).toMatch(/^Escrito informes\/q3\.docx \(documento de Word, \d+ KB\)$/);
    const html = await docxAHtml(readFileSync(join(dir, "informes", "q3.docx")));
    expect(html).toContain("<h1>Informe trimestral</h1>");
    expect(html).toContain("<table>");
    await escribirDocumento.ejecutar({ ruta: "informes/q3.docx", contenido: "# Versión 2" }, ctx);
    expect(await docxAHtml(readFileSync(join(dir, "informes", "q3.docx")))).toBe("<h1>Versión 2</h1>");
  });

  test(".docx: no sustituye uno que no escribió en la sesión, ni uno que cambió después", async () => {
    await writeFile(join(dir, "del-usuario.docx"), await markdownADocx("# Del usuario"));
    const ctx = contextoPrueba(dir);
    const e = escribirDocumento.ejecutar({ ruta: "del-usuario.docx", contenido: "# Pisado" }, ctx);
    await expect(e).rejects.toBeInstanceOf(ErrorHerramienta);
    await expect(escribirDocumento.ejecutar({ ruta: "del-usuario.docx", contenido: "# Pisado" }, ctx)).rejects.toThrow("ya existe");
    expect(await docxAHtml(readFileSync(join(dir, "del-usuario.docx")))).toBe("<h1>Del usuario</h1>");

    await escribirDocumento.ejecutar({ ruta: "mio.docx", contenido: "# Mío" }, ctx);
    await writeFile(join(dir, "mio.docx"), await markdownADocx("# Lo cambió el usuario"));
    await expect(escribirDocumento.ejecutar({ ruta: "mio.docx", contenido: "# Pisado" }, ctx)).rejects.toThrow("ya existe");
  });

  test(".md: se escribe tal cual, con las mismas reglas que escribir", async () => {
    const ctx = contextoPrueba(dir);
    expect(await escribirDocumento.ejecutar({ ruta: "guia.md", contenido: "# Guía\n\n- paso\n" }, ctx)).toBe("Escrito guia.md (3 líneas)");
    expect(await readFile(join(dir, "guia.md"), "utf8")).toBe("# Guía\n\n- paso\n");

    await writeFile(join(dir, "ajena.md"), "de otro\n");
    await expect(escribirDocumento.ejecutar({ ruta: "ajena.md", contenido: "x" }, ctx)).rejects.toThrow("léelo antes de sobrescribirlo");
    await leer.ejecutar({ ruta: "ajena.md" }, ctx);
    await escribirDocumento.ejecutar({ ruta: "ajena.md", contenido: "nuevo\n" }, ctx);
    expect(await readFile(join(dir, "ajena.md"), "utf8")).toBe("nuevo\n");
  });

  test("otras extensiones: error que remite a escribir", async () => {
    await expect(escribirDocumento.ejecutar({ ruta: "datos.json", contenido: "{}" }, contextoPrueba(dir))).rejects.toThrow("usa escribir");
  });

  test("nivel escritura, con la ruta como resumen y como ruta tocada", () => {
    expect(escribirDocumento.nivel).toBe("escritura");
    expect(escribirDocumento.resumen?.({ ruta: "a.docx", contenido: "" })).toBe("a.docx");
    expect(escribirDocumento.rutas?.({ ruta: "a.docx", contenido: "" }, dir)).toEqual([join(dir, "a.docx")]);
  });
});

describe("servidor: documentos.leer y documentos.exportar", () => {
  const TOKEN = "token-de-prueba-documentos-01";
  let servidor: Servidor;
  let raiz = "";
  let borrarRaiz = async () => {};

  beforeAll(async () => {
    ({ dir: raiz, borrar: borrarRaiz } = await carpetaTemporal("srv-documentos"));
    servidor = iniciarServidor({
      puerto: 0, token: TOKEN, proveedor: "simulado", herramientas: [], cwdPorDefecto: raiz, version: "0.0.0", perfil: join(raiz, "perfil"),
      fabrica: () => new ProveedorSimulado([]),
    });
  });
  afterAll(async () => {
    await servidor.detener();
    await borrarRaiz();
  });

  async function llamar(method: string, params?: unknown): Promise<any> {
    const ws = new WebSocket(`ws://127.0.0.1:${servidor.puerto}${RUTA_RPC}?token=${TOKEN}`);
    await new Promise((ok, mal) => {
      ws.onopen = ok;
      ws.onerror = mal;
    });
    const r = await new Promise<any>((ok) => {
      ws.onmessage = (m) => {
        const d = JSON.parse(String(m.data));
        if (d.id === 1) ok(d);
      };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });
    ws.close();
    return r;
  }

  test("leer un .md y un .docx; lo que no se puede leer, paramsInvalidos", async () => {
    await writeFile(join(raiz, "a.md"), "# A");
    expect((await llamar("documentos.leer", { ruta: join(raiz, "a.md") })).result).toEqual({ nombre: "a.md", formato: "markdown", contenido: "# A" });
    await writeFile(join(raiz, "b.docx"), await markdownADocx("**B**"));
    expect((await llamar("documentos.leer", { ruta: join(raiz, "b.docx") })).result).toEqual({ nombre: "b.docx", formato: "html", contenido: "<p><strong>B</strong></p>" });
    expect((await llamar("documentos.leer", { ruta: "a.md" })).error.code).toBe(codigosError.paramsInvalidos);
    expect((await llamar("documentos.leer", { ruta: join(raiz, "nada.docx") })).error.code).toBe(codigosError.paramsInvalidos);
  });

  test("exportar a Word en la carpeta de la sesión; si existe, yaExiste", async () => {
    const s = (await llamar("sesion.crear", {})).result;
    const ok = await llamar("documentos.exportar", { sesionId: s.sesionId, nombre: "notas.docx", markdown: "# Notas" });
    expect(ok.result.ruta).toBe(join(raiz, "notas.docx"));
    expect(await docxAHtml(readFileSync(join(raiz, "notas.docx")))).toBe("<h1>Notas</h1>");
    const repetido = await llamar("documentos.exportar", { sesionId: s.sesionId, nombre: "notas.docx", markdown: "# Otras" });
    expect(repetido.error.code).toBe(codigosError.yaExiste);
    await llamar("documentos.exportar", { sesionId: s.sesionId, nombre: "notas.docx", markdown: "# Otras", sobrescribir: true });
    expect(await docxAHtml(readFileSync(join(raiz, "notas.docx")))).toBe("<h1>Otras</h1>");
    expect((await llamar("documentos.exportar", { sesionId: s.sesionId, nombre: "../fuera.docx", markdown: "x" })).error.code).toBe(codigosError.paramsInvalidos);
  });
});
