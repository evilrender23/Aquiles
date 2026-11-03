import { expect, test } from "bun:test";
import { capturar, type Pulsacion } from "./atajo";

const p = (code: string, mods: Partial<Pulsacion> = {}): Pulsacion => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test("Ctrl+Espacio y otros atajos, con los modificadores siempre en el mismo orden", () => {
  expect(capturar(p("Space", { ctrlKey: true }), false)).toEqual({ tipo: "atajo", texto: "Ctrl+Space" });
  expect(capturar(p("KeyK", { shiftKey: true, altKey: true, ctrlKey: true }), false)).toEqual({ tipo: "atajo", texto: "Ctrl+Alt+Shift+K" });
  expect(capturar(p("Digit1", { altKey: true }), false)).toEqual({ tipo: "atajo", texto: "Alt+1" });
  expect(capturar(p("F5", { metaKey: true }), false)).toEqual({ tipo: "atajo", texto: "Super+F5" });
  expect(capturar(p("Space", { metaKey: true, shiftKey: true }), true)).toEqual({ tipo: "atajo", texto: "Shift+Cmd+Space" });
  // La «ñ» de un teclado español es la tecla Semicolon.
  expect(capturar(p("Semicolon", { ctrlKey: true }), false)).toEqual({ tipo: "atajo", texto: "Ctrl+Semicolon" });
});

test("solo modificadores: parcial; sin modificador o con una tecla rara: error", () => {
  expect(capturar(p("ControlLeft", { ctrlKey: true }), false)).toEqual({ tipo: "parcial", texto: "Ctrl" });
  expect(capturar(p("AltRight", { ctrlKey: true, altKey: true }), false)).toEqual({ tipo: "parcial", texto: "Ctrl+Alt" });
  expect(capturar(p("Space"), false).tipo).toBe("error");
  expect(capturar(p("IntlBackslash", { ctrlKey: true }), false)).toEqual({ tipo: "error", texto: "Esa tecla no se puede usar en un atajo" });
});
