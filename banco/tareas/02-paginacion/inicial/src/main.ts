import { paginar } from "./paginar";

const productos = Array.from({ length: 23 }, (_, i) => `Producto ${i + 1}`);

for (let p = 1; p <= 3; p++) {
  const r = paginar(productos, p, 10);
  console.log(`Página ${r.pagina}/${r.totalPaginas}: ${r.elementos.join(", ") || "(vacía)"}`);
  console.log(`  anterior: ${r.hayAnterior ? "sí" : "no"} · siguiente: ${r.haySiguiente ? "sí" : "no"}`);
}
