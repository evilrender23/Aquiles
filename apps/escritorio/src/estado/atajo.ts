/**
 * De una pulsación (KeyboardEvent) al texto del atajo que entiende el núcleo de Tauri (global-hotkey):
 * modificadores en orden fijo y la tecla por su `code` (la posición física, igual con cualquier distribución).
 */

export interface Pulsacion {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type Captura =
  /** Solo modificadores por ahora: lo que hay pulsado, para enseñarlo mientras se graba. */
  | { tipo: "parcial"; texto: string }
  | { tipo: "atajo"; texto: string }
  | { tipo: "error"; texto: string };

const MODIFICADORES = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight", "OSLeft", "OSRight"]);

/** Teclas sin letra ni cifra que global-hotkey admite por su `code`. */
const OTRAS = new Set([
  "Space", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backquote", "Backslash", "BracketLeft", "BracketRight",
  "Comma", "Period", "Minus", "Equal", "Quote", "Semicolon", "Slash", "PrintScreen", "ScrollLock", "Pause",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter", "NumpadEqual",
]);

/** «KeyK» → «K», «Digit1» → «1»; las demás tal cual, si global-hotkey las admite. */
function tecla(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code) || /^Numpad\d$/.test(code) || OTRAS.has(code)) return code;
  return undefined;
}

/** En Mac la tecla ⌘ se guarda como «Cmd»; en Windows y Linux, la de Windows como «Super». */
function modificadores(p: Pulsacion, mac: boolean): string[] {
  return [p.ctrlKey && "Ctrl", p.altKey && "Alt", p.shiftKey && "Shift", p.metaKey && (mac ? "Cmd" : "Super")].filter(Boolean) as string[];
}

export function capturar(p: Pulsacion, mac: boolean): Captura {
  const mods = modificadores(p, mac);
  if (MODIFICADORES.has(p.code)) return { tipo: "parcial", texto: mods.join("+") };
  const t = tecla(p.code);
  if (!t) return { tipo: "error", texto: "Esa tecla no se puede usar en un atajo" };
  // Una tecla sola dejaría de llegar a los demás programas (el núcleo tampoco lo acepta).
  if (!mods.length) return { tipo: "error", texto: "Añade al menos Ctrl, Alt, Shift o " + (mac ? "Cmd" : "Windows") };
  return { tipo: "atajo", texto: [...mods, t].join("+") };
}
