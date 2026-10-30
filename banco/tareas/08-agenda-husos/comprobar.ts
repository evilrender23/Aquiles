import { comprobar, funcion, igual, importar } from "../../comun";

// La zona del proceso no debe influir: se fija una distinta de todas las que se prueban.
process.env.TZ = "Pacific/Auckland";

await comprobar(async (dir) => {
  const m = await importar(dir, "src/agenda.ts");
  const dia = funcion(m, "diaLocal");
  const hora = funcion(m, "horaLocal");
  const agrupar = funcion(m, "agruparPorDia");

  const casos: [string, string, string, string][] = [
    ["2026-03-28T23:30:00Z", "Europe/Madrid", "2026-03-29", "00:30"],
    ["2026-03-28T23:00:00Z", "Europe/Madrid", "2026-03-29", "00:00"],
    ["2026-03-29T00:59:00Z", "Europe/Madrid", "2026-03-29", "01:59"],
    ["2026-03-29T01:30:00Z", "Europe/Madrid", "2026-03-29", "03:30"],
    ["2026-10-25T00:30:00Z", "Europe/Madrid", "2026-10-25", "02:30"],
    ["2026-10-25T01:30:00Z", "Europe/Madrid", "2026-10-25", "02:30"],
    ["2026-07-01T09:00:00+02:00", "Europe/Madrid", "2026-07-01", "09:00"],
    ["2026-07-01T03:00:00Z", "America/Mexico_City", "2026-06-30", "21:00"],
    ["2026-01-01T20:00:00Z", "Asia/Kolkata", "2026-01-02", "01:30"],
    ["2026-12-31T23:59:00Z", "UTC", "2026-12-31", "23:59"],
    ["2026-06-15T12:00:00-03:00", "Atlantic/Canary", "2026-06-15", "16:00"],
  ];
  for (const [iso, zona, d, h] of casos) {
    igual(dia(iso, zona), d, `diaLocal(${iso}, ${zona})`);
    igual(hora(iso, zona), h, `horaLocal(${iso}, ${zona})`);
  }

  const citas = [
    { titulo: "Dentista", inicio: "2026-07-01T08:30:00Z" },
    { titulo: "Reunión", inicio: "2026-07-01T10:00:00+02:00" },
    { titulo: "Cena", inicio: "2026-07-01T19:00:00Z" },
    { titulo: "Madrugada", inicio: "2026-06-30T22:15:00Z" },
    { titulo: "Ayer", inicio: "2026-06-30T09:00:00Z" },
  ];
  igual(
    agrupar(citas, "Europe/Madrid"),
    [
      { dia: "2026-06-30", citas: [{ hora: "11:00", titulo: "Ayer" }] },
      {
        dia: "2026-07-01",
        citas: [
          { hora: "00:15", titulo: "Madrugada" },
          { hora: "10:00", titulo: "Reunión" },
          { hora: "10:30", titulo: "Dentista" },
          { hora: "21:00", titulo: "Cena" },
        ],
      },
    ],
    "agruparPorDia en Europe/Madrid",
  );
  igual(
    agrupar(citas, "America/Mexico_City"),
    [
      {
        dia: "2026-06-30",
        citas: [
          { hora: "03:00", titulo: "Ayer" },
          { hora: "16:15", titulo: "Madrugada" },
        ],
      },
      {
        dia: "2026-07-01",
        citas: [
          { hora: "02:30", titulo: "Dentista" },
          { hora: "02:00", titulo: "Reunión" },
          { hora: "13:00", titulo: "Cena" },
        ].sort((a, b) => a.hora.localeCompare(b.hora)),
      },
    ],
    "agruparPorDia en America/Mexico_City",
  );
  igual(agrupar([], "Europe/Madrid"), [], "agruparPorDia([])");
});
