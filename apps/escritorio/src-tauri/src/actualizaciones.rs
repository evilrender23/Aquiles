//! Actualizaciones firmadas. Se buscan en el `latest.json` de la última release de GitHub
//! (`plugins.updater.endpoints`) y se instalan con el instalador NSIS, que relanza la app.
//! El plugin rechaza un paquete cuya firma no cuadre con `plugins.updater.pubkey`.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, Url};
use tauri_plugin_updater::{Update, UpdaterBuilder, UpdaterExt};

use crate::nucleo;

/// Sustituye al endpoint de tauri.conf.json, para probar con un servidor local. En release el
/// plugin solo acepta https; en debug también http.
const VARIABLE_ENDPOINT: &str = "AQUILES_ACTUALIZACIONES";
const EVENTO_PROGRESO: &str = "actualizacion-progreso";
/// Cada cuántos bytes descargados se avisa a la interfaz.
const PASO_PROGRESO: u64 = 256 * 1024;

#[derive(Debug, Serialize)]
pub struct InfoActualizacion {
    version: String,
    notas: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progreso {
    descargados: u64,
    total: Option<u64>,
}

fn actualizador<R: Runtime>(app: &AppHandle<R>) -> Result<UpdaterBuilder, String> {
    let constructor = app.updater_builder();
    let Ok(endpoint) = std::env::var(VARIABLE_ENDPOINT) else {
        return Ok(constructor);
    };
    let url = Url::parse(&endpoint).map_err(|e| format!("{VARIABLE_ENDPOINT} no es una URL: {e}"))?;
    constructor.endpoints(vec![url]).map_err(|e| e.to_string())
}

async fn buscar<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, String> {
    let actualizador = actualizador(app)?.build().map_err(|e| e.to_string())?;
    actualizador.check().await.map_err(|e| format!("No se pudo comprobar si hay actualizaciones: {e}"))
}

#[tauri::command]
pub async fn buscar_actualizacion(app: AppHandle) -> Result<Option<InfoActualizacion>, String> {
    Ok(buscar(&app).await?.map(|u| InfoActualizacion { version: u.version, notas: u.body }))
}

/// Descarga, comprueba la firma, instala y relanza. En Windows el instalador cierra la app
/// él mismo, así que esto solo vuelve si algo falla.
#[tauri::command]
pub async fn instalar_actualizacion(app: AppHandle) -> Result<(), String> {
    let actualizacion = buscar(&app).await?.ok_or("No hay ninguna actualización")?;
    let paquete = descargar(&app, &actualizacion).await?;
    // El instalador sustituye el .exe del núcleo, que no puede estar en marcha.
    nucleo::parar(&app);
    if let Err(e) = actualizacion.install(&paquete) {
        nucleo::arrancar(&app, true);
        return Err(format!("No se pudo instalar la actualización: {e}"));
    }
    app.restart()
}

async fn descargar<R: Runtime>(app: &AppHandle<R>, actualizacion: &Update) -> Result<Vec<u8>, String> {
    let mut descargados = 0u64;
    let mut avisados = 0u64;
    let paquete = actualizacion
        .download(
            |trozo, total| {
                descargados += trozo as u64;
                if descargados - avisados >= PASO_PROGRESO {
                    avisados = descargados;
                    let _ = app.emit(EVENTO_PROGRESO, Progreso { descargados, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("No se pudo descargar la actualización: {e}"))?;
    let total = paquete.len() as u64;
    let _ = app.emit(EVENTO_PROGRESO, Progreso { descargados: total, total: Some(total) });
    Ok(paquete)
}

#[cfg(test)]
mod pruebas {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::Path;

    use super::*;

    /// Sirve cada `(ruta, cuerpo)` por HTTP, una petición por conexión.
    fn servir(escucha: TcpListener, rutas: Vec<(String, Vec<u8>)>) {
        std::thread::spawn(move || {
            for conexion in escucha.incoming().flatten() {
                let mut lector = BufReader::new(&conexion);
                let mut peticion = String::new();
                let _ = lector.read_line(&mut peticion);
                let mut cabecera = String::new();
                while lector.read_line(&mut cabecera).is_ok_and(|n| n > 2) {
                    cabecera.clear();
                }
                let ruta = peticion.split_whitespace().nth(1).unwrap_or_default();
                let cuerpo = rutas.iter().find(|(r, _)| r == ruta).map(|(_, c)| c.as_slice());
                let estado = if cuerpo.is_some() { "200 OK" } else { "404 Not Found" };
                let cuerpo = cuerpo.unwrap_or_default();
                let mut salida = &conexion;
                let _ = write!(salida, "HTTP/1.1 {estado}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", cuerpo.len());
                let _ = salida.write_all(cuerpo);
            }
        });
    }

    /// Una app de prueba con el updater configurado como en tauri.conf.json (misma clave pública).
    fn app_de_prueba() -> tauri::App<tauri::test::MockRuntime> {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut contexto = tauri::test::mock_context(tauri::test::noop_assets());
        contexto.config_mut().plugins.0.insert("updater".into(), conf["plugins"]["updater"].clone());
        tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(contexto).unwrap()
    }

    /// Prueba de verdad con el instalador que deja el build release firmado
    /// (`TAURI_SIGNING_PRIVATE_KEY` + `bun x tauri build`): un latest.json con una versión mayor
    /// apunta a él; se encuentra, la descarga pasa la firma y el mismo instalador con un byte
    /// cambiado no. No se ejecuta nada.
    #[test]
    #[ignore = "necesita el instalador firmado del build release"]
    fn encuentra_y_verifica_el_instalador_firmado() {
        let carpeta = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/release/bundle/nsis");
        let instalador = std::fs::read_dir(&carpeta)
            .expect("falta target/release/bundle/nsis")
            .flatten()
            .map(|e| e.path())
            .find(|r| r.to_string_lossy().ends_with("-setup.exe"))
            .expect("falta el instalador NSIS");
        let firma = std::fs::read_to_string(format!("{}.sig", instalador.display())).expect("falta el .sig del instalador");
        let original = std::fs::read(&instalador).unwrap();
        let mut alterado = original.clone();
        let mitad = alterado.len() / 2;
        alterado[mitad] ^= 0xff;

        let escucha = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", escucha.local_addr().unwrap());
        let manifiesto = |paquete: &str| {
            serde_json::json!({
                "version": "99.0.0",
                "notes": "Versión de prueba",
                "pub_date": "2026-10-30T00:00:00Z",
                "platforms": { "windows-x86_64": { "url": format!("{base}/{paquete}"), "signature": firma } }
            })
            .to_string()
            .into_bytes()
        };
        servir(
            escucha,
            vec![
                ("/latest.json".into(), manifiesto("instalador.exe")),
                ("/alterado.json".into(), manifiesto("alterado.exe")),
                ("/instalador.exe".into(), original.clone()),
                ("/alterado.exe".into(), alterado),
            ],
        );

        let app = app_de_prueba();
        let handle = app.handle();
        tauri::async_runtime::block_on(async {
            std::env::set_var(VARIABLE_ENDPOINT, format!("{base}/latest.json"));
            let actualizacion = buscar(handle).await.unwrap().expect("no encontró la versión 99.0.0");
            assert_eq!(actualizacion.version, "99.0.0");
            assert_eq!(actualizacion.body.as_deref(), Some("Versión de prueba"));
            let paquete = descargar(handle, &actualizacion).await.unwrap();
            assert_eq!(paquete, original);

            std::env::set_var(VARIABLE_ENDPOINT, format!("{base}/alterado.json"));
            let actualizacion = buscar(handle).await.unwrap().unwrap();
            let error = descargar(handle, &actualizacion).await.unwrap_err();
            assert!(error.contains("signature") || error.contains("firma"), "{error}");
            std::env::remove_var(VARIABLE_ENDPOINT);
        });
    }
}
