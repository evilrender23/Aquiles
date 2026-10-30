/**
 * Menú contextual de NOX (clic derecho, tecla de menú o Mayús+F10).
 *
 * - `ProveedorMenuContextual` va una vez en la raíz: pinta el menú abierto, quita el menú nativo del WebView
 *   en toda la app y pone el de los campos de texto (Cortar, Copiar, Pegar, Seleccionar todo) y el de una
 *   selección suelta (los que dé la app).
 * - `useMenuContextual(construir)` da el `onContextMenu` de un elemento; `construir` se llama al abrir,
 *   con el estado de ese momento, así que el menú es siempre el que corresponde (Parar si trabaja…).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as KeyboardEventReact,
  type MouseEvent as MouseEventReact,
  type ReactNode,
} from "react";
import { clases } from "../clases";
import { Icono, type NombreIcono } from "./Icono";

export interface AccionMenu {
  tipo?: "accion";
  texto: string;
  icono?: NombreIcono;
  /** Atajo de teclado que ya hace lo mismo («Ctrl+C»). */
  atajo?: string;
  deshabilitado?: boolean;
  /** Destructiva: otro estilo y una confirmación antes de actuar. */
  peligrosa?: boolean;
  alElegir: () => unknown;
}
export interface SubmenuMenu {
  tipo: "submenu";
  texto: string;
  icono?: NombreIcono;
  deshabilitado?: boolean;
  elementos: ElementoMenu[];
}
export type ElementoMenu = AccionMenu | SubmenuMenu | { tipo: "separador" };
/** Lo que devuelve un constructor: se pueden dejar huecos (`cond && {…}`), que se quitan. */
export type ElementosMenu = (ElementoMenu | false | null | undefined | "" | 0)[];

export interface AperturaMenu {
  /** Texto seleccionado dentro del elemento (vacío si no hay). */
  seleccion: string;
  /** Elemento sobre el que se abrió (el `target` del evento). */
  objetivo: Element;
}

export type ConstructorMenu = (a: AperturaMenu) => ElementosMenu | Promise<ElementosMenu>;

interface Abierto {
  id: number;
  x: number;
  y: number;
  elementos: ElementoMenu[];
  /** Quién tenía el foco: lo recupera al cerrar. */
  origen: Element | null;
  porTeclado: boolean;
}

interface ContextoMenu {
  abrir: (a: Omit<Abierto, "id">) => void;
}
const Contexto = createContext<ContextoMenu | null>(null);

/** Sin huecos ni separadores al principio, al final o seguidos. */
function limpiar(lista: ElementosMenu): ElementoMenu[] {
  const salida: ElementoMenu[] = [];
  for (const e of lista) {
    if (!e) continue;
    if (e.tipo === "separador" && (salida.length === 0 || salida.at(-1)?.tipo === "separador")) continue;
    salida.push(e.tipo === "submenu" ? { ...e, elementos: limpiar(e.elementos) } : e);
  }
  while (salida.at(-1)?.tipo === "separador") salida.pop();
  return salida;
}

/** Campo donde se escribe texto (no botones, casillas ni selectores). */
export function campoDeTexto(el: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && ["text", "search", "password", "url", "email", "tel", "number", ""].includes(el.type)) return el;
  return null;
}

/** Selección de la página si está dentro de `dentro` (o en cualquier sitio, sin `dentro`). */
function seleccionEn(dentro?: Element): string {
  const s = window.getSelection();
  const texto = s?.toString() ?? "";
  if (!s || !texto.trim() || s.rangeCount === 0) return "";
  if (!dentro) return texto;
  const nodo = s.getRangeAt(0).commonAncestorContainer;
  return dentro.contains(nodo) ? texto : "";
}

export async function copiarTexto(texto: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    // Sin permiso para la API del portapapeles: el método clásico con un textarea temporal.
    const t = document.createElement("textarea");
    t.value = texto;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
}

/** true / false si se sabe si hay texto en el portapapeles sin pedir permiso; undefined si no se puede saber. */
async function hayTextoEnPortapapeles(): Promise<boolean | undefined> {
  try {
    const permiso = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
    if (permiso?.state !== "granted") return undefined;
    return (await navigator.clipboard.readText()).length > 0;
  } catch {
    return undefined;
  }
}

/** Cortar, Copiar, Pegar y Seleccionar todo de un campo, habilitados según su selección y el portapapeles. */
export async function elementosCampoTexto(campo: HTMLInputElement | HTMLTextAreaElement): Promise<ElementoMenu[]> {
  const inicio = campo.selectionStart ?? 0;
  const fin = campo.selectionEnd ?? 0;
  const seleccion = campo.value.slice(inicio, fin);
  const soloLectura = campo.readOnly || campo.disabled;
  const oculto = campo instanceof HTMLInputElement && campo.type === "password";
  const portapapeles = soloLectura ? false : await hayTextoEnPortapapeles();
  const volver = () => {
    campo.focus();
    try {
      campo.setSelectionRange(inicio, fin);
    } catch {
      // Los campos numéricos no tienen selección.
    }
  };
  return [
    {
      texto: "Cortar",
      icono: "tijeras",
      atajo: "Ctrl+X",
      deshabilitado: !seleccion || soloLectura || oculto,
      alElegir: async () => {
        await copiarTexto(seleccion);
        volver();
        // execCommand mantiene el deshacer del campo y avisa a React del cambio.
        document.execCommand("delete");
      },
    },
    { texto: "Copiar", icono: "copiar", atajo: "Ctrl+C", deshabilitado: !seleccion || oculto, alElegir: () => copiarTexto(seleccion) },
    {
      texto: "Pegar",
      icono: "portapapeles",
      atajo: "Ctrl+V",
      deshabilitado: soloLectura || portapapeles === false,
      alElegir: async () => {
        const texto = await navigator.clipboard.readText().catch(() => "");
        if (!texto) return;
        volver();
        document.execCommand("insertText", false, texto);
      },
    },
    { tipo: "separador" },
    {
      texto: "Seleccionar todo",
      atajo: "Ctrl+A",
      deshabilitado: !campo.value,
      alElegir: () => {
        campo.focus();
        campo.select();
      },
    },
  ];
}

export interface PropsProveedorMenuContextual {
  children: ReactNode;
  /** Menú de una selección de texto fuera de cualquier elemento con menú propio (además de Copiar). */
  seleccion?: (texto: string) => ElementosMenu;
}

export function ProveedorMenuContextual({ children, seleccion }: PropsProveedorMenuContextual) {
  const [abierto, setAbierto] = useState<Abierto>();
  const deSeleccion = useRef(seleccion);
  deSeleccion.current = seleccion;
  /** Tras abrir con el teclado, el `contextmenu` nativo que sigue a la tecla de menú no cuenta. */
  const ignorarNativoHasta = useRef(0);
  const siguiente = useRef(0);

  const abrir = useCallback((a: Omit<Abierto, "id">) => {
    const elementos = limpiar(a.elementos);
    if (elementos.length) setAbierto({ ...a, elementos, id: ++siguiente.current });
  }, []);

  useEffect(() => {
    // En captura: descarta el contextmenu nativo repetido justo después de abrir con el teclado.
    const antes = (e: MouseEvent) => {
      if (e.isTrusted && performance.now() < ignorarNativoHasta.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // En burbuja: lo que ningún elemento atendió. Nunca el menú del WebView; campos de texto y selecciones, el nuestro.
    const despues = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const origen = document.activeElement;
      const campo = campoDeTexto(e.target);
      if (campo) {
        void elementosCampoTexto(campo).then((elementos) => abrir({ x: e.clientX, y: e.clientY, elementos, origen: campo, porTeclado: !e.isTrusted }));
        return;
      }
      const texto = seleccionEn();
      if (!texto.trim()) return;
      abrir({
        x: e.clientX,
        y: e.clientY,
        origen,
        porTeclado: !e.isTrusted,
        elementos: limpiar([{ texto: "Copiar", icono: "copiar", atajo: "Ctrl+C", alElegir: () => copiarTexto(texto) }, ...(deSeleccion.current?.(texto) ?? [])]),
      });
    };
    // Tecla de menú o Mayús+F10: el menú del elemento con el foco, como si se hubiera pulsado con el botón derecho.
    const teclas = (e: KeyboardEvent) => {
      if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
      e.preventDefault();
      const el = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      ignorarNativoHasta.current = performance.now() + 600;
      // Evento sintético (no «trusted»): así se sabe que viene del teclado y el menú enfoca su primera opción.
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + Math.min(24, r.width / 2), clientY: r.top + Math.min(r.height, 32) }));
    };
    window.addEventListener("contextmenu", antes, true);
    document.addEventListener("contextmenu", despues);
    document.addEventListener("keydown", teclas);
    return () => {
      window.removeEventListener("contextmenu", antes, true);
      document.removeEventListener("contextmenu", despues);
      document.removeEventListener("keydown", teclas);
    };
  }, [abrir]);

  const cerrar = useCallback((devolverFoco = true) => {
    setAbierto((a) => {
      if (devolverFoco && a?.origen instanceof HTMLElement && a.origen.isConnected) a.origen.focus({ preventScroll: true });
      return undefined;
    });
  }, []);

  return (
    <Contexto.Provider value={{ abrir }}>
      {children}
      {abierto && <Menu key={abierto.id} abierto={abierto} alCerrar={cerrar} />}
    </Contexto.Provider>
  );
}

/**
 * `onContextMenu` para un elemento. `construir` se llama al abrir (puede ser async). Por defecto deja pasar
 * los clics en campos de texto de dentro (tienen su menú); con `campos: true` los atiende este.
 */
export function useMenuContextual(construir: ConstructorMenu, opciones: { campos?: boolean } = {}) {
  const contexto = useContext(Contexto);
  const ref = useRef(construir);
  ref.current = construir;
  const campos = !!opciones.campos;
  const onContextMenu = useCallback(
    (e: MouseEventReact<Element>) => {
      if (!contexto) return;
      if (!campos && campoDeTexto(e.target) && e.target !== e.currentTarget) return;
      e.preventDefault();
      e.stopPropagation();
      const { clientX: x, clientY: y } = e;
      const objetivo = e.target as Element;
      const origen = document.activeElement;
      const seleccion = seleccionEn(e.currentTarget);
      const porTeclado = !e.nativeEvent.isTrusted;
      void Promise.resolve(ref.current({ seleccion, objetivo })).then((elementos) => contexto.abrir({ x, y, elementos: limpiar(elementos), origen, porTeclado }));
    },
    [contexto, campos],
  );
  return { onContextMenu };
}

/* ── El menú ──────────────────────────────────────── */

const MARGEN = 8;

/** Opciones de un nivel del menú por las que se mueve el teclado (sin las deshabilitadas). */
const opcionesDe = (p: HTMLElement | null) => [
  ...(p?.querySelectorAll<HTMLElement>(":scope > [role=menuitem]:not([aria-disabled=true]), :scope > .nx-menu__confirmar > [role=menuitem]") ?? []),
];

function Menu({ abierto, alCerrar }: { abierto: Abierto; alCerrar: (devolverFoco?: boolean) => void }) {
  const raiz = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dentro = (n: EventTarget | null) => n instanceof Node && !!raiz.current?.contains(n);
    const fuera = (e: PointerEvent) => !dentro(e.target) && alCerrar(false);
    const desplazar = (e: Event) => !dentro(e.target) && alCerrar(false);
    const cerrarSinFoco = () => alCerrar(false);
    window.addEventListener("pointerdown", fuera, true);
    window.addEventListener("scroll", desplazar, true);
    window.addEventListener("resize", cerrarSinFoco);
    window.addEventListener("blur", cerrarSinFoco);
    return () => {
      window.removeEventListener("pointerdown", fuera, true);
      window.removeEventListener("scroll", desplazar, true);
      window.removeEventListener("resize", cerrarSinFoco);
      window.removeEventListener("blur", cerrarSinFoco);
    };
  }, [alCerrar]);

  return (
    <div className="nx-menus" ref={raiz}>
      <Panel elementos={abierto.elementos} x={abierto.x} y={abierto.y} enfocarPrimero={abierto.porTeclado} alCerrar={alCerrar} />
    </div>
  );
}

/** Un nivel del menú. Los submenús son otro Panel, colocado junto a su elemento. */
function Panel({
  elementos,
  x,
  y,
  junto,
  enfocarPrimero,
  alCerrar,
  alVolver,
}: {
  elementos: ElementoMenu[];
  x: number;
  y: number;
  /** Submenú: rectángulo del elemento que lo abre (se pone a su derecha o, si no cabe, a su izquierda). */
  junto?: DOMRect;
  enfocarPrimero: boolean;
  alCerrar: (devolverFoco?: boolean) => void;
  alVolver?: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [posicion, setPosicion] = useState<{ left: number; top: number }>();
  const [submenu, setSubmenu] = useState<{ indice: number; boton: HTMLElement; rect: DOMRect; teclado: boolean }>();
  const [confirmando, setConfirmando] = useState<number>();
  /** Al cancelar una confirmación, el foco vuelve a la opción destructiva (el «Cancelar» desaparece). */
  const volverA = useRef<number | undefined>(undefined);
  const cancelar = () => {
    volverA.current = confirmando;
    setConfirmando(undefined);
  };
  useEffect(() => {
    if (confirmando !== undefined || volverA.current === undefined) return;
    panel.current?.querySelector<HTMLElement>(`[data-indice="${volverA.current}"]`)?.focus();
    volverA.current = undefined;
  }, [confirmando]);

  // Dentro de la ventana siempre, también si es estrecha.
  useLayoutEffect(() => {
    const p = panel.current;
    if (!p) return;
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    const maxX = window.innerWidth - w - MARGEN;
    const maxY = window.innerHeight - h - MARGEN;
    let left = x;
    let top = y;
    if (junto) {
      left = junto.right - 4;
      if (left > maxX) left = junto.left - w + 4;
      top = junto.top - 6;
    }
    setPosicion({ left: Math.max(MARGEN, Math.min(left, maxX)), top: Math.max(MARGEN, Math.min(top, maxY)) });
  }, [x, y, junto]);

  useEffect(() => {
    if (!posicion) return;
    if (enfocarPrimero) opcionesDe(panel.current)[0]?.focus();
    else panel.current?.focus({ preventScroll: true });
  }, [posicion, enfocarPrimero]);

  const elegir = (e: ElementoMenu, i: number, teclado: boolean, boton?: HTMLElement) => {
    if (e.tipo === "separador" || e.deshabilitado) return;
    if (e.tipo === "submenu") {
      if (boton) setSubmenu({ indice: i, boton, rect: boton.getBoundingClientRect(), teclado });
      return;
    }
    if (e.peligrosa && confirmando !== i) {
      setConfirmando(i);
      return;
    }
    alCerrar();
    void Promise.resolve(e.alElegir());
  };

  const teclas = (ev: KeyboardEventReact<HTMLDivElement>) => {
    const lista = opcionesDe(panel.current);
    const actual = lista.indexOf(document.activeElement as HTMLElement);
    const mover = (i: number) => lista[(i + lista.length) % lista.length]?.focus();
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        mover(actual + 1);
        break;
      case "ArrowUp":
        ev.preventDefault();
        mover(actual < 0 ? -1 : actual - 1);
        break;
      case "Home":
        ev.preventDefault();
        mover(0);
        break;
      case "End":
        ev.preventDefault();
        mover(-1);
        break;
      case "Enter":
      case " ": {
        // Se pulsa la opción con el foco (también desde teclados virtuales o eventos sin acción por defecto).
        const b = document.activeElement as HTMLElement | null;
        if (b?.getAttribute("role") === "menuitem") {
          ev.preventDefault();
          b.click();
        }
        break;
      }
      case "ArrowRight": {
        const b = document.activeElement as HTMLElement | null;
        if (b?.getAttribute("aria-haspopup") === "menu") {
          ev.preventDefault();
          b.click();
        }
        break;
      }
      case "ArrowLeft":
        if (alVolver) {
          ev.preventDefault();
          ev.stopPropagation();
          alVolver();
        }
        break;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        if (confirmando !== undefined) cancelar();
        else if (alVolver) alVolver();
        else alCerrar();
        break;
      case "Tab":
        ev.preventDefault();
        alCerrar();
        break;
    }
  };

  const abiertoSub = submenu ? elementos[submenu.indice] : undefined;

  return (
    <>
      <div
        ref={panel}
        role="menu"
        tabIndex={-1}
        className="nx-menu"
        style={posicion ? { left: posicion.left, top: posicion.top } : { left: x, top: y, visibility: "hidden" }}
        onKeyDown={teclas}
        onContextMenu={(e) => e.preventDefault()}
      >
        {elementos.map((e, i) => {
          if (e.tipo === "separador") {
            // biome-ignore lint/suspicious/noArrayIndexKey: la lista del menú no cambia mientras está abierto.
            return <hr key={i} className="nx-menu__separador" />;
          }
          if (e.tipo !== "submenu" && e.peligrosa && confirmando === i) {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: la lista del menú no cambia mientras está abierto.
              <div key={i} className="nx-menu__confirmar">
                <button type="button" role="menuitem" tabIndex={-1} className="nx-menu__opcion nx-menu__opcion--peligrosa nx-menu__opcion--confirmar" onClick={() => elegir(e, i, false)}>
                  {e.icono && <Icono nombre={e.icono} tamano={15} className="nx-menu__icono" />}
                  <span className="nx-menu__texto">{e.texto}</span>
                </button>
                <ConfirmarCancelar alCancelar={cancelar} />
              </div>
            );
          }
          const sub = e.tipo === "submenu";
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: la lista del menú no cambia mientras está abierto.
              key={i}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-indice={i}
              aria-disabled={e.deshabilitado || undefined}
              aria-haspopup={sub ? "menu" : undefined}
              aria-expanded={sub ? submenu?.indice === i : undefined}
              className={clases("nx-menu__opcion", !sub && e.peligrosa && "nx-menu__opcion--peligrosa", sub && submenu?.indice === i && "nx-menu__opcion--abierta")}
              onClick={(ev) => elegir(e, i, ev.detail === 0, ev.currentTarget)}
              onPointerEnter={(ev) => {
                if (sub && !e.deshabilitado && submenu?.indice !== i) setSubmenu({ indice: i, boton: ev.currentTarget, rect: ev.currentTarget.getBoundingClientRect(), teclado: false });
                else if (submenu) setSubmenu(undefined);
              }}
            >
              {e.icono ? <Icono nombre={e.icono} tamano={15} className="nx-menu__icono" /> : <span className="nx-menu__icono" aria-hidden="true" />}
              <span className="nx-menu__texto">{e.texto}</span>
              {!sub && e.atajo && <span className="nx-menu__atajo">{e.atajo}</span>}
              {sub && <Icono nombre="chevron-derecha" tamano={14} className="nx-menu__flecha" />}
            </button>
          );
        })}
      </div>
      {abiertoSub?.tipo === "submenu" && submenu && (
        <Panel
          key={submenu.indice}
          elementos={abiertoSub.elementos}
          x={0}
          y={0}
          junto={submenu.rect}
          enfocarPrimero={submenu.teclado}
          alCerrar={alCerrar}
          alVolver={() => {
            const boton = submenu.boton;
            setSubmenu(undefined);
            boton.focus();
          }}
        />
      )}
    </>
  );
}

/** «Cancelar» de una confirmación: se lleva el foco, como en el resto de la app. */
function ConfirmarCancelar({ alCancelar }: { alCancelar: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <button ref={ref} type="button" role="menuitem" tabIndex={-1} className="nx-menu__opcion nx-menu__opcion--cancelar" onClick={alCancelar}>
      <span className="nx-menu__texto">Cancelar</span>
    </button>
  );
}

/** Para filas que se pintan dentro de un `map`: da los props del menú a quien los pinta. */
export function ConMenuContextual({ construir, children }: { construir: ConstructorMenu; children: (menu: { onContextMenu: (e: MouseEventReact<Element>) => void }) => ReactNode }) {
  const menu = useMenuContextual(construir);
  return <>{children(menu)}</>;
}
