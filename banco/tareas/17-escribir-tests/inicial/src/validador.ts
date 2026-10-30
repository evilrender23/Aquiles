const LETRAS = "TRWAGMYFPDXBNJZSQVHLCKE";

/**
 * Valida un DNI (8 cifras y letra) o un NIE (X, Y o Z, 7 cifras y letra).
 * No distingue mayúsculas de minúsculas e ignora espacios y guiones.
 */
export function validarDocumento(documento: string): boolean {
  const limpio = documento.toUpperCase().replace(/[\s-]/g, "");
  const m = /^([XYZ]|\d)(\d{7})([A-Z])$/.exec(limpio);
  if (!m) return false;
  const inicial = "XYZ".indexOf(m[1]!);
  const numero = Number(`${inicial >= 0 ? inicial : m[1]}${m[2]}`);
  return LETRAS[numero % 23] === m[3];
}

/**
 * Normaliza un teléfono español a "+34XXXXXXXXX". Acepta el prefijo +34 o 0034 (opcional),
 * espacios, guiones y puntos. Devuelve null si no quedan 9 cifras que empiecen por 6, 7, 8 o 9.
 */
export function normalizarTelefono(telefono: string): string | null {
  let cifras = telefono.replace(/[\s.-]/g, "");
  if (cifras.startsWith("+34")) cifras = cifras.slice(3);
  else if (cifras.startsWith("0034")) cifras = cifras.slice(4);
  if (!/^[6-9]\d{8}$/.test(cifras)) return null;
  return `+34${cifras}`;
}
