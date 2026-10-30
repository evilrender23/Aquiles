/**
 * Convierte un texto CSV (RFC 4180) en filas de campos: campos entre comillas con separadores,
 * saltos de línea y comillas escapadas (`""`), y finales de línea LF o CRLF. Las líneas vacías se ignoran.
 */
export function parsearCsv(texto: string, separador = ","): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let entreComillas = false;
  let filaConDatos = false;

  const cerrarCampo = () => {
    fila.push(campo);
    campo = "";
  };
  const cerrarFila = () => {
    cerrarCampo();
    if (filaConDatos || fila.length > 1 || fila[0]!.trim() !== "") filas.push(fila);
    fila = [];
    filaConDatos = false;
  };

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (entreComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else entreComillas = false;
      } else campo += c;
    } else if (c === '"') {
      entreComillas = true;
      filaConDatos = true;
    } else if (texto.startsWith(separador, i)) {
      cerrarCampo();
      i += separador.length - 1;
    } else if (c === "\n" || (c === "\r" && texto[i + 1] === "\n")) {
      if (c === "\r") i++;
      cerrarFila();
    } else campo += c;
  }
  if (campo !== "" || fila.length > 0 || filaConDatos) cerrarFila();
  return filas;
}

export interface Cliente {
  nombre: string;
  email: string;
  ciudad: string;
  notas: string;
}

/** La primera fila es la cabecera; el orden de las columnas puede variar. */
export function leerClientes(texto: string, separador = ","): Cliente[] {
  const [cabecera, ...filas] = parsearCsv(texto, separador);
  if (!cabecera) return [];
  const columna = (fila: string[], nombre: string) => fila[cabecera.indexOf(nombre)] ?? "";
  return filas.map((f) => ({
    nombre: columna(f, "nombre"),
    email: columna(f, "email"),
    ciudad: columna(f, "ciudad"),
    notas: columna(f, "notas"),
  }));
}
