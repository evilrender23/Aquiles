import { BloqueCodigo, Boton, Etiqueta, Tarjeta, t } from "@aquiles/ui";
import { useState } from "react";
import type { Pendiente } from "../estado/tipos";

type Aprobacion = Extract<Pendiente, { tipo: "aprobacion" }>;
type Pregunta = Extract<Pendiente, { tipo: "pregunta" }>;

/** Motivos que ya dice el titular; los demás (p. ej. «fuera de la carpeta de trabajo: …») se enseñan. */
const MOTIVOS_OBVIOS = new Set(["ejecuta comandos", "modifica ficheros"]);

function titular(herramienta: string): string {
  if (herramienta === "terminal" || herramienta === "procesos") return t("Aquiles quiere ejecutar un comando");
  if (herramienta === "escribir" || herramienta === "editar") return t("Aquiles quiere modificar un fichero");
  return t("Aquiles quiere usar {herramienta}", { herramienta });
}

export function TarjetaPermiso({ p }: { p: Aprobacion }) {
  const { herramienta, resumen, argumentos, motivo } = p.params;
  return (
    <Tarjeta variante="destacada" relleno={24} className="peticion" role="group" aria-label={t("Permiso")}>
      <Etiqueta tono="lima">{t("Permiso")}</Etiqueta>
      <h2 className="peticion__titulo">{titular(herramienta)}</h2>
      <BloqueCodigo tono="fuerte" codigo={resumen || JSON.stringify(argumentos, null, 2)} />
      {motivo && !MOTIVOS_OBVIOS.has(motivo) && <p className="peticion__motivo">{motivo}</p>}
      <div className="peticion__botones">
        {/* Sin autoFocus: si llega mientras se escribe, un espacio o un Enter lo aprobarían. */}
        <Boton variante="acento" onClick={() => p.responder("permitir")}>
          {t("Permitir una vez")}
        </Boton>
        <Boton variante="contorno" onClick={() => p.responder("siempre")}>
          {t("Siempre en esta sesión")}
        </Boton>
        <Boton variante="fantasma" onClick={() => p.responder("denegar")}>
          {t("Denegar")}
        </Boton>
      </div>
    </Tarjeta>
  );
}

/** Pregunta del agente: opciones como botones (o varias, con `multiple`); también se puede contestar escribiendo. */
export function TarjetaPregunta({ p }: { p: Pregunta }) {
  const { texto, opciones, multiple } = p.params;
  const [elegidas, setElegidas] = useState<string[]>([]);
  const alternar = (o: string) => setElegidas((e) => (e.includes(o) ? e.filter((x) => x !== o) : [...e, o]));
  return (
    <Tarjeta variante="destacada" relleno={24} className="peticion" role="group" aria-label={t("Pregunta")}>
      <Etiqueta tono="lima">{t("Pregunta")}</Etiqueta>
      <h2 className="peticion__titulo">{texto}</h2>
      {opciones && opciones.length > 0 && (
        <div className="peticion__botones">
          {opciones.map((o) =>
            multiple ? (
              <button key={o} type="button" className="nx-chip" aria-pressed={elegidas.includes(o)} onClick={() => alternar(o)}>
                {o}
              </button>
            ) : (
              <Boton key={o} variante="contorno" onClick={() => p.responder(o)}>
                {o}
              </Boton>
            ),
          )}
          {multiple && (
            <Boton variante="acento" disabled={!elegidas.length} onClick={() => p.responder(elegidas.join(", "))}>
              {t("Responder")}
            </Boton>
          )}
        </div>
      )}
    </Tarjeta>
  );
}
