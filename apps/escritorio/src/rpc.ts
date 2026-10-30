import type { Evento, NombreMetodo, Params, RespuestaRpc, Resultados } from "@aquiles/protocolo";
import { RUTA_RPC } from "@aquiles/protocolo";

export class ErrorNucleo extends Error {
  constructor(readonly codigo: number, mensaje: string) {
    super(mensaje);
  }
}

/** Cliente JSON-RPC 2.0 sobre WebSocket para hablar con el núcleo. */
export class ClienteRpc {
  private siguiente = 0;
  private pendientes = new Map<number, { ok: (v: unknown) => void; mal: (e: Error) => void }>();
  private oyentes = new Set<(e: Evento) => void>();

  private constructor(private ws: WebSocket) {
    ws.onmessage = (m) => this.recibir(String(m.data));
    ws.onclose = () => {
      for (const p of this.pendientes.values()) p.mal(new Error("Conexión con el núcleo cerrada"));
      this.pendientes.clear();
    };
  }

  static conectar(base: string, token: string): Promise<ClienteRpc> {
    return new Promise((ok, mal) => {
      const ws = new WebSocket(`${base}${RUTA_RPC}?token=${encodeURIComponent(token)}`);
      ws.onopen = () => ok(new ClienteRpc(ws));
      ws.onerror = () => mal(new Error("No se pudo conectar con el núcleo"));
    });
  }

  llamar<M extends NombreMetodo>(metodo: M, params: Params<M>): Promise<Resultados[M]> {
    const id = ++this.siguiente;
    return new Promise((ok, mal) => {
      this.pendientes.set(id, { ok: ok as (v: unknown) => void, mal });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: metodo, params }));
    });
  }

  alEvento(f: (e: Evento) => void): () => void {
    this.oyentes.add(f);
    return () => this.oyentes.delete(f);
  }

  alCerrar(f: () => void): void {
    this.ws.addEventListener("close", f);
  }

  cerrar(): void {
    this.ws.close();
  }

  private recibir(texto: string): void {
    const datos = JSON.parse(texto) as RespuestaRpc & { method?: string; params?: Evento };
    if (datos.method === "evento" && datos.params) {
      for (const f of this.oyentes) f(datos.params);
      return;
    }
    const p = typeof datos.id === "number" ? this.pendientes.get(datos.id) : undefined;
    if (!p) return;
    this.pendientes.delete(datos.id as number);
    if (datos.error) p.mal(new ErrorNucleo(datos.error.code, datos.error.message));
    else p.ok(datos.result);
  }
}
