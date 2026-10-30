import { asegurar, comprobar, fallar, funcion, igual, importar } from "../../comun";

// En la versión rota quedan promesas rechazadas sin atender; que no tumben el comprobador.
process.on("unhandledRejection", () => {});

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Promesa con límite de tiempo, para detectar promesas que nunca terminan. */
async function conLimite<T>(p: Promise<T>, contexto: string, ms = 2000): Promise<T> {
  let t: Timer | undefined;
  const limite = new Promise<never>((_, rechazar) => {
    t = setTimeout(() => rechazar(new Error(`${contexto}: no termina en ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, limite]);
  } finally {
    clearTimeout(t);
  }
}

async function resuelve<T>(p: Promise<T>, contexto: string): Promise<T> {
  try {
    return await conLimite(p, contexto);
  } catch (e) {
    fallar(`${contexto}: rechaza con "${e instanceof Error ? e.message : String(e)}" y debía resolverse`);
  }
}

async function rechaza(p: Promise<unknown>, contexto: string): Promise<unknown> {
  try {
    await conLimite(p, contexto);
  } catch (e) {
    if (e instanceof Error && e.message.includes("no termina")) throw e;
    return e;
  }
  fallar(`${contexto}: debía rechazar`);
}

await comprobar(async (dir) => {
  const m = await importar(dir, "src/sincronizar.ts");
  const reintentar = funcion(m, "reintentar");
  const sincronizar = funcion(m, "sincronizar");

  // --- reintentar
  let llamadas = 0;
  const fallaDosVeces = async () => {
    llamadas++;
    await espera(1);
    if (llamadas < 3) throw new Error(`fallo ${llamadas}`);
    return "bien";
  };
  igual(await resuelve(reintentar(fallaDosVeces), "reintentar tras dos fallos"), "bien", "reintentar tras dos fallos");
  igual(llamadas, 3, "llamadas de reintentar tras dos fallos");

  llamadas = 0;
  const siempreFalla = async () => {
    llamadas++;
    throw new Error(`fallo ${llamadas}`);
  };
  const e1 = await rechaza(reintentar(siempreFalla, 4), "reintentar con fallos siempre");
  igual(e1 instanceof Error ? e1.message : e1, "fallo 4", "reintentar rechaza con el último error");
  igual(llamadas, 4, "llamadas de reintentar(fn, 4)");
  llamadas = 0;
  await rechaza(reintentar(siempreFalla, 1), "reintentar(fn, 1)");
  igual(llamadas, 1, "llamadas de reintentar(fn, 1)");

  // --- sincronizar
  const valores: Record<string, number> = { a: 1, b: 20, c: 300, d: 4000, e: 50000 };
  const retrasos: Record<string, number> = { a: 40, b: 5, c: 25, d: 1, e: 15 };
  let activas = 0;
  let maxActivas = 0;
  const intentosPorId: Record<string, number> = {};
  const fuente = (fallan: Record<string, number> = {}) => ({
    async obtener(id: string) {
      intentosPorId[id] = (intentosPorId[id] ?? 0) + 1;
      activas++;
      maxActivas = Math.max(maxActivas, activas);
      await espera(retrasos[id] ?? 1);
      activas--;
      if (intentosPorId[id]! <= (fallan[id] ?? 0)) throw new Error(`no se pudo descargar ${id}`);
      return { id, valor: valores[id]! };
    },
  });
  const destino = () => {
    const d = {
      llamadas: [] as { id: string; valor: number }[][],
      terminado: false,
      async guardar(registros: { id: string; valor: number }[]) {
        d.llamadas.push([...registros]);
        await espera(20);
        d.terminado = true;
      },
    };
    return d;
  };

  const ids = ["a", "b", "c", "d", "e"];
  const d1 = destino();
  const r1 = await resuelve(sincronizar(ids, fuente(), d1), "sincronizar");
  igual(r1, { guardados: 5, total: 54321 }, "resumen de sincronizar");
  igual(d1.llamadas.length, 1, "número de llamadas a guardar");
  igual(d1.llamadas[0]!.map((r) => r.id), ids, "orden de los registros guardados");
  asegurar(d1.terminado, "sincronizar termina antes de que acabe el guardado");
  asegurar(maxActivas >= 3, `las descargas no van a la vez (como mucho ${maxActivas} simultáneas)`);

  for (const k of Object.keys(intentosPorId)) delete intentosPorId[k];
  const d2 = destino();
  const r2 = await resuelve(sincronizar(["c", "a", "e"], fuente({ a: 2 }), d2), "sincronizar con fallos temporales");
  igual(r2, { guardados: 3, total: 50301 }, "resumen con una descarga que falla dos veces");
  igual(d2.llamadas[0]?.map((r) => r.id), ["c", "a", "e"], "orden con reintentos");

  for (const k of Object.keys(intentosPorId)) delete intentosPorId[k];
  const d3 = destino();
  const e3 = await rechaza(sincronizar(ids, fuente({ d: 99 }), d3), "sincronizar con una descarga rota");
  igual(e3 instanceof Error ? e3.message : e3, "no se pudo descargar d", "error de sincronizar");
  await espera(60);
  igual(d3.llamadas.length, 0, "si falla una descarga no se guarda nada");

  const roto = { async guardar() { await espera(5); throw new Error("disco lleno"); } };
  const e4 = await rechaza(sincronizar(["a"], fuente(), roto), "sincronizar con el guardado roto");
  igual(e4 instanceof Error ? e4.message : e4, "disco lleno", "error del guardado");

  igual(await resuelve(sincronizar([], fuente(), destino()), "sincronizar([])"), { guardados: 0, total: 0 }, "sincronizar([])");
});
