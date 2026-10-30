import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aplicarRestauracion, crearCopia, crearPerfil, listarCopias, listarPerfiles, prepararRestauracion } from "../src/perfiles";
import { AlmacenSesiones, info } from "../src/sesiones";

test("perfiles: listar con sesiones y crear con nombre válido", () => {
  const datos = mkdtempSync(join(tmpdir(), "aquiles-datos-"));
  mkdirSync(join(datos, "perfiles", "principal", "sesiones"), { recursive: true });
  writeFileSync(join(datos, "perfiles", "principal", "sesiones", "a.jsonl"), "{}\n");
  mkdirSync(join(datos, "perfiles", "principal.antes-20260101T000000Z"));
  expect(crearPerfil("trabajo", datos)).toEqual({ nombre: "trabajo", sesiones: 0 });
  expect(() => crearPerfil("trabajo", datos)).toThrow("Ya existe");
  expect(() => crearPerfil("Mal Nombre", datos)).toThrow("no válido");
  expect(listarPerfiles(datos).map((p) => [p.nombre, p.sesiones])).toEqual([["principal", 1], ["trabajo", 0]]);
});

test("copias: crear un zip sin el índice, restaurarla y conservar la versión anterior", async () => {
  const datos = mkdtempSync(join(tmpdir(), "aquiles-datos-"));
  const perfil = join(datos, "perfiles", "principal");
  mkdirSync(join(perfil, "memoria"), { recursive: true });
  writeFileSync(join(perfil, "memoria", "USER.md"), "versión 1\n");
  writeFileSync(join(perfil, "busqueda.db"), "índice");
  const copia = await crearCopia("principal", datos, new Date("2026-10-30T10:00:00Z"));
  expect(copia).toMatchObject({ nombre: "principal-20261030T100000Z.zip", perfil: "principal", fecha: "2026-10-30T10:00:00Z" });
  expect(copia.bytes).toBeGreaterThan(0);
  expect(listarCopias(datos)).toHaveLength(1);

  writeFileSync(join(perfil, "memoria", "USER.md"), "versión 2\n");
  expect(await prepararRestauracion(copia.nombre, datos)).toBe("principal");
  const anterior = aplicarRestauracion("principal", datos, new Date("2026-10-30T11:00:00Z"));
  expect(anterior).toBe(join(datos, "perfiles", "principal.antes-20261030T110000Z"));
  expect(readFileSync(join(perfil, "memoria", "USER.md"), "utf8")).toBe("versión 1\n");
  expect(existsSync(join(perfil, "busqueda.db"))).toBe(false);
  expect(readFileSync(join(anterior!, "memoria", "USER.md"), "utf8")).toBe("versión 2\n");
  expect(aplicarRestauracion("principal", datos)).toBeUndefined();
  await expect(prepararRestauracion("no-existe.zip", datos)).rejects.toThrow("No existe");
});

test("una sesión con un turno empezado y sin cerrar sale como interrumpida al recargar", () => {
  const dir = mkdtempSync(join(tmpdir(), "aquiles-ses-"));
  const a = new AlmacenSesiones(dir, "simulado");
  const s = a.crear(dir, { proveedor: "simulado", titulo: "Mi tarea" });
  a.anotar(s, { rol: "usuario", texto: "hola" });
  a.anotarInicioTurno(s);
  const otra = a.crear(dir, { proveedor: "simulado" });
  a.anotarInicioTurno(otra);
  a.anotarUso(otra, { entrada: 1, salida: 1 }, "fin");

  const recargado = new AlmacenSesiones(dir, "simulado");
  const vista = recargado.listar();
  expect(vista.find((x) => x.sesionId === s.id)).toMatchObject({ titulo: "Mi tarea", interrumpida: true });
  expect(vista.find((x) => x.sesionId === otra.id)?.interrumpida).toBeUndefined();
  // Mientras trabaja no cuenta como interrumpida.
  const viva = recargado.obtener(s.id)!;
  viva.turno = new AbortController();
  expect(info(viva).interrumpida).toBeUndefined();
});
