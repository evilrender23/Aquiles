import { asegurar, comprobar, fallar, igual, importar, lanza } from "../../comun";

await comprobar(async (dir) => {
  const { CacheLRU } = await importar(dir, "src/cache.ts");
  if (typeof CacheLRU !== "function") fallar("src/cache.ts no exporta la clase CacheLRU");
  const nueva = (o: Record<string, unknown>) => {
    try {
      return new CacheLRU(o);
    } catch (e) {
      fallar(`new CacheLRU(${JSON.stringify(o)}) lanza: ${e instanceof Error ? e.message : e}`);
    }
  };

  for (const capacidad of [0, -1, 1.5, Number.NaN]) {
    const e = lanza(() => new CacheLRU({ capacidad }), `new CacheLRU({ capacidad: ${capacidad} })`);
    asegurar(e instanceof RangeError, `new CacheLRU({ capacidad: ${capacidad} }) debe lanzar RangeError`);
  }

  // LRU básico
  const c = nueva({ capacidad: 3 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  igual(c.claves(), ["c", "b", "a"], "claves tras tres set");
  igual(c.size, 3, "size");
  igual(c.get("a"), 1, 'get("a")');
  igual(c.claves(), ["a", "c", "b"], "get cuenta como uso");
  c.set("d", 4);
  igual(c.has("b"), false, "se expulsa la usada hace más tiempo");
  igual(c.claves(), ["d", "a", "c"], "claves tras expulsar");
  igual(c.has("c"), true, 'has("c")');
  igual(c.claves(), ["d", "a", "c"], "has no cuenta como uso");
  c.set("e", 5);
  igual(c.claves(), ["e", "d", "a"], "has no salva de la expulsión");
  c.set("a", 10);
  igual(c.claves(), ["a", "e", "d"], "actualizar cuenta como uso");
  igual(c.get("a"), 10, "valor actualizado");
  igual(c.size, 3, "actualizar no cambia el tamaño");
  igual(c.delete("e"), true, 'delete("e")');
  igual(c.delete("e"), false, 'delete("e") otra vez');
  igual(c.size, 2, "size tras delete");
  igual(c.claves(), ["a", "d"], "claves tras delete");
  igual(c.get("nada"), undefined, "get de una clave que no está");
  igual(c.has("nada"), false, "has de una clave que no está");

  const falsos = nueva({ capacidad: 3 });
  falsos.set("cero", 0);
  falsos.set("vacio", "");
  falsos.set("nulo", null);
  igual([falsos.get("cero"), falsos.get("vacio"), falsos.get("nulo")], [0, "", null], "valores falsos");
  igual([falsos.has("cero"), falsos.has("nulo")], [true, true], "has con valores falsos");

  const k1 = { id: 1 };
  const k2 = { id: 1 };
  const objetos = nueva({ capacidad: 2 });
  objetos.set(k1, "uno");
  objetos.set(k2, "dos");
  igual([objetos.get(k1), objetos.get(k2), objetos.size], ["uno", "dos", 2], "claves objeto por identidad");

  const una = nueva({ capacidad: 1 });
  una.set("x", 1);
  una.set("y", 2);
  igual([una.has("x"), una.get("y"), una.size], [false, 2, 1], "capacidad 1");

  // Caducidad
  let t = 0;
  const reloj = () => t;
  const ttl = nueva({ capacidad: 3, ttlMs: 100, ahora: reloj });
  ttl.set("a", 1);
  t = 50;
  ttl.set("b", 2);
  t = 99;
  igual(ttl.get("a"), 1, "aún no caducada (99 ms)");
  t = 100;
  igual(ttl.get("a"), undefined, "caducada a los 100 ms aunque se haya leído");
  igual(ttl.has("a"), false, "has de una caducada");
  igual([ttl.has("b"), ttl.size, ttl.claves()], [true, 1, ["b"]], "solo queda b");
  t = 120;
  ttl.set("b", 3);
  t = 200;
  igual(ttl.get("b"), 3, "set reinicia la caducidad");
  t = 220;
  igual([ttl.has("b"), ttl.size, ttl.claves()], [false, 0, []], "b caduca 100 ms después de su último set");
  ttl.set("c", 1);
  t = 400;
  igual(ttl.delete("c"), false, "delete de una caducada");

  t = 0;
  const hueco = nueva({ capacidad: 2, ttlMs: 10, ahora: reloj });
  hueco.set("a", 1);
  t = 5;
  hueco.set("b", 2);
  t = 6;
  hueco.get("a");
  t = 10;
  hueco.set("c", 3);
  igual(hueco.claves(), ["c", "b"], "las caducadas no ocupan sitio al expulsar");
  igual(hueco.get("b"), 2, "b sigue tras expulsar la caducada");

  t = 0;
  const eterna = nueva({ capacidad: 2, ahora: reloj });
  eterna.set("a", 1);
  t = 1e12;
  igual(eterna.get("a"), 1, "sin ttlMs nada caduca");

  const real = nueva({ capacidad: 2, ttlMs: 60_000 });
  real.set("a", 1);
  igual(real.get("a"), 1, "reloj por defecto");
});
