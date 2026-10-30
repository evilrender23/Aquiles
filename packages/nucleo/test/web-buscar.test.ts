import { afterEach, expect, test } from "bun:test";
import { buscar, buscarWeb, PAGINA, trozoDePagina } from "../src/herramientas/web";
import { contextoPrueba } from "./contexto-prueba";

// Recorte de la página real de html.duckduckgo.com: un resultado directo, uno con la redirección uddg= y un anuncio.
const HTML_DDG = `<!DOCTYPE html><html><body><div id="links" class="results">
  <div class="result results_links results_links_deep result--ad ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=anuncio.com&amp;u3=x">Anuncio</a></h2>
      <a class="result__snippet" href="https://duckduckgo.com/y.js?x">Compra ya</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://bun.sh/">Bun — A fast all-in-one <b>JavaScript</b> runtime</a></h2>
      <div class="result__extras"><div class="result__extras__url"><a class="result__url" href="https://bun.sh/">bun.sh</a></div></div>
      <a class="result__snippet" href="https://bun.sh/">Bundle, install, and run <b>JavaScript</b> &amp; TypeScript — all in <b>Bun</b>.</a>
      <div class="clear"></div>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fes.wikipedia.org%2Fwiki%2FBun_(software)%3Fa%3D1%26b%3D2&amp;rut=abc" class="result__a">Bun (software) - Wikipedia</a></h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Entorno de ejecución de &quot;JavaScript&quot;.</a>
    </div>
  </div>
</div></body></html>`;

function fetchFalso(respuesta: () => Response) {
  const pedidos: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    pedidos.push({ url, init });
    return respuesta();
  }) as unknown as typeof fetch;
  return { f, pedidos };
}

const claveOriginal = process.env.AQUILES_BRAVE_KEY;
afterEach(() => {
  if (claveOriginal === undefined) delete process.env.AQUILES_BRAVE_KEY;
  else process.env.AQUILES_BRAVE_KEY = claveOriginal;
});

test("DuckDuckGo: título, URL real (deshace uddg=) y extracto; sin anuncios", async () => {
  delete process.env.AQUILES_BRAVE_KEY;
  const { f, pedidos } = fetchFalso(() => new Response(HTML_DDG, { headers: { "content-type": "text/html" } }));
  const r = await buscar("bun runtime", { f });
  expect(r).toEqual([
    { titulo: "Bun — A fast all-in-one JavaScript runtime", url: "https://bun.sh/", extracto: "Bundle, install, and run JavaScript & TypeScript — all in Bun." },
    { titulo: "Bun (software) - Wikipedia", url: "https://es.wikipedia.org/wiki/Bun_(software)?a=1&b=2", extracto: 'Entorno de ejecución de "JavaScript".' },
  ]);
  expect(pedidos[0]?.url).toBe("https://html.duckduckgo.com/html/");
  expect(pedidos[0]?.init?.method).toBe("POST");
  expect(String(pedidos[0]?.init?.body)).toBe("q=bun+runtime");
  expect(await buscar("bun", { f, limite: 1 })).toHaveLength(1);
});

test("DuckDuckGo: la página de «¿eres un robot?» da un error claro", async () => {
  delete process.env.AQUILES_BRAVE_KEY;
  const { f } = fetchFalso(() => new Response('<div class="anomaly-modal__box"></div>', { status: 202 }));
  await expect(buscar("x", { f })).rejects.toThrow("AQUILES_BRAVE_KEY");
});

test("Brave Search con AQUILES_BRAVE_KEY", async () => {
  process.env.AQUILES_BRAVE_KEY = "clave-de-prueba";
  const cuerpo = { web: { results: [{ title: "Bun <strong>runtime</strong>", url: "https://bun.sh/", description: "Rápido &amp; <strong>completo</strong>" }, { title: "sin url" }] } };
  const { f, pedidos } = fetchFalso(() => Response.json(cuerpo));
  expect(await buscar("bun", { f, limite: 5 })).toEqual([{ titulo: "Bun runtime", url: "https://bun.sh/", extracto: "Rápido & completo" }]);
  const u = new URL(pedidos[0]!.url);
  expect(u.origin + u.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
  expect(u.searchParams.get("q")).toBe("bun");
  expect(u.searchParams.get("count")).toBe("5");
  expect((pedidos[0]!.init!.headers as Record<string, string>)["x-subscription-token"]).toBe("clave-de-prueba");

  const { f: denegado } = fetchFalso(() => new Response("no", { status: 401, statusText: "Unauthorized" }));
  await expect(buscar("bun", { f: denegado })).rejects.toThrow("revisa AQUILES_BRAVE_KEY");
});

test("buscar_web: permiso único, resumen y lista numerada que remite a leer_web", async () => {
  expect(buscarWeb.nombre).toBe("buscar_web");
  expect(buscarWeb.nivel).toBe("ejecucion");
  expect(buscarWeb.clavePermiso?.({ consulta: "a" })).toBe("web:busqueda");
  expect(buscarWeb.resumen?.({ consulta: "precio del cobre" })).toBe("precio del cobre");
  expect(buscarWeb.descripcion).toContain("leer_web");
  expect(buscarWeb.parametros.safeParse({ consulta: "" }).success).toBe(false);

  // La herramienta usa el fetch global.
  delete process.env.AQUILES_BRAVE_KEY;
  const original = globalThis.fetch;
  globalThis.fetch = fetchFalso(() => new Response(HTML_DDG)).f;
  try {
    const texto = await buscarWeb.ejecutar({ consulta: "bun" }, contextoPrueba("."));
    expect(texto).toStartWith("1. Bun — A fast all-in-one JavaScript runtime\n   https://bun.sh/\n   Bundle, install");
    expect(texto).toContain("\n\n2. Bun (software) - Wikipedia\n   https://es.wikipedia.org/");
    globalThis.fetch = fetchFalso(() => new Response("<html></html>")).f;
    expect(await buscarWeb.ejecutar({ consulta: "nada" }, contextoPrueba("."))).toBe("Sin resultados para «nada».");
  } finally {
    globalThis.fetch = original;
  }
});

test("trozoDePagina: cabecera y aviso de lo que queda", () => {
  const texto = "a".repeat(PAGINA + 10);
  const primero = trozoDePagina({ url: "https://x.org/", titulo: "X", texto });
  expect(primero).toStartWith("URL: https://x.org/\nTítulo: X\n\naaa");
  expect(primero).toEndWith(`[Quedan 10 caracteres: sigue con desde=${PAGINA}]`);
  expect(trozoDePagina({ url: "u", texto }, PAGINA)).toBe("URL: u\n\naaaaaaaaaa");
  expect(trozoDePagina({ url: "u", texto: "" })).toBe("URL: u\n\n(la página no tiene texto)");
});
