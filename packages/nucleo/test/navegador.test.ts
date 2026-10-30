import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorHerramienta } from "../src/herramientas/herramienta";
import { cerrarEstadoSesion } from "../src/herramientas/index";
import { buscarEdge, cerrarNavegador, clavePermisoNavegador, herramientaNavegador } from "../src/herramientas/navegador";
import { carpetaTemporal, contextoPrueba } from "./contexto-prueba";

afterAll(() => cerrarNavegador());

test("permiso por dominio de destino al abrir; sin pestañas, sin dominio", () => {
  expect(clavePermisoNavegador({ accion: "abrir", url: "https://ejemplo.org/a?b=1" })).toBe("navegador:ejemplo.org");
  expect(clavePermisoNavegador({ accion: "abrir", url: "no es url" })).toBe("navegador:?");
  expect(clavePermisoNavegador({ accion: "leer" })).toBe("navegador:?");
});

test("esquema, resumen y errores que no necesitan abrir Edge", async () => {
  const h = herramientaNavegador({ perfil: null, ejecutable: "C:\\no\\existe\\msedge.exe" });
  expect(h.nombre).toBe("navegador");
  expect(h.nivel).toBe("ejecucion");
  expect(h.parametros.safeParse({ accion: "volar" }).success).toBe(false);
  expect(h.resumen?.({ accion: "escribir", selector: "#q", texto: "hola", enviar: true })).toBe("escribir «hola» en #q y Enter");
  expect(h.resumen?.({ accion: "clic", texto: "Entrar" })).toBe("clic en «Entrar»");
  const ctx = contextoPrueba(".");
  // `expect(p).rejects` de Bun se cuelga con estas promesas: se captura el error a mano.
  const error = (p: Promise<unknown>) => p.then(() => new Error("no falló"), (e: unknown) => e as Error);
  expect((await error(h.ejecutar({ accion: "leer" }, ctx))).message).toContain("No hay ninguna página abierta");
  expect((await error(h.ejecutar({ accion: "abrir", url: "file:///C:/Windows/win.ini" }, ctx))).message).toContain("http o https");
  const sinEdge = await error(h.ejecutar({ accion: "abrir", url: "https://ejemplo.org/" }, ctx));
  expect(sinEdge).toBeInstanceOf(ErrorHerramienta);
  expect(sinEdge.message).toContain("No se encuentra Microsoft Edge");
  expect(await h.ejecutar({ accion: "cerrar" }, ctx)).toBe("Pestaña cerrada.");
});

const PAGINAS: Record<string, string> = {
  "/": `<!doctype html><html><head><title>Inicio</title></head><body>
    <h1>Bienvenida</h1>
    <p id="estado">sin pulsar</p>
    <button id="boton" onclick="document.getElementById('estado').textContent = 'pulsado'">Pulsar</button>
    <div role="button" onclick="document.getElementById('estado').textContent = 'por texto'">Otra cosa</div>
    <form action="/hola"><label for="nombre">Tu nombre</label><input id="nombre" name="nombre"></form>
    <select id="color"><option>Rojo</option><option>Verde</option></select>
    <a href="/otra">Otra página</a> <a href="/otra" target="_blank">Nueva ventana</a>
  </body></html>`,
  "/otra": "<!doctype html><title>Otra</title><h1>Otra página</h1>",
  "/lento": `<!doctype html><title>Lento</title><p>Esperando…</p>
    <script>setTimeout(() => { const d = document.createElement('div'); d.id = 'tarde'; d.textContent = 'ya'; document.body.append(d); }, 400);</script>`,
  "/alerta": `<!doctype html><title>Alerta</title><p>Con aviso</p><script>alert('cuidado')</script>`,
};

test.skipIf(!buscarEdge())(
  "Edge real: abrir, leer, clic, escribir, esperar, captura, atras y cerrar",
  async () => {
    const web = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/hola") return new Response(`<!doctype html><title>Hola</title><h1>Hola, ${u.searchParams.get("nombre")}</h1>`, { headers: { "content-type": "text/html" } });
        const html = PAGINAS[u.pathname];
        return html ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("no", { status: 404 });
      },
    });
    const tmp = await carpetaTemporal("navegador");
    const base = `http://127.0.0.1:${web.port}`;
    try {
      const h = herramientaNavegador({ perfil: tmp.dir });
      const ctx = contextoPrueba(tmp.dir, { sesionId: "sesion-uno" });

      const inicio = await h.ejecutar({ accion: "abrir", url: `${base}/` }, ctx);
      expect(inicio).toContain(`URL: ${base}/`);
      expect(inicio).toContain("Título: Inicio");
      expect(inicio).toContain("# Bienvenida");
      expect(inicio).toContain("sin pulsar");
      expect(inicio).toContain("- #nombre (text, «Tu nombre»)");
      expect(inicio).toContain("- #color (select) = «Rojo»");
      expect(existsSync(join(tmp.dir, "navegador"))).toBe(true);
      expect(h.clavePermiso?.({ accion: "leer" })).toBe("navegador:127.0.0.1");

      expect(await h.ejecutar({ accion: "clic", selector: "#boton" }, ctx)).toContain(`Sigue en ${base}/`);
      expect(await h.ejecutar({ accion: "leer" }, ctx)).toContain("pulsado");
      expect(await h.ejecutar({ accion: "clic", texto: "otra cosa" }, ctx)).toContain("Clic en div «Otra cosa»");
      expect(await h.ejecutar({ accion: "leer" }, ctx)).toContain("por texto");
      expect(await h.ejecutar({ accion: "escribir", selector: "#color", texto: "verde" }, ctx)).toContain("Escrito en #color");
      expect(await h.ejecutar({ accion: "leer" }, ctx)).toContain("- #color (select) = «Verde»");

      const enviado = await h.ejecutar({ accion: "escribir", selector: "#nombre", texto: "Ana", enviar: true }, ctx);
      expect(enviado).toContain("La página cambió");
      expect(enviado).toContain("# Hola, Ana");

      const atras = await h.ejecutar({ accion: "atras" }, ctx);
      expect(atras).toContain("# Bienvenida");
      // El enlace con target=_blank se queda en la misma pestaña.
      const nueva = await h.ejecutar({ accion: "clic", texto: "Nueva ventana" }, ctx);
      expect(nueva).toContain(`URL: ${base}/otra`);
      expect(nueva).toContain("# Otra página");

      await h.ejecutar({ accion: "abrir", url: `${base}/lento` }, ctx);
      expect(await h.ejecutar({ accion: "esperar", selector: "#tarde" }, ctx)).toBe("#tarde ya está en la página.");
      const espera = await h.ejecutar({ accion: "esperar", selector: "#nunca", timeout_s: 1 }, ctx).catch((e: Error) => e.message);
      expect(espera).toBe("#nunca no apareció en 1 s.");

      expect(await h.ejecutar({ accion: "abrir", url: `${base}/alerta` }, ctx)).toContain("La página mostró un alert: «cuidado» (aceptado).");

      const captura = await h.ejecutar({ accion: "captura" }, ctx);
      const ruta = /guardada en (.+\.png)$/.exec(captura)?.[1];
      expect(ruta?.startsWith(join(tmp.dir, "salidas", "navegador"))).toBe(true);
      expect(readFileSync(ruta!).subarray(1, 4).toString()).toBe("PNG");

      // Otra sesión tiene su propia pestaña.
      const ctx2 = contextoPrueba(tmp.dir, { sesionId: "sesion-dos" });
      await h.ejecutar({ accion: "abrir", url: `${base}/otra` }, ctx2);
      expect(await h.ejecutar({ accion: "leer" }, ctx)).toContain("Con aviso");
      expect(h.clavePermiso?.({ accion: "leer" })).toBe("navegador:127.0.0.1");

      // cerrarEstadoSesion cierra la pestaña de la sesión.
      await cerrarEstadoSesion(ctx.estado);
      expect(ctx.estado.size).toBe(0);
      const cerrada = await h.ejecutar({ accion: "leer" }, ctx).catch((e: Error) => e.message);
      expect(cerrada).toContain("No hay ninguna página abierta");
      expect(await h.ejecutar({ accion: "leer" }, ctx2)).toContain("# Otra página");
      expect(await h.ejecutar({ accion: "cerrar" }, ctx2)).toBe("Pestaña cerrada.");
    } finally {
      await cerrarNavegador();
      web.stop(true);
      // Si Edge siguiera abierto, el perfil estaría bloqueado y no se podría borrar.
      await tmp.borrar();
    }
  },
  90_000,
);
