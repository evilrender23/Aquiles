//! Ciclo de vida del núcleo.
//!
//! Se lanza el sidecar `aquiles-nucleo --puerto 0 --perfil P` con AQUILES_TOKEN y se espera
//! en su stdout la línea `AQUILES_READY port=N`. La interfaz pide URL y token con
//! `conexion_nucleo`. El núcleo vigila su stdin: si esta app muere, el pipe se cierra y él
//! termina solo. Si es el núcleo el que cae, el vigilante lo relanza; si `app.json` tiene un
//! núcleo remoto, no se lanza el local y la interfaz se conecta a ese.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::watch;

use crate::config::{self, Remoto};
use crate::llavero;

const LINEA_LISTO: &str = "AQUILES_READY port=";
/// Código de salida con el que el núcleo pide que lo relancen (copia restaurada, cambio de perfil).
const CODIGO_REINICIO: i32 = 75;
/// Segundos de espera antes de cada relanzamiento seguido; agotados, se deja de intentar.
const ESPERAS: [u64; 5] = [1, 2, 5, 10, 20];
/// Una caída tras este tiempo funcionando vuelve a contar como la primera.
const ESTABLE: Duration = Duration::from_secs(60);
const ESPERA_CONEXION: Duration = Duration::from_secs(60);
/// Entrada del llavero con el token del núcleo remoto.
const CLAVE_REMOTO: &str = "remoto";
/// Avisa a las ventanas de que el núcleo vuelve a estar listo (otro proceso, otro perfil u
/// otro servidor): tienen que pedir `conexion_nucleo` y reconectar.
pub const EVENTO_REINICIADO: &str = "nucleo-reiniciado";

#[derive(Clone, Serialize)]
pub struct Conexion {
    url: String,
    token: String,
}

#[derive(Clone)]
enum Estado {
    Arrancando,
    Listo(Conexion),
    Fallo(String),
}

struct Proceso {
    hijo: Option<CommandChild>,
    /// Sube con cada lanzamiento o parada. El vigilante de un proceso que ya no es el actual
    /// (parado para salir, cambiar de perfil o pasar a remoto) no lo relanza.
    generacion: u64,
    fallos: usize,
}

pub struct Nucleo {
    /// Uno para toda la vida de la app: los relanzamientos usan el mismo.
    token: String,
    estado: watch::Sender<Estado>,
    proceso: Mutex<Proceso>,
}

impl Nucleo {
    pub fn new() -> Self {
        Self {
            token: generar_token(),
            estado: watch::Sender::new(Estado::Arrancando),
            proceso: Mutex::new(Proceso { hijo: None, generacion: 0, fallos: 0 }),
        }
    }
}

pub fn generar_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parar_hijo(proceso: &mut Proceso) {
    proceso.generacion += 1;
    if let Some(hijo) = proceso.hijo.take() {
        let _ = hijo.kill();
    }
}

/// Mata el núcleo local sin que el vigilante lo relance.
pub fn parar(app: &AppHandle) {
    parar_hijo(&mut app.state::<Nucleo>().proceso.lock().unwrap());
}

/// Pone en marcha el núcleo que diga `app.json`: el remoto si lo hay y, si no, el sidecar local
/// (parando antes el que hubiera). Con `avisar`, emite `nucleo-reiniciado` cuando está listo.
pub fn arrancar(app: &AppHandle, avisar: bool) {
    let nucleo = app.state::<Nucleo>();
    let config = config::leer();
    let mut proceso = nucleo.proceso.lock().unwrap();
    parar_hijo(&mut proceso);
    if let Some(Remoto { url }) = config.remoto {
        drop(proceso);
        let estado = match llavero::leer(CLAVE_REMOTO) {
            Some(token) => Estado::Listo(Conexion { url, token }),
            None => Estado::Fallo("Falta el token del núcleo remoto: vuelve a conectarlo".into()),
        };
        nucleo.estado.send_replace(estado);
        if avisar {
            let _ = app.emit(EVENTO_REINICIADO, ());
        }
        return;
    }
    nucleo.estado.send_replace(Estado::Arrancando);
    match lanzar(app, &nucleo.token, &config.perfil, proceso.generacion, avisar) {
        Ok(hijo) => proceso.hijo = Some(hijo),
        Err(e) => {
            eprintln!("[aquiles] no se pudo lanzar el núcleo: {e}");
            nucleo.estado.send_replace(Estado::Fallo(format!("No se pudo lanzar el núcleo: {e}")));
        }
    }
}

/// Lo que hace el usuario (cambiar de perfil, de servidor, reintentar) empieza con el contador
/// de caídas a cero.
fn reiniciar(app: &AppHandle, avisar: bool) {
    app.state::<Nucleo>().proceso.lock().unwrap().fallos = 0;
    arrancar(app, avisar);
}

fn lanzar(app: &AppHandle, token: &str, perfil: &str, generacion: u64, avisar: bool) -> Result<CommandChild, String> {
    let mut orden = app
        .shell()
        .sidecar("aquiles-nucleo")
        .map_err(|e| e.to_string())?
        .args(["--puerto", "0", "--perfil", perfil])
        .env("AQUILES_TOKEN", token)
        .env("AQUILES_VIGILAR_STDIN", "1");
    if let Ok(carpeta) = app.path().home_dir() {
        orden = orden.current_dir(carpeta);
    }
    #[cfg(target_os = "macos")]
    if let Some(path) = path_de_la_shell() {
        orden = orden.env("PATH", path);
    }
    // Se leen en cada lanzamiento: una clave guardada en Ajustes vale tras el siguiente reinicio.
    for (nombre, variable) in llavero::CLAVES {
        if let Some(clave) = llavero::leer(nombre) {
            orden = orden.env(variable, clave);
        }
    }
    let (mut eventos, hijo) = orden.spawn().map_err(|e| e.to_string())?;
    eprintln!("[aquiles] núcleo lanzado con el perfil {perfil}");

    let app = app.clone();
    let inicio = Instant::now();
    tauri::async_runtime::spawn(async move {
        let mut pendiente = String::new();
        while let Some(evento) = eventos.recv().await {
            match evento {
                CommandEvent::Stdout(bytes) => {
                    pendiente.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(fin) = pendiente.find('\n') {
                        let linea: String = pendiente.drain(..=fin).collect();
                        if let Some(puerto) = linea.trim().strip_prefix(LINEA_LISTO) {
                            listo(&app, generacion, format!("ws://127.0.0.1:{}", puerto.trim()), avisar);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => eprint!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Error(e) => eprintln!("[aquiles] error del núcleo: {e}"),
                CommandEvent::Terminated(estado) => {
                    eprintln!("[aquiles] el núcleo terminó: {:?}", estado.code);
                    tras_terminar(&app, generacion, estado.code, inicio.elapsed()).await;
                }
                _ => {}
            }
        }
    });
    Ok(hijo)
}

/// Abierta desde el Finder o el Dock, la app hereda un PATH mínimo (/usr/bin:/bin…) y el núcleo
/// no encontraría `claude`, `codex`, `agy`, `git` ni lo de Homebrew. Se pide el de la shell del
/// usuario una vez, con sus ficheros de inicio; las marcas separan el PATH de lo que impriman.
#[cfg(target_os = "macos")]
fn path_de_la_shell() -> Option<String> {
    use std::process::{Command, Stdio};
    use std::sync::OnceLock;
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut hijo = Command::new(shell)
            .args(["-ilc", "printf '<<PATH>>%s<<PATH>>' \"$PATH\""])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let inicio = Instant::now();
        while hijo.try_wait().ok()?.is_none() {
            if inicio.elapsed() > Duration::from_secs(5) {
                let _ = hijo.kill();
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let salida = String::from_utf8_lossy(&hijo.wait_with_output().ok()?.stdout).into_owned();
        let path = salida.split("<<PATH>>").nth(1)?.trim();
        (!path.is_empty()).then(|| path.to_string())
    })
    .clone()
}

fn listo(app: &AppHandle, generacion: u64, url: String, avisar: bool) {
    let nucleo = app.state::<Nucleo>();
    if nucleo.proceso.lock().unwrap().generacion != generacion {
        return;
    }
    eprintln!("[aquiles] núcleo listo en {url}");
    nucleo.estado.send_replace(Estado::Listo(Conexion { url, token: nucleo.token.clone() }));
    if avisar {
        let _ = app.emit(EVENTO_REINICIADO, ());
    }
}

/// Cuánto esperar para relanzar un núcleo que ha terminado solo tras `vivo` en marcha, o
/// `None` si ya se ha intentado bastante. Lleva la cuenta de caídas seguidas en `fallos`.
fn espera_para_relanzar(codigo: Option<i32>, vivo: Duration, fallos: &mut usize) -> Option<Duration> {
    // Reinicio pedido por el propio núcleo: enseguida y sin contar como caída.
    if codigo == Some(CODIGO_REINICIO) {
        return Some(Duration::ZERO);
    }
    if vivo >= ESTABLE {
        *fallos = 0;
    }
    let espera = Duration::from_secs(*ESPERAS.get(*fallos)?);
    *fallos += 1;
    Some(espera)
}

/// El vigilante: decide si relanzar el núcleo que acaba de terminar y cuándo.
async fn tras_terminar(app: &AppHandle, generacion: u64, codigo: Option<i32>, vivo: Duration) {
    let nucleo = app.state::<Nucleo>();
    let espera = {
        let mut proceso = nucleo.proceso.lock().unwrap();
        if proceso.generacion != generacion {
            return;
        }
        proceso.hijo = None;
        let Some(espera) = espera_para_relanzar(codigo, vivo, &mut proceso.fallos) else {
            let error = format!("El núcleo se ha cerrado {} veces seguidas (último código {codigo:?})", proceso.fallos + 1);
            eprintln!("[aquiles] {error}: no se relanza más");
            nucleo.estado.send_replace(Estado::Fallo(error));
            return;
        };
        espera
    };
    // Mientras tanto, `conexion_nucleo` espera a la URL nueva en vez de dar la vieja.
    nucleo.estado.send_replace(Estado::Arrancando);
    eprintln!("[aquiles] se relanza el núcleo en {} s", espera.as_secs());
    tokio::time::sleep(espera).await;
    // Durante la espera pudo cambiarse de perfil o de servidor, y eso ya lo arrancó.
    if nucleo.proceso.lock().unwrap().generacion != generacion {
        return;
    }
    arrancar(app, true);
}

#[tauri::command]
pub async fn conexion_nucleo(app: AppHandle, nucleo: State<'_, Nucleo>) -> Result<Conexion, String> {
    // Si el vigilante se rindió, volver a pedir la conexión es la forma de reintentar.
    if matches!(*nucleo.estado.borrow(), Estado::Fallo(_)) {
        reiniciar(&app, false);
    }
    let mut estado = nucleo.estado.subscribe();
    let resultado = tokio::time::timeout(ESPERA_CONEXION, estado.wait_for(|e| !matches!(e, Estado::Arrancando))).await;
    match resultado.map(|r| r.map(|e| e.clone())) {
        Ok(Ok(Estado::Listo(conexion))) => Ok(conexion),
        Ok(Ok(Estado::Fallo(error))) => Err(error),
        _ => Err(format!("El núcleo no respondió en {} s", ESPERA_CONEXION.as_secs())),
    }
}

#[tauri::command]
pub fn perfil_actual() -> String {
    config::leer().perfil
}

/// Guarda el perfil en `app.json` y relanza el núcleo con él. Con un núcleo remoto solo se
/// guarda: se usará al volver al local.
#[tauri::command]
pub fn cambiar_perfil(app: AppHandle, nombre: String) -> Result<(), String> {
    if !config::perfil_valido(&nombre) {
        return Err(format!(
            "Nombre de perfil no válido: «{nombre}». Usa minúsculas, cifras, - y _ (hasta 40, sin empezar por - ni _)"
        ));
    }
    let mut config = config::leer();
    if config.perfil == nombre {
        return Ok(());
    }
    config.perfil = nombre;
    config::guardar(&config)?;
    if config.remoto.is_none() {
        reiniciar(&app, true);
    }
    Ok(())
}

/// URL del núcleo remoto configurado, o `None` si se usa el local.
#[tauri::command]
pub fn remoto_actual() -> Option<String> {
    config::leer().remoto.map(|r| r.url)
}

#[tauri::command]
pub fn conectar_remoto(app: AppHandle, url: String, token: String) -> Result<(), String> {
    let url = url.trim();
    let valida = Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "ws" | "wss") && u.host().is_some());
    if !valida {
        return Err(format!("«{url}» no es una dirección de núcleo: tiene que empezar por ws:// o wss://"));
    }
    let token = token.trim();
    if token.is_empty() {
        return Err("Falta el token del núcleo remoto".into());
    }
    llavero::guardar_clave(CLAVE_REMOTO.into(), token.into())?;
    let mut config = config::leer();
    config.remoto = Some(Remoto { url: url.into() });
    config::guardar(&config)?;
    reiniciar(&app, true);
    Ok(())
}

#[tauri::command]
pub fn desconectar_remoto(app: AppHandle) -> Result<(), String> {
    let mut config = config::leer();
    if config.remoto.take().is_none() {
        return Ok(());
    }
    config::guardar(&config)?;
    llavero::borrar_clave(CLAVE_REMOTO.into())?;
    reiniciar(&app, true);
    Ok(())
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn token_de_64_hex_y_distinto() {
        let a = generar_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, generar_token());
    }

    #[test]
    fn vigilante_espera_cada_vez_mas_y_se_rinde_al_quinto() {
        let breve = Duration::from_secs(3);
        let mut fallos = 0;
        let esperas: Vec<_> = std::iter::from_fn(|| espera_para_relanzar(Some(1), breve, &mut fallos)).collect();
        let segundos: Vec<_> = esperas.iter().map(Duration::as_secs).collect();
        assert_eq!(segundos, [1, 2, 5, 10, 20]);
        assert_eq!(espera_para_relanzar(None, breve, &mut fallos), None);
    }

    #[test]
    fn vigilante_reinicio_pedido_y_cuenta_a_cero() {
        let mut fallos = 3;
        // Código 75: enseguida y sin contar.
        assert_eq!(espera_para_relanzar(Some(CODIGO_REINICIO), Duration::ZERO, &mut fallos), Some(Duration::ZERO));
        assert_eq!(fallos, 3);
        // Tras un minuto funcionando, la caída vuelve a ser la primera.
        assert_eq!(espera_para_relanzar(Some(1), ESTABLE, &mut fallos), Some(Duration::from_secs(1)));
        assert_eq!(fallos, 1);
        // Agotados los intentos, el reinicio pedido sigue relanzando.
        let mut fallos = ESPERAS.len();
        assert_eq!(espera_para_relanzar(Some(1), Duration::ZERO, &mut fallos), None);
        assert_eq!(espera_para_relanzar(Some(CODIGO_REINICIO), Duration::ZERO, &mut fallos), Some(Duration::ZERO));
    }
}
