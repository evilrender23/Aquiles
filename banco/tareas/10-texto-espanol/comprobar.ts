import { asegurar, comprobar, funcion, igual, importar } from "../../comun";

await comprobar(async (dir) => {
  const m = await importar(dir, "src/texto.ts");
  const slug = funcion(m, "slugificar");
  const ordenar = funcion(m, "ordenarAlfabeticamente");
  const contar = funcion(m, "contarPalabras");

  const slugs: [string, string][] = [
    ["Año Nuevo en Cádiz", "ano-nuevo-en-cadiz"],
    ["¡Pingüinos en la Antártida!", "pinguinos-en-la-antartida"],
    ["  El niño   y el ÑANDÚ -- 2026 ", "el-nino-y-el-nandu-2026"],
    ["¿Qué es «IA»?", "que-es-ia"],
    ["Camión, acción y corazón", "camion-accion-y-corazon"],
    ["hello world", "hello-world"],
  ];
  for (const [t, s] of slugs) igual(slug(t), s, `slugificar(${JSON.stringify(t)})`);

  const palabras = ["oso", "ñandú", "nube", "Árbol", "zeta", "abeja", "Ávila", "ama", "Ñu", "nuez", "Barco", "éxito", "espada"];
  const copia = [...palabras];
  igual(
    ordenar(palabras),
    ["abeja", "ama", "Árbol", "Ávila", "Barco", "espada", "éxito", "nube", "nuez", "ñandú", "Ñu", "oso", "zeta"],
    "ordenarAlfabeticamente",
  );
  igual(palabras, copia, "ordenarAlfabeticamente no debe modificar la lista");

  const cuenta = contar("¿Qué tal, señor? ¡QUÉ alegría, Señor! El pingüino y el PINGÜINO.");
  asegurar(cuenta instanceof Map, "contarPalabras debe devolver un Map");
  igual(
    Object.fromEntries([...cuenta.entries()].sort(([a], [b]) => a.localeCompare(b))),
    { alegría: 1, el: 2, pingüino: 2, qué: 2, señor: 2, tal: 1, y: 1 },
    "contarPalabras",
  );
});
