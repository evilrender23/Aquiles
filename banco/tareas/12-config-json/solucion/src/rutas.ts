import type { Config } from "./config";

/** Rutas HTTP que monta el servidor. */
export function rutas(config: Config): string[] {
  const lista = ["/api/v1/productos", "/api/v1/carrito"];
  if (config.funciones.pagoBizum) lista.push("/api/v1/pagos/bizum");
  return lista;
}
