import { describe, expect, test } from "bun:test";
import { extraerLlamadas, renderizarMensaje, textoVisible } from "../src/proveedores/protocolo-texto";

describe("extraerLlamadas", () => {
  test("separa texto y llamadas", () => {
    const r = extraerLlamadas('Miro el fichero.\n<herramienta nombre="leer">{"ruta":"a.txt"}</herramienta>', "x");
    expect(r.texto).toBe("Miro el fichero.");
    expect(r.llamadas).toEqual([{ id: "x-1", nombre: "leer", argumentos: { ruta: "a.txt" } }]);
  });

  test("varias llamadas con ids distintos", () => {
    const r = extraerLlamadas(
      '<herramienta nombre="leer">{"ruta":"a"}</herramienta>\n<herramienta nombre="leer">{"ruta":"b"}</herramienta>',
      "x",
    );
    expect(r.llamadas.map((l) => l.id)).toEqual(["x-1", "x-2"]);
    expect(r.texto).toBe("");
  });

  test("JSON roto llega como argumento marcado, no revienta", () => {
    const r = extraerLlamadas('<herramienta nombre="leer">{ruta:</herramienta>', "x");
    expect(r.llamadas[0]?.argumentos).toEqual({ __json_invalido: "{ruta:" });
  });

  test("sin llamadas devuelve el texto tal cual", () => {
    expect(extraerLlamadas("hola", "x")).toEqual({ texto: "hola", llamadas: [] });
  });
});

describe("textoVisible", () => {
  test("oculta el bloque desde que empieza la etiqueta", () => {
    expect(textoVisible('Voy.\n<herramienta nombre="leer">{"ru')).toBe("Voy.\n");
  });

  test("retiene un posible comienzo de etiqueta", () => {
    expect(textoVisible("Voy. <her")).toBe("Voy. ");
    expect(textoVisible("a < b")).toBe("a < b");
  });

  test("crece de forma monótona al llegar el texto en trozos", () => {
    const completo = 'Hola <b>mundo</b>.\n<herramienta nombre="leer">{"ruta":"x"}</herramienta>';
    let previo = "";
    for (let i = 1; i <= completo.length; i++) {
      const v = textoVisible(completo.slice(0, i));
      expect(v.startsWith(previo)).toBe(true);
      previo = v;
    }
    expect(previo).toBe("Hola <b>mundo</b>.\n");
  });
});

test("renderizarMensaje marca los resultados con error", () => {
  expect(renderizarMensaje({ rol: "herramienta", id: "h1", nombre: "leer", resultado: "No existe", error: true })).toBe(
    '<resultado herramienta="leer" id="h1" error="si">\nNo existe\n</resultado>',
  );
});

test("renderizarMensaje (agy): los adjuntos van detrás del texto; las imágenes, solo como nota con la ruta", () => {
  const texto = renderizarMensaje({
    rol: "usuario",
    texto: "mira esto",
    adjuntos: [{ id: "a1", nombre: "foto.png", tipo: "image/png", bytes: 10, clase: "imagen", ruta: "C:/datos/a1-foto.png" }],
  });
  expect(texto).toBe(
    'mira esto\n\n<adjunto nombre="foto.png" tipo="image/png" ruta="C:/datos/a1-foto.png">\n' +
      "Imagen que no puedes ver desde aquí. Está guardada en esa ruta: usa tus herramientas si necesitas algo de ella.\n</adjunto>",
  );
});
