/**
 * Zip sin depender del sistema: el tar de Windows y el de macOS (bsdtar) leen y escriben zip, pero el GNU tar de
 * Linux no. Lo justo para los documentos de Office (leer unos pocos miembros) y las copias de los perfiles
 * (comprimir y descomprimir una carpeta). Métodos «store» y «deflate»; sin zip64 (ficheros de menos de 4 GB) ni cifrado.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export class ErrorZip extends Error {}

const FIRMA_FIN = 0x06054b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_LOCAL = 0x04034b50;
/** Bit 11 de las banderas: el nombre va en UTF-8. */
const UTF8 = 0x0800;

export interface MiembroZip {
  /** Ruta dentro del zip, con «/» (sin «./» delante). */
  nombre: string;
  bytes: number;
  /** Descomprime el miembro; con `maxBytes`, falla si se infla de más (un zip pequeño puede esconder uno enorme). */
  leer(maxBytes?: number): Uint8Array;
}

/** Los ficheros de un zip (las carpetas no), sin descomprimir todavía. */
export function miembrosZip(zip: Uint8Array): MiembroZip[] {
  const vista = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // El registro de fin de directorio está al final, detrás de un comentario de hasta 64 KB.
  let fin = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (vista.getUint32(i, true) === FIRMA_FIN) {
      fin = i;
      break;
    }
  }
  if (fin < 0) throw new ErrorZip("No es un zip (no tiene directorio central)");
  const total = vista.getUint16(fin + 10, true);
  let p = vista.getUint32(fin + 16, true);
  if (p === 0xffffffff || total === 0xffff) throw new ErrorZip("Zip64 no está soportado");

  const decodificar = new TextDecoder();
  const miembros: MiembroZip[] = [];
  for (let n = 0; n < total; n++) {
    if (p + 46 > zip.length || vista.getUint32(p, true) !== FIRMA_CENTRAL) throw new ErrorZip("Directorio central dañado");
    const banderas = vista.getUint16(p + 8, true);
    const metodo = vista.getUint16(p + 10, true);
    const comprimido = vista.getUint32(p + 20, true);
    const tamano = vista.getUint32(p + 24, true);
    const largoNombre = vista.getUint16(p + 28, true);
    const largoExtra = vista.getUint16(p + 30, true);
    const largoComentario = vista.getUint16(p + 32, true);
    const local = vista.getUint32(p + 42, true);
    const nombre = decodificar
      .decode(zip.subarray(p + 46, p + 46 + largoNombre))
      .replaceAll("\\", "/")
      .replace(/^(\.\/)+/, "");
    p += 46 + largoNombre + largoExtra + largoComentario;
    if (!nombre || nombre.endsWith("/")) continue;
    miembros.push({
      nombre,
      bytes: tamano,
      leer(maxBytes = Number.POSITIVE_INFINITY) {
        if (banderas & 1) throw new ErrorZip(`${nombre} está cifrado`);
        if (local + 30 > zip.length || vista.getUint32(local, true) !== FIRMA_LOCAL) throw new ErrorZip(`Cabecera de ${nombre} dañada`);
        const inicio = local + 30 + vista.getUint16(local + 26, true) + vista.getUint16(local + 28, true);
        const datos = zip.subarray(inicio, inicio + comprimido);
        if (metodo === 0) {
          if (datos.length > maxBytes) throw new ErrorZip(`${nombre} pasa de ${maxBytes} bytes`);
          return datos;
        }
        if (metodo !== 8) throw new ErrorZip(`${nombre}: método de compresión ${metodo} no soportado`);
        try {
          return inflateRawSync(datos, Number.isFinite(maxBytes) ? { maxOutputLength: maxBytes } : {});
        } catch (e) {
          if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new ErrorZip(`${nombre} pasa de ${maxBytes} bytes descomprimido`);
          throw new ErrorZip(`${nombre} no se puede descomprimir: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
  }
  return miembros;
}

/** Miembros con ese nombre o que casan con el patrón (`*` vale cualquier cosa menos «/»). */
export function casa(nombre: string, patron: string): boolean {
  if (!patron.includes("*")) return nombre === patron;
  const re = new RegExp(`^${patron.split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  return re.test(nombre);
}

// ——— Escribir ———

interface Central {
  nombre: Uint8Array;
  crc: number;
  comprimido: number;
  tamano: number;
  metodo: number;
  hora: number;
  fecha: number;
  desplazamiento: number;
}

function horaDos(d: Date): { hora: number; fecha: number } {
  const anio = Math.max(1980, d.getFullYear());
  return {
    hora: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    fecha: ((anio - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Escribe un zip en `destino`, fichero a fichero (no hace falta tenerlo todo en memoria). */
export function escribirZip(destino: string, entradas: Iterable<{ nombre: string; datos: () => Uint8Array }>, ahora = new Date()): void {
  const fd = openSync(destino, "w");
  const centrales: Central[] = [];
  let posicion = 0;
  const escribir = (b: Uint8Array) => {
    writeSync(fd, b);
    posicion += b.length;
  };
  const { hora, fecha } = horaDos(ahora);
  try {
    for (const e of entradas) {
      const datos = e.datos();
      if (datos.length >= 0xffffffff) throw new ErrorZip(`${e.nombre} pasa de 4 GB`);
      const comprimido = deflateRawSync(datos);
      // Lo que no mengua (fotos, zips) se guarda tal cual.
      const [metodo, cuerpo] = comprimido.length < datos.length ? [8, comprimido] : [0, datos];
      const c: Central = { nombre: new TextEncoder().encode(e.nombre), crc: crc32(datos), comprimido: cuerpo.length, tamano: datos.length, metodo, hora, fecha, desplazamiento: posicion };
      const cab = new DataView(new ArrayBuffer(30));
      cab.setUint32(0, FIRMA_LOCAL, true);
      cab.setUint16(4, 20, true);
      cab.setUint16(6, UTF8, true);
      cab.setUint16(8, c.metodo, true);
      cab.setUint16(10, c.hora, true);
      cab.setUint16(12, c.fecha, true);
      cab.setUint32(14, c.crc, true);
      cab.setUint32(18, c.comprimido, true);
      cab.setUint32(22, c.tamano, true);
      cab.setUint16(26, c.nombre.length, true);
      escribir(new Uint8Array(cab.buffer));
      escribir(c.nombre);
      escribir(cuerpo);
      centrales.push(c);
    }
    const inicioCentral = posicion;
    for (const c of centrales) {
      const cab = new DataView(new ArrayBuffer(46));
      cab.setUint32(0, FIRMA_CENTRAL, true);
      cab.setUint16(4, 0x031e, true); // hecho en Unix, versión 3.0
      cab.setUint16(6, 20, true);
      cab.setUint16(8, UTF8, true);
      cab.setUint16(10, c.metodo, true);
      cab.setUint16(12, c.hora, true);
      cab.setUint16(14, c.fecha, true);
      cab.setUint32(16, c.crc, true);
      cab.setUint32(20, c.comprimido, true);
      cab.setUint32(24, c.tamano, true);
      cab.setUint16(28, c.nombre.length, true);
      cab.setUint32(38, (0o100644 << 16) >>> 0, true);
      cab.setUint32(42, c.desplazamiento, true);
      escribir(new Uint8Array(cab.buffer));
      escribir(c.nombre);
    }
    if (centrales.length >= 0xffff || posicion >= 0xffffffff) throw new ErrorZip("El zip es demasiado grande (zip64 no está soportado)");
    const finCab = new DataView(new ArrayBuffer(22));
    finCab.setUint32(0, FIRMA_FIN, true);
    finCab.setUint16(8, centrales.length, true);
    finCab.setUint16(10, centrales.length, true);
    finCab.setUint32(12, posicion - inicioCentral, true);
    finCab.setUint32(16, inicioCentral, true);
    escribir(new Uint8Array(finCab.buffer));
  } finally {
    closeSync(fd);
  }
}

/** Comprime una carpeta entera; `excluir` recibe la ruta relativa (con «/») y descarta ficheros o carpetas. */
export function comprimirCarpeta(origen: string, destino: string, excluir: (ruta: string) => boolean = () => false, ahora = new Date()): void {
  function* recorrer(dir: string): Generator<{ nombre: string; datos: () => Uint8Array }> {
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const ruta = join(dir, d.name);
      const nombre = relative(origen, ruta).split(sep).join("/");
      if (excluir(nombre)) continue;
      if (d.isDirectory()) yield* recorrer(ruta);
      else if (d.isFile()) yield { nombre, datos: () => readFileSync(ruta) };
    }
  }
  escribirZip(destino, recorrer(origen), ahora);
}

/** Descomprime todo el zip en `destino`; un nombre que intente salir de la carpeta («../») se rechaza. */
export function descomprimir(zip: string, destino: string): void {
  const raiz = resolve(destino);
  for (const m of miembrosZip(readFileSync(zip))) {
    const ruta = resolve(raiz, m.nombre);
    if (ruta !== raiz && !ruta.startsWith(raiz + sep)) throw new ErrorZip(`Nombre no válido en el zip: ${m.nombre}`);
    mkdirSync(dirname(ruta), { recursive: true });
    const fd = openSync(ruta, "w");
    try {
      writeSync(fd, m.leer());
    } finally {
      closeSync(fd);
    }
  }
}
