import { BUN, buscar, comprobar, ejecutar, fallar, funcion, igual, importar, leer, resumir } from "../../comun";

await comprobar(async (dir) => {
  let config: any;
  try {
    config = JSON.parse(leer(dir, "config/app.json"));
  } catch (e) {
    fallar(`config/app.json no es JSON válido: ${e instanceof Error ? e.message : e}`);
  }

  const admitidos: unknown = config?.idiomas?.admitidos;
  if (!Array.isArray(admitidos)) fallar("idiomas.admitidos ya no es una lista");
  igual([...admitidos].sort(), ["ca", "en", "es", "fr"], "idiomas admitidos");
  igual(
    { ...config, idiomas: { ...config.idiomas, admitidos: "(comprobado aparte)" } },
    {
      nombre: "tienda-online",
      version: 4,
      servidor: { host: "0.0.0.0", puerto: 8080, tiempoEsperaMs: 30000 },
      idiomas: { porDefecto: "es", admitidos: "(comprobado aparte)" },
      entornos: {
        desarrollo: { depuracion: true, registro: "debug" },
        produccion: { depuracion: false, registro: "warn" },
      },
      funciones: { carritoNuevo: true, pagoBizum: true },
    },
    "config/app.json",
  );

  const restos = buscar(dir, /legacy/i, /\.(ts|json)$/);
  if (restos.length) fallar(`quedan restos de la API antigua:\n${restos.slice(0, 6).join("\n")}`);

  const { cargarConfig } = await importar(dir, "src/config.ts");
  const cargada = cargarConfig();
  const { rutas } = await importar(dir, "src/rutas.ts");
  igual(funcion({ rutas }, "rutas")(cargada), ["/api/v1/productos", "/api/v1/carrito", "/api/v1/pagos/bizum"], "rutas con la configuración nueva");

  const arranque = ejecutar([BUN, "src/main.ts"], { cwd: dir, env: { ENTORNO: "produccion" } });
  if (arranque.codigo !== 0) fallar(`la aplicación no arranca:\n${resumir(arranque.todo)}`);
  igual(
    arranque.stdout.trim().split("\n"),
    [
      "tienda-online v4 (produccion) en 0.0.0.0:8080",
      "Idiomas: es, en, ca, fr · registro: warn",
      "  /api/v1/productos",
      "  /api/v1/carrito",
      "  /api/v1/pagos/bizum",
    ].map((l) => (l.startsWith("Idiomas") ? `Idiomas: ${cargada.idiomas.admitidos.join(", ")} · registro: warn` : l)),
    "salida de bun src/main.ts en producción",
  );
});
