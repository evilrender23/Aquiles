/**
 * Proveedor de pruebas: responde con un guion fijo, sin red ni coste.
 * Cada paso recibe la petición y devuelve la respuesta; el texto se emite en trozos.
 */
import { ErrorAbortado, type PeticionModelo, type Proveedor, type RespuestaModelo } from "../tipos";

export type PasoSimulado = (p: PeticionModelo) => RespuestaModelo;

export class ProveedorSimulado implements Proveedor {
  readonly nombre = "simulado";
  readonly peticiones: PeticionModelo[] = [];
  private i = 0;

  constructor(private pasos: PasoSimulado[], private retardoMs = 0) {}

  async responder(p: PeticionModelo, alDelta: (texto: string) => void): Promise<RespuestaModelo> {
    this.peticiones.push({ ...p, mensajes: [...p.mensajes] });
    const paso = this.pasos[Math.min(this.i, this.pasos.length - 1)];
    this.i += 1;
    if (!paso) throw new Error("guion vacío");
    const r = paso(p);
    for (const trozo of r.texto.match(/.{1,8}/gs) ?? []) {
      if (p.senal.aborted) throw new ErrorAbortado();
      if (this.retardoMs) await Bun.sleep(this.retardoMs);
      alDelta(trozo);
    }
    if (p.senal.aborted) throw new ErrorAbortado();
    return { uso: { entrada: 1200, salida: 80 }, ...r };
  }
}

const FICHERO = /[\w./\\-]+\.\w{1,6}/;

/**
 * Guion de demostración para probar la interfaz sin gastar cuota. Según lo que pida el usuario:
 *   "edita X"      → lee X y le añade una línea (genera un diff)
 *   "ejecuta CMD"  → terminal (pide permiso)
 *   "pregunta"     → preguntar con opciones
 *   "tareas"       → lista de tareas
 *   "lee X"        → leer
 *   otra cosa      → una respuesta en markdown
 */
export function guionDemo(): PasoSimulado[] {
  return [
    (p) => {
      const ultimo = p.mensajes.at(-1);
      const pedido = [...p.mensajes].reverse().find((m) => m.rol === "usuario");
      const texto = pedido?.rol === "usuario" ? pedido.texto : "";
      const ruta = texto.match(FICHERO)?.[0] ?? "README.md";
      const id = `sim-${p.mensajes.length}`;

      if (ultimo?.rol === "herramienta") {
        if (/edita|cambia/i.test(texto) && ultimo.nombre === "leer" && !ultimo.error) {
          const contenido = ultimo.resultado
            .split("\n")
            .filter((l) => /^\d+\t/.test(l))
            .map((l) => l.replace(/^\d+\t/, ""))
            .join("\n");
          return { texto: "Añado una línea al final.", llamadas: [{ id, nombre: "escribir", argumentos: { ruta, contenido: `${contenido}\nLínea añadida por la demo.\n` } }] };
        }
        const lineas = ultimo.resultado.split("\n").length;
        return { texto: ultimo.error ? `No ha salido bien:\n\n> ${ultimo.resultado.split("\n")[0]}` : `Hecho: \`${ultimo.nombre}\` devolvió ${lineas} líneas.`, llamadas: [] };
      }
      if (/edita|cambia/i.test(texto) || /^lee\b/i.test(texto)) {
        return { texto: `Leo \`${ruta}\`.`, llamadas: [{ id, nombre: "leer", argumentos: { ruta } }] };
      }
      const comando = texto.match(/ejecuta\s+(.+)/i)?.[1];
      if (comando) return { texto: "", llamadas: [{ id, nombre: "terminal", argumentos: { comando: comando.replace(/^`|`$/g, "") } }] };
      if (/pregunta/i.test(texto)) {
        return { texto: "", llamadas: [{ id, nombre: "preguntar", argumentos: { pregunta: "¿Qué formato prefieres?", opciones: ["Markdown", "Texto plano", "JSON"] } }] };
      }
      if (/tareas/i.test(texto)) {
        return {
          texto: "",
          llamadas: [{ id, nombre: "tareas", argumentos: { tareas: [{ texto: "Leer el código", estado: "hecha" }, { texto: "Arreglar el fallo", estado: "en-curso" }, { texto: "Ejecutar los tests", estado: "pendiente" }] } }],
        };
      }
      return {
        texto: [
          "## Respuesta de prueba",
          "",
          "Esto es **markdown** con una lista:",
          "",
          "- un elemento con `código`",
          "- otro con un [enlace](https://example.com)",
          "",
          "```ts",
          'const saludo = "hola";',
          "console.log(saludo);",
          "```",
        ].join("\n"),
        llamadas: [],
      };
    },
  ];
}
