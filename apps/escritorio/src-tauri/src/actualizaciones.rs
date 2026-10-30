//! Actualizaciones sin releases: cada PC compila Aquiles desde la rama `main` con `instalar.ps1`
//! (en la raíz del repo), que deja la app en `<Destino>\app` y el clon en `<Destino>\codigo`.
//!
//! - `version.json`, junto al .exe, dice de qué commit, rama y repo salió. Sin él es una
//!   compilación de desarrollo (una copia suelta del .exe): no se actualiza sola, pero se puede
//!   instalar en `%LOCALAPPDATA%\Aquiles` con el `instalar.ps1` que lleva dentro, y desde ahí sí.
//! - Para saber si hay algo nuevo se hace `git fetch` en el clon: vale para un repo privado, con
//!   las credenciales que ya tenga Git (Git Credential Manager, GitHub Desktop).
//! - Para actualizar se lanza `codigo\instalar.ps1 -Actualizar -EsperarPid <este> -Relanzar`
//!   oculto. Compila en `app.nuevo` y escribe `LISTO`; cuando la app sale, cambia las carpetas
//!   y la vuelve a abrir. Aquí se va leyendo su registro y se emite el progreso.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::{config, nucleo};

const RAMA: &str = "main";
/// El instalador va dentro de la app: una copia de desarrollo no tiene clon del que sacarlo.
const INSTALADOR: &str = include_str!("../../../../instalar.ps1");
const LIMITE_GIT: Duration = Duration::from_secs(45);
const PRIMERA_COMPROBACION: Duration = Duration::from_secs(60);
const CADA: Duration = Duration::from_secs(6 * 60 * 60);
const LEER_REGISTRO_CADA: Duration = Duration::from_millis(500);
/// Sin ventana de consola para powershell y git, ni para lo que lancen ellos.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

#[derive(Debug, PartialEq, Deserialize)]
struct VersionInstalada {
    commit: String,
    rama: String,
}

#[derive(Debug, PartialEq)]
struct Commit {
    sha: String,
    fecha: Option<String>,
    mensaje: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoActualizacion {
    actual: Option<String>,
    ultimo: String,
    fecha: Option<String>,
    mensaje: Option<String>,
    hay_nueva: bool,
    desarrollo: bool,
}

/// En qué va la actualización: la interfaz lo pide al abrir Ajustes y, mientras tanto, le
/// llegan los eventos.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "fase", rename_all = "camelCase")]
pub enum Estado {
    Inactiva,
    Compilando { paso: u32, total: u32, texto: String },
    Lista { commit: String },
    Error { texto: String },
}

pub struct Actualizacion {
    estado: Mutex<Estado>,
    /// La app sale por `aplicar_actualizacion`: el instalador tiene que volver a abrirla.
    aplicando: AtomicBool,
}

impl Actualizacion {
    pub fn new() -> Self {
        Self { estado: Mutex::new(Estado::Inactiva), aplicando: AtomicBool::new(false) }
    }
}

#[derive(Debug, PartialEq)]
enum Linea {
    Paso { paso: u32, total: u32, texto: String },
    Listo(String),
    Error(String),
}

/// Las líneas del registro de `instalar.ps1` que importan aquí; el resto se ignora.
fn interpretar_linea(linea: &str) -> Option<Linea> {
    let linea = linea.trim_start_matches('\u{feff}').trim();
    let (clave, resto) = linea.split_once(' ').unwrap_or((linea, ""));
    match clave {
        "PASO" => {
            let (cuenta, texto) = resto.split_once(' ').unwrap_or((resto, ""));
            let (paso, total) = cuenta.split_once('/')?;
            Some(Linea::Paso { paso: paso.parse().ok()?, total: total.parse().ok()?, texto: texto.into() })
        }
        "LISTO" if !resto.is_empty() => Some(Linea::Listo(resto.into())),
        "ERROR" => Some(Linea::Error(resto.into())),
        _ => None,
    }
}

fn corto(commit: &str) -> String {
    commit.chars().take(7).collect()
}

/// Un commit abreviado y otro completo son el mismo si uno empieza por el otro.
fn mismo_commit(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    a.len() >= 7 && b.len() >= 7 && (a.starts_with(&b) || b.starts_with(&a))
}

fn interpretar_version(texto: &str) -> Option<VersionInstalada> {
    serde_json::from_str(texto.trim_start_matches('\u{feff}')).ok()
}

/// La salida de `git log -1 --format=%H%x00%s%x00%cI`.
fn interpretar_log(salida: &str) -> Option<Commit> {
    let mut campos = salida.trim().splitn(3, '\0');
    let sha = campos.next().filter(|s| !s.is_empty())?.to_string();
    let mensaje = campos.next().filter(|s| !s.is_empty()).map(String::from);
    let fecha = campos.next().filter(|s| !s.is_empty()).map(String::from);
    Some(Commit { sha, fecha, mensaje })
}

/// Lo que dice git al fallar, en algo que se entienda.
fn explicar_error_git(error: &str) -> String {
    let error_min = error.to_lowercase();
    let sin_acceso = ["authentication failed", "repository not found", "could not read username", "terminal prompts disabled", "403", "401"];
    if sin_acceso.iter().any(|m| error_min.contains(m)) {
        "Sin acceso al repositorio: hace falta permiso para verlo y haber iniciado sesión en GitHub con Git (Git Credential Manager) o con GitHub Desktop".into()
    } else if ["could not resolve host", "unable to access", "timed out"].iter().any(|m| error_min.contains(m)) {
        "Sin conexión con el repositorio".into()
    } else {
        format!("git falló: {}", error.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("sin detalles"))
    }
}

fn orden_oculta(programa: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut orden = Command::new(programa);
    orden.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        orden.creation_flags(CREATE_NO_WINDOW);
    }
    orden
}

/// `git -C <carpeta> …` sin ventana y con tiempo límite. No pide credenciales: si faltan, falla
/// en vez de quedarse esperando a alguien.
fn git(carpeta: &Path, argumentos: &[&str]) -> Result<String, String> {
    let mut hijo = orden_oculta("git")
        .arg("-C")
        .arg(carpeta)
        .args(argumentos)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar git ({e}): ¿está instalado?"))?;
    let inicio = Instant::now();
    while hijo.try_wait().map_err(|e| e.to_string())?.is_none() {
        if inicio.elapsed() > LIMITE_GIT {
            let _ = hijo.kill();
            return Err(format!("git {} no respondió en {} s", argumentos[0], LIMITE_GIT.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let salida = hijo.wait_with_output().map_err(|e| e.to_string())?;
    if !salida.status.success() {
        return Err(explicar_error_git(&String::from_utf8_lossy(&salida.stderr)));
    }
    Ok(String::from_utf8_lossy(&salida.stdout).into_owned())
}

fn carpeta_del_exe() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

fn version_instalada() -> Option<VersionInstalada> {
    interpretar_version(&fs::read_to_string(carpeta_del_exe()?.join("version.json")).ok()?)
}

/// El clon con el que se compara: `<Destino>\codigo`.
fn clon() -> Option<PathBuf> {
    carpeta_del_exe()?.parent().map(|destino| destino.join("codigo"))
}

fn buscar() -> Result<InfoActualizacion, String> {
    // Una copia de desarrollo no sale de ningún clon: la interfaz ofrece instalarla (ver `destino`).
    let Some(version) = version_instalada() else {
        return Ok(InfoActualizacion { actual: None, ultimo: String::new(), fecha: None, mensaje: None, hay_nueva: false, desarrollo: true });
    };
    let clon = clon().ok_or("No se encuentra el código de Aquiles")?;
    comparar(&clon, Some(version))
}

/// Trae la rama del repo al clon y compara su último commit con el instalado.
fn comparar(clon: &Path, version: Option<VersionInstalada>) -> Result<InfoActualizacion, String> {
    let rama = version.as_ref().map_or(RAMA, |v| v.rama.as_str());
    git(clon, &["fetch", "--quiet", "origin", rama])?;
    let remota = format!("origin/{rama}");
    let ultimo = interpretar_log(&git(clon, &["log", "-1", "--format=%H%x00%s%x00%cI", &remota])?)
        .ok_or(format!("No se pudo leer el último commit de {remota}"))?;
    Ok(InfoActualizacion {
        hay_nueva: version.as_ref().is_some_and(|v| !mismo_commit(&v.commit, &ultimo.sha)),
        desarrollo: version.is_none(),
        actual: version.map(|v| corto(&v.commit)),
        ultimo: corto(&ultimo.sha),
        fecha: ultimo.fecha,
        mensaje: ultimo.mensaje,
    })
}

/// `<Destino>`: la carpeta que tiene `app\` (donde está este .exe) y `codigo\`. En una copia de
/// desarrollo, donde la instala `instalar.ps1` por defecto: actualizarla es instalarse ahí.
fn destino() -> Result<PathBuf, String> {
    if version_instalada().is_none() {
        let local = std::env::var_os("LOCALAPPDATA").ok_or("No se encuentra %LOCALAPPDATA%")?;
        return Ok(PathBuf::from(local).join("Aquiles"));
    }
    let destino = carpeta_del_exe().and_then(|app| app.parent().map(Path::to_path_buf)).ok_or("No se encuentra la carpeta de Aquiles")?;
    if !destino.join(r"codigo\instalar.ps1").exists() {
        return Err(format!("Falta {}: vuelve a instalar Aquiles con instalar.ps1", destino.join(r"codigo\instalar.ps1").display()));
    }
    Ok(destino)
}

/// El `instalar.ps1` del clon o, si aún no lo hay (copia de desarrollo), el que lleva la app.
fn instalador(destino: &Path) -> Result<PathBuf, String> {
    let del_clon = destino.join(r"codigo\instalar.ps1");
    if del_clon.exists() {
        return Ok(del_clon);
    }
    let temporal = std::env::temp_dir().join("aquiles-instalar.ps1");
    fs::write(&temporal, INSTALADOR).map_err(|e| format!("No se pudo preparar el instalador: {e}"))?;
    Ok(temporal)
}

fn registro(destino: &Path) -> PathBuf {
    destino.join(r"registro\actualizacion.log")
}

fn cambiar_estado(app: &AppHandle, estado: Estado) {
    *app.state::<Actualizacion>().estado.lock().unwrap() = estado;
}

/// Lanza la compilación en segundo plano. Si ya hay una en marcha o lista, no hace nada.
fn instalar(app: &AppHandle) -> Result<(), String> {
    let destino = destino()?;
    let actualizacion = app.state::<Actualizacion>();
    let mut estado = actualizacion.estado.lock().unwrap();
    if matches!(*estado, Estado::Compilando { .. } | Estado::Lista { .. }) {
        return Ok(());
    }
    let rama = version_instalada().map_or(RAMA.into(), |v| v.rama);
    // El de una actualización anterior no debe leerse como de esta.
    let _ = fs::remove_file(registro(&destino));
    let mut orden = orden_oculta("powershell.exe");
    orden
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(instalador(&destino)?)
        .args(["-Actualizar", "-Destino"])
        .arg(&destino)
        .args(["-Rama", &rama, "-EsperarPid", &std::process::id().to_string(), "-Relanzar"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Su propio grupo: sigue vivo cuando esta app sale, que es cuando cambia las carpetas.
        orden.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    let instalador = orden.spawn().map_err(|e| format!("No se pudo lanzar instalar.ps1: {e}"))?;
    *estado = Estado::Compilando { paso: 0, total: 0, texto: "Empezando".into() };
    drop(estado);
    eprintln!("[aquiles] compilando la actualización (registro en {})", registro(&destino).display());
    let app = app.clone();
    std::thread::spawn(move || seguir_registro(&app, &registro(&destino), instalador));
    Ok(())
}

/// Lee lo nuevo del registro desde `leidos` (vuelve a 0 si el fichero se rehízo).
fn leer_desde(ruta: &Path, leidos: &mut u64) -> String {
    let Ok(mut fichero) = fs::File::open(ruta) else { return String::new() };
    let largo = fichero.metadata().map(|m| m.len()).unwrap_or(0);
    if largo < *leidos {
        *leidos = 0;
    }
    let mut nuevo = Vec::new();
    if fichero.seek(SeekFrom::Start(*leidos)).is_ok() && fichero.read_to_end(&mut nuevo).is_ok() {
        *leidos += nuevo.len() as u64;
    }
    String::from_utf8_lossy(&nuevo).into_owned()
}

#[derive(Clone, Serialize)]
struct Progreso {
    paso: u32,
    total: u32,
    texto: String,
}

#[derive(Clone, Serialize)]
struct Lista {
    commit: String,
}

#[derive(Clone, Serialize)]
struct Fallo {
    texto: String,
}

/// Sigue el registro hasta `LISTO` o `ERROR`. Tras `LISTO` el instalador sigue vivo, esperando
/// a que la app salga; no se le espera.
fn seguir_registro(app: &AppHandle, ruta: &Path, mut instalador: Child) {
    let (mut leidos, mut pendiente) = (0, String::new());
    loop {
        std::thread::sleep(LEER_REGISTRO_CADA);
        let terminado = instalador.try_wait().ok().flatten();
        pendiente.push_str(&leer_desde(ruta, &mut leidos));
        while let Some(fin) = pendiente.find('\n') {
            let linea: String = pendiente.drain(..=fin).collect();
            match interpretar_linea(&linea) {
                Some(Linea::Paso { paso, total, texto }) => {
                    cambiar_estado(app, Estado::Compilando { paso, total, texto: texto.clone() });
                    let _ = app.emit("actualizacion-progreso", Progreso { paso, total, texto });
                }
                Some(Linea::Listo(commit)) => {
                    let commit = corto(&commit);
                    eprintln!("[aquiles] actualización {commit} lista");
                    cambiar_estado(app, Estado::Lista { commit: commit.clone() });
                    avisar(app, &format!("La versión {commit} está lista. Se aplica al reiniciar Aquiles."));
                    let _ = app.emit("actualizacion-lista", Lista { commit });
                    return;
                }
                Some(Linea::Error(texto)) => return fallar(app, texto),
                None => {}
            }
        }
        if let Some(codigo) = terminado {
            return fallar(app, format!("El instalador terminó sin acabar ({codigo}). Mira {}", ruta.display()));
        }
    }
}

fn fallar(app: &AppHandle, texto: String) {
    eprintln!("[aquiles] la actualización falló: {texto}");
    cambiar_estado(app, Estado::Error { texto: texto.clone() });
    let _ = app.emit("actualizacion-error", Fallo { texto });
}

/// Al minuto de arrancar y cada 6 horas: si hay versión nueva, se compila sola y al terminar
/// llega `actualizacion-lista`. No en las compilaciones de desarrollo ni con `actualizarSolo: false`.
pub fn vigilar(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut espera = PRIMERA_COMPROBACION;
        loop {
            tokio::time::sleep(espera).await;
            espera = CADA;
            let ocupada = !matches!(*app.state::<Actualizacion>().estado.lock().unwrap(), Estado::Inactiva | Estado::Error { .. });
            if ocupada || !config::leer().actualizar_solo || version_instalada().is_none() {
                continue;
            }
            match tauri::async_runtime::spawn_blocking(buscar).await {
                Ok(Ok(info)) if info.hay_nueva => {
                    if let Err(e) = instalar(&app) {
                        eprintln!("[aquiles] no se pudo empezar la actualización: {e}");
                    }
                }
                Ok(Err(e)) => eprintln!("[aquiles] no se pudo buscar actualizaciones: {e}"),
                _ => {}
            }
        }
    });
}

fn avisar(app: &AppHandle, texto: &str) {
    if let Err(e) = app.notification().builder().title("Aquiles").body(texto).show() {
        eprintln!("[aquiles] no se pudo notificar: {e}");
    }
}

/// «Buscar actualizaciones» de la bandeja: busca y, si hay versión nueva, empieza a compilarla.
/// La respuesta llega como notificación; el progreso, a la interfaz como siempre.
pub fn buscar_desde_bandeja(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let estado = app.state::<Actualizacion>().estado.lock().unwrap().clone();
        match estado {
            Estado::Compilando { .. } => return avisar(&app, "Ya se está compilando una versión nueva."),
            Estado::Lista { commit } => return avisar(&app, &format!("La versión {commit} está lista. Se aplica al reiniciar Aquiles.")),
            _ => {}
        }
        match buscar() {
            Err(e) => avisar(&app, &format!("No se pudo buscar actualizaciones: {e}")),
            Ok(info) if info.desarrollo => avisar(&app, "Esta copia no se actualiza: instálala desde Ajustes → Aplicación."),
            Ok(info) if info.hay_nueva => match instalar(&app) {
                Ok(()) => avisar(&app, &format!("Compilando la versión {} en segundo plano.", info.ultimo)),
                Err(e) => avisar(&app, &format!("No se pudo actualizar: {e}")),
            },
            Ok(_) => avisar(&app, "Está al día."),
        }
    });
}

/// Si la app sale sin aplicar una actualización en marcha o lista (Salir en la bandeja), el
/// instalador cambia las carpetas igual, pero no debe volver a abrirla.
pub fn al_salir(app: &AppHandle) {
    let actualizacion = app.state::<Actualizacion>();
    let pendiente = matches!(*actualizacion.estado.lock().unwrap(), Estado::Compilando { .. } | Estado::Lista { .. });
    if pendiente && !actualizacion.aplicando.load(Ordering::SeqCst) {
        if let Ok(destino) = destino() {
            let _ = fs::write(destino.join(r"registro\no-relanzar"), "");
        }
    }
}

#[tauri::command]
pub async fn buscar_actualizacion() -> Result<InfoActualizacion, String> {
    tauri::async_runtime::spawn_blocking(buscar).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn instalar_actualizacion(app: AppHandle) -> Result<(), String> {
    instalar(&app)
}

#[tauri::command]
pub fn estado_actualizacion(actualizacion: State<'_, Actualizacion>) -> Estado {
    actualizacion.estado.lock().unwrap().clone()
}

/// Sale de la app (y del núcleo) para que el instalador, que espera a este proceso, cambie
/// las carpetas y la vuelva a abrir.
#[tauri::command]
pub fn aplicar_actualizacion(app: AppHandle, actualizacion: State<'_, Actualizacion>) -> Result<(), String> {
    if !matches!(*actualizacion.estado.lock().unwrap(), Estado::Lista { .. }) {
        return Err("No hay ninguna actualización lista para aplicar".into());
    }
    actualizacion.aplicando.store(true, Ordering::SeqCst);
    nucleo::parar(&app);
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn actualizar_solo() -> bool {
    config::leer().actualizar_solo
}

#[tauri::command]
pub fn cambiar_actualizar_solo(activo: bool) -> Result<(), String> {
    let mut config = config::leer();
    config.actualizar_solo = activo;
    config::guardar(&config)
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn version_json_con_y_sin_bom() {
        let texto = r#"{ "commit": "76c3759aa1", "fecha": "2026-10-30T12:59:20+01:00", "rama": "main", "repo": "C:\\Repos\\Aquiles" }"#;
        let esperada = VersionInstalada { commit: "76c3759aa1".into(), rama: "main".into() };
        assert_eq!(interpretar_version(texto), Some(esperada));
        assert!(interpretar_version(&format!("\u{feff}{texto}")).is_some());
        assert_eq!(interpretar_version("{}"), None);
    }

    #[test]
    fn comparar_commits() {
        let completo = "76c3759aa1b2c3d4e5f60718293a4b5c6d7e8f90";
        assert!(mismo_commit(completo, "76c3759"));
        assert!(mismo_commit("76C3759", completo));
        assert!(!mismo_commit(completo, "1ffa341"));
        assert!(!mismo_commit("", completo));
        assert_eq!(corto(completo), "76c3759");
    }

    #[test]
    fn ultimo_commit_de_git_log() {
        let commit = interpretar_log("abc1234def\0Fase 7: producto\02026-10-30T12:59:20+01:00\n").unwrap();
        let esperado = Commit { sha: "abc1234def".into(), fecha: Some("2026-10-30T12:59:20+01:00".into()), mensaje: Some("Fase 7: producto".into()) };
        assert_eq!(commit, esperado);
        assert_eq!(interpretar_log("abc1234def\0\0").unwrap().mensaje, None);
        assert_eq!(interpretar_log(""), None);
    }

    /// Con repos de verdad en una carpeta temporal: un «remoto», su clon y un commit nuevo.
    #[test]
    fn comparar_con_un_clon_de_verdad() {
        let base = std::env::temp_dir().join(format!("aquiles-git-{}", crate::nucleo::generar_token()));
        let (remoto, copia) = (base.join("remoto"), base.join("clon"));
        fs::create_dir_all(&remoto).unwrap();
        let en = |carpeta: &Path, argumentos: &[&str]| git(carpeta, argumentos).unwrap();
        let commit = |carpeta: &Path, mensaje: &str| {
            en(carpeta, &["-c", "user.name=Prueba", "-c", "user.email=prueba@localhost", "commit", "--allow-empty", "-qm", mensaje]);
            en(carpeta, &["rev-parse", "HEAD"]).trim().to_string()
        };
        en(&remoto, &["init", "-q", "-b", "main"]);
        let primero = commit(&remoto, "Primero");
        en(&base, &["clone", "-q", remoto.to_str().unwrap(), "clon"]);
        let instalada = |commit: &str| Some(VersionInstalada { commit: commit.into(), rama: "main".into() });

        let info = comparar(&copia, instalada(&primero)).unwrap();
        assert!(!info.hay_nueva && !info.desarrollo);
        assert_eq!(info.actual.as_deref(), Some(&primero[..7]));

        let segundo = commit(&remoto, "Segundo: con acentos");
        let info = comparar(&copia, instalada(&primero)).unwrap();
        assert!(info.hay_nueva);
        assert_eq!(info.ultimo, &segundo[..7]);
        assert_eq!(info.mensaje.as_deref(), Some("Segundo: con acentos"));
        assert!(info.fecha.is_some());

        let info = comparar(&copia, None).unwrap();
        assert!(info.desarrollo && !info.hay_nueva && info.actual.is_none());

        assert!(comparar(&base.join("no-existe"), None).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn errores_de_git_explicados() {
        let privado = "remote: Repository not found.\nfatal: repository 'https://github.com/evilrender23/Aquiles/' not found";
        assert!(explicar_error_git(privado).starts_with("Sin acceso"));
        assert!(explicar_error_git("fatal: could not read Username for 'https://github.com': terminal prompts disabled").starts_with("Sin acceso"));
        assert!(explicar_error_git("fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com").starts_with("Sin conexión"));
        assert_eq!(explicar_error_git("\nfatal: not a git repository\n"), "git falló: fatal: not a git repository");
    }

    #[test]
    fn lineas_del_registro() {
        assert_eq!(
            interpretar_linea("\u{feff}PASO 3/7 Instalando dependencias\r\n"),
            Some(Linea::Paso { paso: 3, total: 7, texto: "Instalando dependencias".into() })
        );
        assert_eq!(interpretar_linea("LISTO 76c3759aa1"), Some(Linea::Listo("76c3759aa1".into())));
        assert_eq!(interpretar_linea("ERROR Falta Bun"), Some(Linea::Error("Falta Bun".into())));
        for otra in ["APLICADO 76c3759", "   Compiling tauri v2.12.5", "PASO x/7 algo", "LISTO", ""] {
            assert_eq!(interpretar_linea(otra), None, "{otra}");
        }
    }

    #[test]
    fn leer_el_registro_por_partes() {
        let ruta = std::env::temp_dir().join(format!("aquiles-registro-{}.log", crate::nucleo::generar_token()));
        let mut leidos = 0;
        assert_eq!(leer_desde(&ruta, &mut leidos), "");
        fs::write(&ruta, "PASO 1/7 Uno\n").unwrap();
        assert_eq!(leer_desde(&ruta, &mut leidos), "PASO 1/7 Uno\n");
        fs::write(&ruta, "PASO 1/7 Uno\nPASO 2/7 Dos\n").unwrap();
        assert_eq!(leer_desde(&ruta, &mut leidos), "PASO 2/7 Dos\n");
        // Rehecho (otra actualización): se vuelve a leer desde el principio.
        fs::write(&ruta, "PASO 1/7\n").unwrap();
        assert_eq!(leer_desde(&ruta, &mut leidos), "PASO 1/7\n");
        let _ = fs::remove_file(&ruta);
    }

    #[test]
    fn estado_en_json() {
        let json = serde_json::to_value(Estado::Compilando { paso: 2, total: 7, texto: "Código".into() }).unwrap();
        assert_eq!(json, serde_json::json!({ "fase": "compilando", "paso": 2, "total": 7, "texto": "Código" }));
        assert_eq!(serde_json::to_value(Estado::Inactiva).unwrap(), serde_json::json!({ "fase": "inactiva" }));
    }
}
