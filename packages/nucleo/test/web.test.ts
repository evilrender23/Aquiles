import { expect, test } from "bun:test";
import { descargar, htmlATexto } from "../src/herramientas/web";

test("HTML a texto: título, encabezados, listas, enlaces absolutos, código y entidades", () => {
  const html = `<!doctype html><html><head><title>Guía &amp; trucos</title><style>p{}</style></head>
    <body><nav>menú</nav><h1>Instalar</h1><p>Usa <code>bun install</code> &mdash; rápido.</p>
    <ul><li>Uno</li><li><a href="/docs">Docs</a></li></ul><pre><code>a &lt; b</code></pre><script>alert(1)</script></body></html>`;
  const r = htmlATexto(html, "https://ejemplo.org/guia/");
  expect(r.titulo).toBe("Guía & trucos");
  expect(r.texto).toContain("# Instalar");
  expect(r.texto).toContain("Usa `bun install` — rápido.");
  expect(r.texto).toContain("- Uno");
  expect(r.texto).toContain("[Docs](https://ejemplo.org/docs)");
  expect(r.texto).toContain("```\na < b\n```");
  expect(r.texto).not.toContain("alert");
  expect(r.texto).not.toContain("menú");
});

test("descargar: rechaza binarios y respuestas de error", async () => {
  const falso = (async (_url: string) => new Response("x", { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
  await expect(descargar("https://x.org/a.png", new AbortController().signal, falso)).rejects.toThrow("no es texto");
  const error = (async () => new Response("no", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
  await expect(descargar("https://x.org/", new AbortController().signal, error)).rejects.toThrow("404");
});
