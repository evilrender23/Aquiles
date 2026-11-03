import { expect, test } from "bun:test";
import { claseDocumento, rutaAbsoluta } from "./artefactos";
import { esfuerzoTrasCambio, opcionesEsfuerzo } from "./esfuerzo";
import { carpetasRecientes, duracion, mismaCarpeta, nombreCarpeta, rutaCorta, tokens } from "./formato";

test("tokens y duraciones como se leen en la app", () => {
  expect([tokens(950), tokens(61_400), tokens(200_000), tokens(1_250_000)]).toEqual(["950", "61,4k", "200k", "1,3M"]);
  expect([duracion(1500), duracion(61_000), duracion(125_400)]).toEqual(["1,5 s", "1 min 1 s", "2 min 5 s"]);
});

test("carpetas de Windows y de Mac: nombre, ruta corta, la misma con otras mayúsculas y las recientes sin repetir", () => {
  expect(nombreCarpeta("C:\\Users\\yo\\proyecto\\")).toBe("proyecto");
  expect(nombreCarpeta("/Users/yo/proyecto")).toBe("proyecto");
  expect(rutaCorta("C:\\Users\\yo\\Escritorio\\proyecto")).toBe("Escritorio\\proyecto");
  expect(mismaCarpeta("C:\\P\\x\\", "c:/p/X")).toBe(true);
  const s = (cwd: string, actualizada: string) => ({ cwd, actualizada }) as never;
  expect(carpetasRecientes([s("C:\\a", "2026-11-01"), s("C:\\b", "2026-11-03"), s("c:\\A\\", "2026-11-02")], "C:\\a")).toEqual(["C:\\a", "C:\\b"]);
});

test("documentos que abre el visor y rutas absolutas (también las de Git Bash en Windows)", () => {
  expect(["a.md", "b.DOCX", "c.png", "d.JPEG", "e.ts"].map(claseDocumento)).toEqual(["markdown", "word", "imagen", "imagen", undefined]);
  expect(rutaAbsoluta("/Users/yo/p", "img/a.png")).toBe("/Users/yo/p/img/a.png");
  expect(rutaAbsoluta("C:\\p", "/c/otro/a.txt")).toMatch(/^C:[\\/]otro[\\/]a\.txt$/);
});

test("esfuerzo: opciones del modelo y qué pasa al cambiar a uno sin niveles", () => {
  expect(opcionesEsfuerzo({ niveles: ["low", "high"], porDefecto: "high" }).map((o) => o.valor)).toEqual(["", "low", "high"]);
  const proveedores = [{ id: "codex", modelos: ["m1", "m2"], esfuerzos: { m1: { niveles: ["low"] } } }] as never;
  expect(esfuerzoTrasCambio(proveedores, "codex", "m2", "low")).toBe("");
});
