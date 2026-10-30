//! Proceso principal de Aquiles: ventana, llavero y ciclo de vida del núcleo.
//!
//! Arranque: se genera un token, se lanza el sidecar `aquiles-nucleo --puerto 0` con
//! AQUILES_TOKEN, y se espera en su stdout la línea `AQUILES_READY port=N`. La interfaz
//! pide URL y token con el comando `conexion_nucleo`. El núcleo vigila su stdin: si esta
//! app muere, el pipe se cierra y el núcleo termina solo.

use std::sync::Mutex;
use std::time::Duration;

use rand::RngCore;
use serde::Serialize;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const LINEA_LISTO: &str = "AQUILES_READY port=";
const SERVICIO_LLAVERO: &str = "Aquiles";

struct Nucleo {
    token: String,
    url: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
    hijo: Mutex<Option<CommandChild>>,
}

#[derive(Serialize)]
struct Conexion {
    url: String,
    token: String,
}

#[tauri::command]
async fn conexion_nucleo(nucleo: State<'_, Nucleo>) -> Result<Conexion, String> {
    for _ in 0..300 {
        if let Some(url) = nucleo.url.lock().unwrap().clone() {
            return Ok(Conexion { url, token: nucleo.token.clone() });
        }
        if let Some(error) = nucleo.error.lock().unwrap().clone() {
            return Err(error);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("El núcleo no respondió en 30 s".into())
}

fn entrada(proveedor: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICIO_LLAVERO, proveedor).map_err(|e| e.to_string())
}

#[tauri::command]
fn guardar_clave(proveedor: String, clave: String) -> Result<(), String> {
    entrada(&proveedor)?.set_password(&clave).map_err(|e| e.to_string())
}

#[tauri::command]
fn hay_clave(proveedor: String) -> Result<bool, String> {
    match entrada(&proveedor)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn borrar_clave(proveedor: String) -> Result<(), String> {
    match entrada(&proveedor)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn generar_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn lanzar_nucleo(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let token = generar_token();
    let mut orden = app
        .shell()
        .sidecar("aquiles-nucleo")?
        .args(["--puerto", "0"])
        .env("AQUILES_TOKEN", &token)
        .env("AQUILES_VIGILAR_STDIN", "1");
    if let Ok(carpeta) = app.path().home_dir() {
        orden = orden.current_dir(carpeta);
    }
    if let Ok(clave) = entrada("anthropic").and_then(|e| e.get_password().map_err(|e| e.to_string())) {
        orden = orden.env("AQUILES_CLAVE_ANTHROPIC", clave);
    }
    let (mut eventos, hijo) = orden.spawn()?;
    app.manage(Nucleo {
        token,
        url: Mutex::new(None),
        error: Mutex::new(None),
        hijo: Mutex::new(Some(hijo)),
    });

    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let mut pendiente = String::new();
        while let Some(evento) = eventos.recv().await {
            match evento {
                CommandEvent::Stdout(bytes) => {
                    pendiente.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(fin) = pendiente.find('\n') {
                        let linea: String = pendiente.drain(..=fin).collect();
                        if let Some(puerto) = linea.trim().strip_prefix(LINEA_LISTO) {
                            let url = format!("ws://127.0.0.1:{}", puerto.trim());
                            eprintln!("[aquiles] núcleo listo en {url}");
                            *app.state::<Nucleo>().url.lock().unwrap() = Some(url);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => eprint!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Error(e) => eprintln!("[aquiles] error del núcleo: {e}"),
                CommandEvent::Terminated(estado) => {
                    eprintln!("[aquiles] el núcleo terminó: {:?}", estado.code);
                    let nucleo = app.state::<Nucleo>();
                    *nucleo.url.lock().unwrap() = None;
                    *nucleo.error.lock().unwrap() = Some(format!("El núcleo terminó (código {:?})", estado.code));
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![conexion_nucleo, guardar_clave, hay_clave, borrar_clave])
        .setup(|app| lanzar_nucleo(app))
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar Aquiles")
        .run(|app, evento| {
            if let RunEvent::Exit = evento {
                if let Some(hijo) = app.state::<Nucleo>().hijo.lock().unwrap().take() {
                    let _ = hijo.kill();
                }
            }
        });
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

    /// Escribe, lee y borra una entrada de prueba en el llavero del sistema.
    #[test]
    fn llavero_ida_y_vuelta() {
        let proveedor = format!("prueba-{}", &generar_token()[..8]);
        let valor = generar_token();
        guardar_clave(proveedor.clone(), valor.clone()).unwrap();
        assert!(hay_clave(proveedor.clone()).unwrap());
        assert_eq!(entrada(&proveedor).unwrap().get_password().unwrap(), valor);
        borrar_clave(proveedor.clone()).unwrap();
        assert!(!hay_clave(proveedor).unwrap());
    }
}
