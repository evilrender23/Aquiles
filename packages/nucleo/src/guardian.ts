/**
 * Guardián de permisos: antes de preguntar al usuario, un modelo auxiliar mira la acción y, si es claramente segura
 * para lo que el usuario pidió, la aprueba. Ante cualquier duda (o si falla) se pregunta igual: nunca deniega por su cuenta.
 * No actúa sobre rutas fuera de la carpeta de trabajo.
 */
import type { PeticionAprobacion } from "./bucle";
import type { Mensaje, Proveedor } from "./tipos";

const PROMPT = [
  "Eres el guardián de permisos de Aquiles, un agente que trabaja en el ordenador del usuario.",
  "Te llega una acción que el agente quiere hacer y lo último que pidió el usuario. Decide si es claramente segura:",
  "- permitir: sirve a lo que pidió el usuario, no borra ni sobrescribe nada importante, no instala nada del sistema,",
  "  no envía datos fuera, no toca credenciales y se puede deshacer o no cambia nada (p. ej. ejecutar tests, listar, compilar,",
  "  consultar git, leer una web de documentación).",
  "- preguntar: todo lo demás, y siempre que dudes.",
  "Responde solo con JSON en una línea: {\"decision\":\"permitir\"|\"preguntar\",\"motivo\":\"…\"}",
].join("\n");

export interface DecisionGuardian {
  decision: "permitir" | "preguntar";
  motivo: string;
}

export async function consultarGuardian(o: {
  proveedor: Proveedor;
  peticion: PeticionAprobacion;
  cwd: string;
  mensajes: readonly Mensaje[];
  senal: AbortSignal;
}): Promise<DecisionGuardian> {
  if (o.peticion.motivo.startsWith("fuera de la carpeta")) return { decision: "preguntar", motivo: "fuera de la carpeta de trabajo" };
  const pedido = [...o.mensajes].reverse().find((m) => m.rol === "usuario");
  const accion = {
    herramienta: o.peticion.herramienta,
    nivel: o.peticion.nivel,
    resumen: o.peticion.resumen,
    argumentos: o.peticion.argumentos,
    carpeta: o.cwd,
  };
  const sesionId = `guardian-${crypto.randomUUID()}`;
  try {
    const r = await o.proveedor.responder(
      {
        sesionId,
        sistema: PROMPT,
        mensajes: [
          {
            rol: "usuario",
            texto: `Lo último que pidió el usuario:\n${pedido?.rol === "usuario" ? pedido.texto.slice(0, 2000) : "(nada)"}\n\nAcción:\n${JSON.stringify(accion, null, 2).slice(0, 4000)}`,
          },
        ],
        herramientas: [],
        cwd: o.cwd,
        senal: AbortSignal.any([o.senal, AbortSignal.timeout(60_000)]),
        maxTokensSalida: 200,
      },
      () => {},
    );
    return interpretar(r.texto);
  } catch (e) {
    return { decision: "preguntar", motivo: `el guardián no respondió (${e instanceof Error ? e.message : e})` };
  } finally {
    await o.proveedor.cerrar?.(sesionId);
  }
}

export function interpretar(texto: string): DecisionGuardian {
  const json = /\{[\s\S]*\}/.exec(texto)?.[0];
  try {
    const d = JSON.parse(json ?? "") as Partial<DecisionGuardian>;
    if (d.decision === "permitir") return { decision: "permitir", motivo: String(d.motivo ?? "").slice(0, 300) };
    return { decision: "preguntar", motivo: String(d.motivo ?? "").slice(0, 300) };
  } catch {
    return { decision: "preguntar", motivo: "respuesta del guardián no válida" };
  }
}
