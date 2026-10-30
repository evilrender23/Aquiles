import { expect, test } from "bun:test";
import { esfuerzoAnthropic, esfuerzoCodex, esfuerzoDeCli, nivelesDeAyuda, nivelesPara } from "../src/proveedores/esfuerzo";

test("lee los niveles de la ayuda de claude y de agy", () => {
  expect(nivelesDeAyuda("  --effort <level>     Effort level for the current session\n                (low, medium, high, xhigh, max)\n  --env x (a, b)")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(nivelesDeAyuda("--effort    Reasoning effort for the current CLI session (low|medium|high|xhigh|max)")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(nivelesDeAyuda("--model <m> (sonnet, opus)")).toEqual([]);
});

test("codex: niveles por modelo sin los que su API no admite, y su nivel por defecto", () => {
  expect(
    esfuerzoCodex([
      { slug: "a", niveles: ["max", "low", "ultra", "medium"], porDefecto: "low" },
      { slug: "b", niveles: ["ultra"], porDefecto: "ultra" },
      { slug: "c" },
    ]),
  ).toEqual({ niveles: [], porModelo: { a: { niveles: ["low", "medium", "max"], porDefecto: "low" } } });
  expect(esfuerzoCodex([{ slug: "c" }])).toBeUndefined();
});

test("anthropic: niveles de capabilities.effort de la API de modelos", async () => {
  const si = { supported: true };
  const no = { supported: false };
  const falso = (async () =>
    Response.json({
      data: [
        { id: "m1", type: "model", display_name: "M1", created_at: "2026-01-01T00:00:00Z", capabilities: { effort: { supported: true, low: si, medium: si, high: si, max: si, xhigh: no } } },
        { id: "m2", type: "model", display_name: "M2", created_at: "2026-01-01T00:00:00Z", capabilities: { effort: { supported: false, low: no, medium: no, high: no, max: no, xhigh: null } } },
      ],
      has_more: false, first_id: "m1", last_id: "m2",
    })) as unknown as typeof fetch;
  expect(await esfuerzoAnthropic("clave-de-prueba", { fetch: falso })).toEqual({ niveles: [], porModelo: { m1: { niveles: ["low", "medium", "high", "max"] } } });
});

test("nivelesPara: los del modelo si los hay, si no los generales", () => {
  const e = { niveles: ["low", "high"], porModelo: { x: { niveles: ["low"], porDefecto: "low" } } };
  expect(nivelesPara(e, "x")).toEqual({ niveles: ["low"], porDefecto: "low" });
  expect(nivelesPara(e, "y")).toEqual({ niveles: ["low", "high"] });
  expect(nivelesPara({ niveles: [], porModelo: {} }, "y")).toBeUndefined();
});

test("el claude instalado declara sus niveles", async () => {
  const exe = Bun.which("claude");
  if (!exe) return;
  expect((await esfuerzoDeCli(exe))?.niveles).toContain("high");
});
