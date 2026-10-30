import { expect, test } from "bun:test";
import { traducirNativa } from "../src/proveedores/agy";

const t = (nombre: string, parametros: Record<string, unknown>) => traducirNativa({ nombre, parametros }, "x");

test("traduce las herramientas nativas de agy a las de Aquiles", () => {
  expect(t("run_command", { CommandLine: "dir" })).toEqual([{ id: "x", nombre: "terminal", argumentos: { comando: "dir" } }]);
  expect(t("run_command", { CommandLine: "bun test", Cwd: "C:\\p" })?.[0]?.argumentos).toEqual({ comando: 'cd "C:\\p" && bun test' });
  expect(t("view_file", { AbsolutePath: "C:\\p\\a.ts", StartLine: 10, EndLine: 19 })?.[0]?.argumentos).toEqual({ ruta: "C:\\p\\a.ts", desde: 10, lineas: 10 });
  expect(t("write_to_file", { TargetFile: "a.md", CodeContent: "" })?.[0]).toMatchObject({ nombre: "escribir", argumentos: { ruta: "a.md", contenido: "" } });
  expect(t("replace_file_content", { TargetFile: "a.ts", TargetContent: "x", ReplacementContent: "y" })?.[0]?.argumentos).toEqual({ ruta: "a.ts", buscar: "x", reemplazar: "y" });
  expect(t("grep_search", { Query: "a.b(", SearchPath: "src" })?.[0]?.argumentos).toEqual({ patron: "a\\.b\\(", ruta: "src" });
  expect(t("find_by_name", { Pattern: "*.ts" })?.[0]?.argumentos).toEqual({ patron: "*.ts" });
});

test("multi_replace se parte en varias ediciones con ids distintos", () => {
  const r = t("multi_replace_file_content", {
    TargetFile: "a.ts",
    ReplacementChunks: [{ TargetContent: "a", ReplacementContent: "b" }, { TargetContent: "c", ReplacementContent: "d", AllowMultiple: true }],
  });
  expect(r?.map((l) => l.id)).toEqual(["x.1", "x.2"]);
  expect(r?.[1]?.argumentos).toEqual({ ruta: "a.ts", buscar: "c", reemplazar: "d", todas: true });
});

test("sin equivalente seguro devuelve undefined", () => {
  expect(t("browser_subagent", {})).toBeUndefined();
  expect(t("run_command", {})).toBeUndefined();
  expect(t("replace_file_content", { TargetFile: "a.ts" })).toBeUndefined();
});
