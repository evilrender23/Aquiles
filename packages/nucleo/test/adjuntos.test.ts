import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, truncateSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MAX_BYTES_ADJUNTO } from "@aquiles/protocolo";
import {
  bloqueAdjunto,
  ErrorAdjunto,
  guardarAdjuntos,
  infoAdjunto,
  LIMITES_API,
  leerAdjunto,
  MAX_CARACTERES,
  textoUsuario,
  verImagenes,
} from "../src/adjuntos";
import type { AdjuntoGuardado, Mensaje } from "../src/tipos";
import { pdf, png, zip } from "./ficheros-prueba";

let raiz = "";
let n = 0;
/** Carpeta de adjuntos nueva para cada prueba. */
const carpeta = () => join(raiz, `sesion-${++n}`);
const fichero = async (nombre: string, contenido: string | Uint8Array) => {
  const ruta = join(raiz, "origen", nombre);
  await mkdir(dirname(ruta), { recursive: true });
  await writeFile(ruta, contenido);
  return ruta;
};
const uno = async (nombre: string, contenido: string | Uint8Array, tipo?: string) =>
  (await guardarAdjuntos([{ nombre, ruta: await fichero(nombre, contenido), ...(tipo ? { tipo } : {}) }], carpeta()))[0]!;

beforeAll(async () => {
  raiz = await mkdtemp(join(tmpdir(), "aquiles-adjuntos-"));
});
afterAll(() => rm(raiz, { recursive: true, force: true }));

describe("guardar", () => {
  test("desde una ruta: copia el fichero en la carpeta de la sesión y saca el texto", async () => {
    const dir = carpeta();
    const ruta = await fichero("notas.md", "# Hola\nñandú");
    const [a] = await guardarAdjuntos([{ nombre: "notas.md", ruta }], dir);
    expect(a).toMatchObject({ nombre: "notas.md", tipo: "text/markdown", bytes: 14, clase: "texto", texto: "# Hola\nñandú" });
    expect(a!.id).toMatch(/^[0-9a-f]{12}$/);
    expect(a!.ruta).toBe(join(dir, `${a!.id}-notas.md`));
    expect(readFileSync(a!.ruta, "utf8")).toBe("# Hola\nñandú");
    expect(infoAdjunto(a!)).toEqual({ id: a!.id, nombre: "notas.md", tipo: "text/markdown", bytes: 14, clase: "texto", ruta: a!.ruta, caracteres: 12 });
  });

  test("desde base64 (también como data URL): las imágenes se reconocen por sus bytes y ganan extensión", async () => {
    const imagen = png(2, 2, [255, 0, 0]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const [captura, foto, otra] = await guardarAdjuntos(
      [
        { nombre: "captura", tipo: "image/png", datos: imagen.toString("base64") },
        { nombre: "foto.png", datos: `data:image/png;base64,${jpeg.toString("base64")}` },
        { nombre: "falsa.png", datos: Buffer.from("no soy una imagen").toString("base64") },
      ],
      carpeta(),
    );
    expect(captura).toMatchObject({ nombre: "captura", tipo: "image/png", clase: "imagen", bytes: imagen.length });
    expect(captura!.ruta.endsWith("-captura.png")).toBe(true);
    expect(captura!.texto).toBeUndefined();
    expect(readFileSync(captura!.ruta).equals(imagen)).toBe(true);
    expect(foto).toMatchObject({ tipo: "image/jpeg", clase: "imagen", bytes: 7 });
    // Dice ser PNG pero no lo es: no se manda como imagen.
    expect(otra?.clase).toBe("otro");
  });

  test("límites: tamaño, rutas que no valen y base64 roto", async () => {
    const grande = await fichero("grande.bin", "");
    truncateSync(grande, MAX_BYTES_ADJUNTO + 1);
    const fallo = (a: Parameters<typeof guardarAdjuntos>[0][number]) => guardarAdjuntos([a], carpeta()).then(() => undefined, (e) => e);
    const e1 = await fallo({ nombre: "grande.bin", ruta: grande });
    expect(e1).toBeInstanceOf(ErrorAdjunto);
    expect(e1.message).toContain("el máximo por adjunto es 25,0 MB");
    expect((await fallo({ nombre: "x.txt", datos: "A".repeat(Math.ceil((MAX_BYTES_ADJUNTO * 4) / 3) + 8) })).message).toContain("25,0 MB");
    expect((await fallo({ nombre: "x.txt", ruta: join(raiz, "no-existe.txt") })).message).toContain("No existe");
    expect((await fallo({ nombre: "x.txt", ruta: raiz })).message).toContain("no es un fichero");
    expect((await fallo({ nombre: "x.txt", ruta: "relativa.txt" })).message).toContain("absoluta");
    expect((await fallo({ nombre: "x.txt", datos: "esto no es base64!" })).message).toContain("base64");
  });

  test("nombres con rutas: se rechazan y no se guarda nada del mensaje", async () => {
    for (const nombre of ["../secreto.txt", "a/b.txt", "a\\b.txt", "C:x.txt", ".."]) {
      const dir = carpeta();
      const ok = { nombre: "bien.txt", datos: Buffer.from("hola").toString("base64") };
      const e = await guardarAdjuntos([ok, { nombre, datos: ok.datos }], dir).catch((x) => x);
      expect(e).toBeInstanceOf(ErrorAdjunto);
      expect(e.message).toContain("sin rutas");
      expect(existsSync(dir)).toBe(false);
    }
    // Lo que Windows no admite (o quita sin avisar) se cambia en el nombre en disco; el nombre original se conserva.
    const [a] = await guardarAdjuntos([{ nombre: 'informe: "final"?, v2.txt. ', datos: Buffer.from("x").toString("base64") }], carpeta());
    expect(a!.nombre).toBe('informe: "final"?, v2.txt. ');
    expect(basename(a!.ruta)).toBe(`${a!.id}-informe_ _final___ v2.txt`);
  });

  test("texto en UTF-16 con BOM y en latin1", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hola, ñandú", "utf16le")]);
    expect((await uno("utf16.txt", utf16)).texto).toBe("Hola, ñandú");
    // Lo que no es UTF-8 válido se lee como latin1 (windows-1252: 0x80 es el euro).
    expect((await uno("latin1.csv", Buffer.from([0x61, 0xf1, 0x6f, 0x3b, 0x80]))).texto).toBe("año;€");
    // Sin extensión, si parece texto, es texto.
    expect(await uno("LEEME", "léeme")).toMatchObject({ clase: "texto", tipo: "text/plain", texto: "léeme" });
  });

  test("recorta el texto a 100.000 caracteres y lo dice", async () => {
    const a = await uno("largo.log", "x".repeat(MAX_CARACTERES + 50));
    expect(a.texto!.startsWith("x".repeat(MAX_CARACTERES))).toBe(true);
    expect(a.texto).toContain("[Recortado: el texto entero tiene 100.050 caracteres y aquí van los 100.000 primeros.");
    expect(a.texto).toContain(a.ruta);
  });

  test("lo que no tiene texto llega como nota con el nombre, el tipo y la ruta", async () => {
    const a = await uno("datos.bin", new Uint8Array([0, 1, 2, 3, 0, 255]));
    expect(a).toMatchObject({ clase: "otro", tipo: "application/octet-stream" });
    expect(a.texto).toBeUndefined();
    expect(bloqueAdjunto(a)).toBe(
      `<adjunto nombre="datos.bin" tipo="application/octet-stream" ruta="${a.ruta}">\n` +
        "No hay texto extraído de este fichero. Está guardado en esa ruta: usa tus herramientas si necesitas leerlo.\n</adjunto>",
    );
  });

  test("adjuntos.leer: el fichero guardado en base64, solo por su id", async () => {
    const dir = carpeta();
    const [a] = await guardarAdjuntos([{ nombre: "captura", datos: png(1, 1, [0, 0, 0]).toString("base64") }], dir);
    expect(await leerAdjunto(dir, a!.id)).toEqual({ tipo: "image/png", datos: png(1, 1, [0, 0, 0]).toString("base64") });
    expect(await leerAdjunto(dir, "../../algo")).toBeUndefined();
    expect(await leerAdjunto(dir, "0123456789ab")).toBeUndefined();
  });
});

describe("extraer texto de documentos", () => {
  test("Word: párrafos, tabulaciones y tablas; sin repetir los cuadros de texto", async () => {
    const ruta = join(raiz, "origen", "informe.docx");
    await zip(ruta, {
      "word/document.xml":
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w" xmlns:mc="mc"><w:body>' +
        '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Hola</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">mundo &amp; más</w:t></w:r></w:p>' +
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p><w:p><w:r><w:t>sigue</w:t></w:r></w:p></w:tc></w:tr>" +
        "<w:tr><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
        "<w:p><w:r><mc:AlternateContent><mc:Choice><w:t>caja</w:t></mc:Choice><mc:Fallback><w:t>caja</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>" +
        "<w:p><w:r><w:t>Fin</w:t><w:br/><w:t>línea</w:t></w:r></w:p></w:body></w:document>",
    });
    const [a] = await guardarAdjuntos([{ nombre: "informe.docx", ruta }], carpeta());
    expect(a).toMatchObject({ clase: "documento", tipo: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(a!.texto).toBe("Hola\tmundo & más\n\nA1\tB1 sigue\n\tB2\n\ncaja\nFin\nlínea");
  });

  test("Excel: hojas en orden, cadenas compartidas y filas con tabuladores", async () => {
    const ruta = join(raiz, "origen", "cuentas.xlsx");
    await zip(ruta, {
      "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Ventas" sheetId="1" r:id="rId1"/><sheet name="Notas &amp; más" sheetId="2" r:id="rId2"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t>Producto</t></si><si><t>Precio</t></si><si><r><t>Ca</t></r><r><t>fé</t></r><rPh><t>カ</t></rPh></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><f>1+0.5</f><v>1.5</v></c><c r="D2" t="inlineStr"><is><t>x</t></is></c></row>' +
        '<row r="3"><c r="C3" t="b"><v>1</v></c></row><row r="4"><c r="A4"/></row></sheetData></worksheet>',
      "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>nota</t></is></c></row></sheetData></worksheet>',
    });
    const [a] = await guardarAdjuntos([{ nombre: "cuentas.xlsx", ruta }], carpeta());
    expect(a!.texto).toBe("[Hoja: Ventas]\nProducto\tPrecio\nCafé\t1.5\t\tx\n\t\tVERDADERO\n\n[Hoja: Notas & más]\nnota");
  });

  test("PowerPoint: por diapositiva y en su orden", async () => {
    const diapositiva = (texto: string) =>
      `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:pPr><a:tabLst><a:tab pos="0"/></a:tabLst></a:pPr><a:r><a:t>${texto}</a:t></a:r></a:p>` +
      "<a:p><a:r><a:t>Punto uno</a:t></a:r><a:br/><a:r><a:t>Punto dos</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>";
    const ruta = join(raiz, "origen", "charla.pptx");
    await zip(ruta, {
      "ppt/slides/slide10.xml": diapositiva("Décima"),
      "ppt/slides/slide1.xml": diapositiva("Título"),
      "ppt/slides/slide2.xml": diapositiva("Segunda"),
      "ppt/slides/_rels/slide1.xml.rels": "<Relationships/>",
    });
    const [a] = await guardarAdjuntos([{ nombre: "charla.pptx", ruta }], carpeta());
    const cuerpo = "Punto uno\nPunto dos";
    expect(a!.texto).toBe(`[Diapositiva 1]\nTítulo\n${cuerpo}\n\n[Diapositiva 2]\nSegunda\n${cuerpo}\n\n[Diapositiva 10]\nDécima\n${cuerpo}`);
  });

  test("ODT: párrafos, espacios de text:s y tablas", async () => {
    const ruta = join(raiz, "origen", "carta.odt");
    await zip(ruta, {
      "content.xml":
        '<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb" xmlns:style="s"><office:automatic-styles><style:style><style:tab-stops><style:tab-stop/></style:tab-stops></style:style></office:automatic-styles>' +
        '<office:body><office:text>\n  <text:h>Título</text:h>\n  <text:p>Uno<text:s text:c="2"/>dos<text:tab/>tres</text:p>\n' +
        "<table:table><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>" +
        "</office:text></office:body></office:document-content>",
    });
    const [a] = await guardarAdjuntos([{ nombre: "carta.odt", ruta }], carpeta());
    expect(a!.texto).toBe("Título\nUno  dos\ttres\na\tb");
  });

  test("PDF: el texto de cada página", async () => {
    const a = await uno("manual.pdf", pdf([["Hola desde un PDF", "Segunda linea"], ["Otra pagina"]]));
    expect(a).toMatchObject({ clase: "documento", tipo: "application/pdf" });
    expect(a.texto).toBe("[Página 1]\nHola desde un PDF\nSegunda linea\n\n[Página 2]\nOtra pagina");
    expect((await uno("una.pdf", pdf([["Solo una"]]))).texto).toBe("Solo una");
    // Pegado o soltado en la app: llega en base64 (Buffer de Node, que pdf.js rechaza si no se copia).
    const [pegado] = await guardarAdjuntos([{ nombre: "pegado.pdf", datos: pdf([["Desde base64"]]).toString("base64") }], carpeta());
    expect(pegado!.texto).toBe("Desde base64");
  });

  test("un documento roto no falla: se queda sin texto", async () => {
    const a = await uno("roto.docx", "esto no es un zip");
    expect(a.clase).toBe("documento");
    expect(a.texto).toBeUndefined();
    expect(readdirSync(dirname(a.ruta))).toHaveLength(1);
  });
});

describe("lo que ve el modelo", () => {
  const imagen = (id: string, bytes = 100): AdjuntoGuardado => ({ id, nombre: `${id}.png`, tipo: "image/png", bytes, clase: "imagen", ruta: join(raiz, `${id}.png`) });
  const usuario = (...adjuntos: AdjuntoGuardado[]): Mensaje => ({ rol: "usuario", texto: "mira", adjuntos });

  test("texto del usuario, después los adjuntos; las imágenes, según se vean o no", async () => {
    const doc: AdjuntoGuardado = { id: "d", nombre: 'a "b".txt', tipo: "text/plain", bytes: 3, clase: "texto", ruta: "C:\\x\\d-a.txt", texto: "abc" };
    const foto = imagen("f");
    expect(textoUsuario({ texto: "hola", adjuntos: [doc, foto] })).toBe(
      `hola\n\n<adjunto nombre="a &quot;b&quot;.txt" tipo="text/plain" ruta="C:\\x\\d-a.txt">\nabc\n</adjunto>\n\n` +
        `<adjunto nombre="f.png" tipo="image/png" ruta="${foto.ruta}">\nImagen que no puedes ver desde aquí. Está guardada en esa ruta: usa tus herramientas si necesitas algo de ella.\n</adjunto>`,
    );
    expect(textoUsuario({ texto: "", adjuntos: [foto] }, new Map([["f", "adjunta"]]))).toBe(
      `<adjunto nombre="f.png" tipo="image/png" ruta="${foto.ruta}">\nImagen adjunta a este mensaje.\n</adjunto>`,
    );
  });

  test("solo van enteras las imágenes de los últimos mensajes, que existan y que quepan", async () => {
    for (const id of ["m1", "m2", "m3", "m4", "m5", "grande"]) await writeFile(join(raiz, `${id}.png`), "x");
    const mensajes: Mensaje[] = [
      usuario(imagen("m1")),
      usuario(imagen("m2")),
      { rol: "asistente", texto: "vale", llamadas: [] },
      usuario(imagen("m3")),
      usuario(imagen("m4"), imagen("perdida")),
      usuario(imagen("m5"), imagen("grande", LIMITES_API.maxBytesImagen + 1)),
      { rol: "usuario", texto: "sin imágenes" },
    ];
    const vistas = verImagenes(mensajes, LIMITES_API);
    expect(Object.fromEntries(vistas)).toEqual({ m1: "antigua", m2: "adjunta", m3: "adjunta", m4: "adjunta", perdida: "perdida", m5: "adjunta", grande: "grande" });
    expect(Object.fromEntries(verImagenes(mensajes, { ...LIMITES_API, maxImagenes: 2 }))).toMatchObject({ m5: "adjunta", m4: "adjunta", m3: "limite" });
  });
});
