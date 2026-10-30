/** Ficheros de prueba hechos a mano: una imagen PNG, un PDF y documentos de Office (zip con el tar del sistema). */
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { guardarAdjuntos } from "../src/adjuntos";
import type { AdjuntoGuardado } from "../src/tipos";

const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (TABLA_CRC[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG de un solo color. */
export function png(ancho: number, alto: number, [r, g, b]: [number, number, number]): Buffer {
  const trozo = (tipo: string, datos: Buffer) => {
    const cuerpo = Buffer.concat([Buffer.from(tipo, "ascii"), datos]);
    const largo = Buffer.alloc(4);
    largo.writeUInt32BE(datos.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(cuerpo));
    return Buffer.concat([largo, cuerpo, crc]);
  };
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(ancho, 0);
  cabecera.writeUInt32BE(alto, 4);
  cabecera.set([8, 2, 0, 0, 0], 8);
  const fila = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: ancho }, () => [r, g, b]).flat())]);
  const pixeles = deflateSync(Buffer.concat(Array.from({ length: alto }, () => fila)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), trozo("IHDR", cabecera), trozo("IDAT", pixeles), trozo("IEND", Buffer.alloc(0))]);
}

/** PDF mínimo con Helvetica: una página por elemento, cada línea en su sitio (solo ASCII). */
export function pdf(paginas: string[][]): Buffer {
  const objetos = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const hojas: number[] = [];
  for (const lineas of paginas) {
    const contenido = `BT /F1 18 Tf 72 720 Td ${lineas.map((l, i) => `${i ? "0 -24 Td " : ""}(${l.replace(/[\\()]/g, "\\$&")}) Tj`).join(" ")} ET`;
    objetos.push(`<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`);
    objetos.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objetos.length} 0 R >>`);
    hojas.push(objetos.length);
  }
  objetos[1] = `<< /Type /Pages /Kids [${hojas.map((n) => `${n} 0 R`).join(" ")}] /Count ${hojas.length} >>`;
  let texto = "%PDF-1.4\n";
  const posiciones: number[] = [];
  objetos.forEach((o, i) => {
    posiciones.push(texto.length);
    texto += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = texto.length;
  texto += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${posiciones.map((p) => `${String(p).padStart(10, "0")} 00000 n \n`).join("")}`;
  texto += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(texto, "latin1");
}

/** Carpeta de los adjuntos de prueba de los proveedores; se vacía la primera vez en cada ejecución de los tests. */
const DIR_ADJUNTOS = join(tmpdir(), "aquiles-adjuntos-prueba");
let vaciada = false;

/** Una imagen PNG y una nota de texto ya guardadas, para ver qué recibe cada proveedor. */
export async function adjuntosDePrueba(): Promise<{ foto: AdjuntoGuardado; nota: AdjuntoGuardado }> {
  if (!vaciada) {
    await rm(DIR_ADJUNTOS, { recursive: true, force: true });
    vaciada = true;
  }
  const [foto, nota] = await guardarAdjuntos(
    [
      { nombre: "foto.png", datos: png(2, 2, [255, 0, 0]).toString("base64") },
      { nombre: "nota.txt", datos: Buffer.from("contenido de la nota").toString("base64") },
    ],
    DIR_ADJUNTOS,
  );
  return { foto: foto!, nota: nota! };
}

const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

/** Zip con estos ficheros (ruta → contenido), hecho con `tar -a -c`, en `destino`. */
export async function zip(destino: string, ficheros: Record<string, string>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "aquiles-zip-prueba-"));
  try {
    for (const [ruta, contenido] of Object.entries(ficheros)) {
      await mkdir(dirname(join(dir, "c", ruta)), { recursive: true });
      await writeFile(join(dir, "c", ruta), contenido);
    }
    const raices = [...new Set(Object.keys(ficheros).map((r) => r.split("/")[0] ?? r))];
    const p = Bun.spawn([TAR, "-a", "-c", "-f", join(dir, "doc.zip"), "-C", join(dir, "c"), ...raices], { stdout: "ignore", stderr: "pipe" });
    if ((await p.exited) !== 0) throw new Error(`tar: ${await new Response(p.stderr).text()}`);
    await rename(join(dir, "doc.zip"), destino);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
