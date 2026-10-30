/** Canales de Automatizaciones: tarjetas del lienzo y, al configurar uno, su panel. */
import type { InfoCanal } from "@aquiles/protocolo";
import { Boton, Campo, Chip, ConMenuContextual, Etiqueta, Tarjeta, clases } from "@aquiles/ui";
import { useEffect, useState } from "react";
import { useAcciones, useEstado } from "../estado/almacen";
import type { Carga } from "../estado/carga";
import { fechaCompleta, fechaRelativa, hora } from "../estado/formato";
import { useReloj } from "../estado/reloj";
import { ConfirmarBorrado, OpcionesChip } from "./Campos";

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Secretos de los canales: el nombre es el del llavero y ajustes.clave. */
const SECRETOS: Record<string, string> = {
  telegram: "Token del bot",
  discord: "Token del bot",
  slack: "Token del bot",
  "slack-app": "Token de la app",
  correo: "Contraseña",
};

/** Opciones no secretas del correo (canales.configurar). */
const OPCIONES_CORREO = [
  { clave: "servidor", etiqueta: "Servidor" },
  { clave: "puerto", etiqueta: "Puerto" },
  { clave: "usuario", etiqueta: "Usuario" },
  { clave: "de", etiqueta: "De" },
  { clave: "para", etiqueta: "Para" },
] as const;

function estadoCanal(c: InfoCanal): { texto: string; tono: "ok" | "aviso" | "error" | "nada" } {
  if (c.error) return { texto: "Error", tono: "error" };
  if (c.conversa && c.conectado) return { texto: "Conectado", tono: "ok" };
  if (c.configurado) return { texto: "Configurado", tono: c.conversa ? "aviso" : "ok" };
  return { texto: "Sin configurar", tono: "nada" };
}

/** Línea de detalle de la tarjeta: el error, los chats o la cuenta del correo. */
function detalleCanal(c: InfoCanal): string | undefined {
  if (c.error) return c.error;
  if (c.conversa && c.chats.length) return c.chats.length === 1 ? "1 chat" : `${c.chats.length} chats`;
  return c.opciones.usuario ?? c.opciones.servidor;
}

/** Pedidos de Emparejar/Probar desde el menú: numerados en todo el módulo para no repetir uno al volver a abrir un panel. */
let contadorPedidos = 0;
let ultimoAtendido = 0;

export function PanelCanales({ canales }: { canales: Carga<InfoCanal[]> }) {
  const [abierto, setAbierto] = useState<string>();
  /** Emparejar o Probar desde el menú de una tarjeta: se abre su panel y la acción se hace allí (allí se ve el resultado). */
  const [pedido, setPedido] = useState<{ canal: string; accion: "emparejar" | "probar"; n: number }>();
  const pedir = (canal: string, accion: "emparejar" | "probar") => {
    setAbierto(canal);
    setPedido({ canal, accion, n: ++contadorPedidos });
  };
  if (canales.error) {
    return (
      <p className="automatizaciones__error" role="alert">
        {canales.error}
      </p>
    );
  }
  if (!canales.datos) return null;
  const elegido = canales.datos.find((c) => c.id === abierto);
  const actualizar = (n: InfoCanal) => canales.fijar((l) => l.map((x) => (x.id === n.id ? n : x)));
  return (
    <>
      <div className="canales">
        {canales.datos.map((c, i) => {
          const estado = estadoCanal(c);
          const detalle = detalleCanal(c);
          return (
            <ConMenuContextual
              key={c.id}
              construir={() => [
                { texto: "Configurar", icono: "lapiz", alElegir: () => setAbierto(c.id) },
                c.conversa && { texto: "Emparejar", icono: "chat", deshabilitado: !c.configurado, alElegir: () => pedir(c.id, "emparejar") },
                { texto: "Probar", icono: "play", deshabilitado: !c.configurado, alElegir: () => pedir(c.id, "probar") },
              ]}
            >
              {(menu) => (
            <Tarjeta como="article" className={clases("canal", abierto === c.id && "canal--abierto")} {...menu}>
              <span className="canal__numero">{String(i + 1).padStart(2, "0")}</span>
              <div className="canal__cuerpo">
                <h3 className="canal__nombre">{c.nombre}</h3>
                {detalle && <span className={clases("canal__detalle", c.error && "canal__detalle--error")}>{detalle}</span>}
              </div>
              <div className="canal__pie">
                <span className={clases("canal__estado", `canal__estado--${estado.tono}`)}>
                  <i aria-hidden="true" />
                  {estado.texto}
                </span>
                <button type="button" className="origen__enlace" aria-expanded={abierto === c.id} onClick={() => setAbierto((a) => (a === c.id ? undefined : c.id))}>
                  Configurar
                </button>
              </div>
            </Tarjeta>
              )}
            </ConMenuContextual>
          );
        })}
      </div>
      {elegido && <ConfigCanal key={elegido.id} c={elegido} alCambiar={actualizar} pedido={pedido?.canal === elegido.id ? pedido : undefined} />}
    </>
  );
}

function ConfigCanal({ c, alCambiar, pedido }: { c: InfoCanal; alCambiar: (c: InfoCanal) => void; pedido?: { accion: "emparejar" | "probar"; n: number } }) {
  const { sesiones } = useEstado();
  const { llamar, guardarClave, borrarClave, abrirSesion } = useAcciones();
  const [secretos, setSecretos] = useState<Record<string, string>>({});
  const [opciones, setOpciones] = useState<Record<string, string>>(c.opciones);
  const [estado, setEstado] = useState<{ tipo: "guardando" | "ok" } | { tipo: "error"; texto: string }>();
  const [prueba, setPrueba] = useState<{ tipo: "enviando" | "ok" } | { tipo: "error"; texto: string }>();
  const [codigo, setCodigo] = useState<{ codigo: string; caduca: string }>();
  const [errorCodigo, setErrorCodigo] = useState<string>();
  const [quitando, setQuitando] = useState<string>();
  const ahora = useReloj(30_000);
  const claves = Object.keys(c.secretos);
  // El correo tiene sus campos; los demás canales, los que ya traiga el núcleo.
  const camposOpciones =
    c.id === "correo" ? OPCIONES_CORREO.map((o) => ({ ...o })) : Object.keys(c.opciones).map((clave) => ({ clave, etiqueta: clave.charAt(0).toUpperCase() + clave.slice(1) }));
  const opcionesCambiadas = Object.entries(opciones).some(([k, v]) => (c.opciones[k] ?? "") !== v);
  const hayCambios = opcionesCambiadas || Object.values(secretos).some((v) => v.trim());

  const guardar = async () => {
    setEstado({ tipo: "guardando" });
    try {
      for (const [clave, valor] of Object.entries(secretos)) if (valor.trim()) await guardarClave(clave, valor.trim());
      alCambiar(opcionesCambiadas ? await llamar("canales.configurar", { canal: c.id, opciones }) : (await llamar("canales.listar", {})).canales.find((x) => x.id === c.id) ?? c);
      setSecretos({});
      setEstado({ tipo: "ok" });
    } catch (e) {
      setEstado({ tipo: "error", texto: mensaje(e) });
    }
  };

  const quitarSecreto = async (clave: string) => {
    try {
      await borrarClave(clave);
      const n = (await llamar("canales.listar", {})).canales.find((x) => x.id === c.id);
      if (n) alCambiar(n);
    } catch (e) {
      setEstado({ tipo: "error", texto: mensaje(e) });
    }
  };

  const probar = async () => {
    setPrueba({ tipo: "enviando" });
    try {
      await llamar("canales.probar", { canal: c.id });
      setPrueba({ tipo: "ok" });
    } catch (e) {
      setPrueba({ tipo: "error", texto: mensaje(e) });
    }
  };

  const emparejar = async () => {
    try {
      setCodigo(await llamar("canales.emparejar", { canal: c.id }));
      setErrorCodigo(undefined);
    } catch (e) {
      setErrorCodigo(mensaje(e));
    }
  };

  const desemparejar = async (chatId: string) => {
    try {
      alCambiar(await llamar("canales.desemparejar", { canal: c.id, chatId }));
      setQuitando(undefined);
    } catch (e) {
      setEstado({ tipo: "error", texto: mensaje(e) });
    }
  };

  const pedidoN = pedido?.n;
  const pedidoAccion = pedido?.accion;
  // biome-ignore lint/correctness/useExhaustiveDependencies: se atiende cada pedido (su `n`) una sola vez; las funciones son de este render.
  useEffect(() => {
    if (pedidoN === undefined || pedidoN <= ultimoAtendido) return;
    ultimoAtendido = pedidoN;
    if (pedidoAccion === "emparejar") void emparejar();
    if (pedidoAccion === "probar") void probar();
  }, [pedidoN]);

  return (
    <Tarjeta como="section" className="config-canal" aria-label={c.nombre}>
      <h3 className="config-canal__titulo">{c.nombre}</h3>
      {c.error && (
        <p className="automatizaciones__error" role="alert">
          {c.error}
        </p>
      )}

      {(claves.length > 0 || camposOpciones.length > 0) && (
        <div className="config-canal__campos">
          {claves.map((clave) => (
            <div key={clave} className="ajustes__clave">
              <Campo
                etiqueta={SECRETOS[clave] ?? clave}
                type="password"
                mono
                autoComplete="off"
                spellCheck={false}
                placeholder={c.secretos[clave] ? "••••••••••••" : undefined}
                value={secretos[clave] ?? ""}
                onChange={(e) => {
                  setSecretos({ ...secretos, [clave]: e.target.value });
                  setEstado(undefined);
                }}
                sufijo={c.secretos[clave] ? <Chip destacado>Guardado</Chip> : undefined}
              />
              {c.secretos[clave] && (
                <Boton variante="fantasma" tamano="pequeno" icono="papelera" onClick={() => void quitarSecreto(clave)}>
                  Borrar
                </Boton>
              )}
            </div>
          ))}
          {camposOpciones.length > 0 && (
            <div className="ajustes__rejilla">
              {camposOpciones.map((o) => (
                <Campo
                  key={o.clave}
                  etiqueta={o.etiqueta}
                  mono={o.clave !== "de"}
                  spellCheck={false}
                  inputMode={o.clave === "puerto" ? "numeric" : undefined}
                  value={opciones[o.clave] ?? ""}
                  onChange={(e) => {
                    setOpciones({ ...opciones, [o.clave]: e.target.value });
                    setEstado(undefined);
                  }}
                />
              ))}
            </div>
          )}
          {c.id === "correo" && (
            <div className="nx-campo">
              <span className="nx-etiqueta" aria-hidden="true">
                Seguridad
              </span>
              <OpcionesChip
                leyenda="Seguridad"
                opciones={[
                  { valor: "tls", texto: "TLS" },
                  { valor: "starttls", texto: "STARTTLS" },
                ]}
                valor={opciones.seguridad === "starttls" ? "starttls" : "tls"}
                alCambiar={(seguridad) => {
                  setOpciones({ ...opciones, seguridad });
                  setEstado(undefined);
                }}
              />
            </div>
          )}
          <div className="config-canal__botones">
            <Boton variante="acento" disabled={!hayCambios || estado?.tipo === "guardando"} onClick={() => void guardar()}>
              Guardar
            </Boton>
            {estado?.tipo === "ok" && <span className="ajustes__estado">Guardado</span>}
            {estado?.tipo === "error" && (
              <span className="ajustes__estado ajustes__estado--error" role="alert">
                {estado.texto}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="config-canal__botones">
        <Boton variante="secundario" disabled={!c.configurado || prueba?.tipo === "enviando"} onClick={() => void probar()}>
          Probar
        </Boton>
        {c.conversa && (
          <Boton variante="secundario" disabled={!c.configurado} onClick={() => void emparejar()}>
            Emparejar
          </Boton>
        )}
        {prueba?.tipo === "ok" && <span className="ajustes__estado">Enviado</span>}
        {prueba?.tipo === "error" && (
          <span className="ajustes__estado ajustes__estado--error" role="alert">
            {prueba.texto}
          </span>
        )}
      </div>

      {errorCodigo && (
        <p className="automatizaciones__error" role="alert">
          {errorCodigo}
        </p>
      )}
      {codigo && (
        <div className="config-canal__codigo" aria-live="polite">
          <span className="config-canal__cifras">{codigo.codigo}</span>
          <span>
            Envíaselo al bot desde el chat que quieras emparejar. Caduca a las <time dateTime={codigo.caduca}>{hora(codigo.caduca)}</time>.
          </span>
        </div>
      )}

      {c.chats.length > 0 && (
        <div className="config-canal__chats">
          <Etiqueta>Chats</Etiqueta>
          <ul>
            {c.chats.map((chat) => (
              <ConMenuContextual
                key={chat.id}
                construir={() => [
                  chat.sesionId && sesiones[chat.sesionId] && { texto: "Abrir sesión", icono: "flecha-diagonal", alElegir: () => abrirSesion(chat.sesionId!) },
                  { texto: "Desemparejar", icono: "cerrar", peligrosa: true, alElegir: () => void desemparejar(chat.id) },
                ]}
              >
                {(menu) => (
              <li className="chat" {...menu}>
                <div className="chat__datos">
                  <span className="chat__nombre">{chat.nombre}</span>
                  <time className="chat__fecha" dateTime={chat.emparejado} title={fechaCompleta(chat.emparejado)}>
                    {fechaRelativa(chat.emparejado, ahora)}
                  </time>
                </div>
                <span className="chat__acciones">
                  {chat.sesionId && sesiones[chat.sesionId] && (
                    <Boton variante="fantasma" tamano="pequeno" onClick={() => abrirSesion(chat.sesionId!)}>
                      Abrir
                    </Boton>
                  )}
                  {quitando === chat.id ? (
                    <ConfirmarBorrado texto="Desemparejar" alBorrar={() => void desemparejar(chat.id)} alCancelar={() => setQuitando(undefined)} />
                  ) : (
                    <Boton variante="fantasma" tamano="pequeno" onClick={() => setQuitando(chat.id)}>
                      Desemparejar
                    </Boton>
                  )}
                </span>
              </li>
                )}
              </ConMenuContextual>
            ))}
          </ul>
        </div>
      )}
    </Tarjeta>
  );
}
