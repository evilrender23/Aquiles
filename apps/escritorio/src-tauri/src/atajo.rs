//! Atajo global que muestra u oculta la entrada rápida. Se guarda en `app.json`
//! (por defecto Ctrl+Alt+Space). Si otro programa ya lo tiene, Aquiles arranca igual, sin él,
//! y `atajo_actual` dice por qué.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{App, AppHandle, Manager, Runtime, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::{config, ventanas};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EstadoAtajo {
    atajo: String,
    registrado: bool,
    error: Option<String>,
}

pub struct Atajo(Mutex<EstadoAtajo>);

fn al_pulsar<R: Runtime>(app: &AppHandle<R>, _: &Shortcut, evento: ShortcutEvent) {
    if evento.state == ShortcutState::Pressed {
        ventanas::alternar_rapida(app);
    }
}

fn interpretar(texto: &str) -> Result<Shortcut, String> {
    let atajo: Shortcut = texto.parse().map_err(|e| format!("«{texto}» no es un atajo válido: {e}"))?;
    // Una tecla sola dejaría de llegar a los demás programas.
    if atajo.mods.is_empty() {
        return Err(format!("«{texto}» necesita al menos un modificador (Ctrl, Alt, Shift o Super)"));
    }
    Ok(atajo)
}

fn registrar<R: Runtime>(app: &AppHandle<R>, atajo: Shortcut, texto: &str) -> Result<(), String> {
    app.global_shortcut().on_shortcut(atajo, al_pulsar).map_err(|e| {
        let e = e.to_string();
        if e.contains("already registered") {
            format!("Otro programa ya usa {texto}")
        } else {
            format!("No se pudo registrar {texto}: {e}")
        }
    })
}

fn fallido(atajo: String, error: String) -> EstadoAtajo {
    EstadoAtajo { atajo, registrado: false, error: Some(error) }
}

pub fn registrar_al_arrancar<R: Runtime>(app: &App<R>) {
    let atajo = config::leer().atajo;
    let estado = match interpretar(&atajo).and_then(|a| registrar(app.handle(), a, &atajo)) {
        Ok(()) => {
            eprintln!("[aquiles] atajo {atajo} registrado");
            EstadoAtajo { atajo, registrado: true, error: None }
        }
        Err(error) => {
            eprintln!("[aquiles] sin atajo: {error}");
            fallido(atajo, error)
        }
    };
    app.manage(Atajo(Mutex::new(estado)));
}

/// Registra el atajo nuevo y, solo si lo consigue, lo guarda y suelta el anterior. Si no, el
/// anterior sigue como estaba y la respuesta trae `registrado: false` con el motivo.
/// `Err` solo si no se pudo guardar `app.json`.
fn cambiar<R: Runtime>(app: &AppHandle<R>, estado: &Atajo, atajo: &str) -> Result<EstadoAtajo, String> {
    let texto = atajo.trim().to_string();
    let mut actual = estado.0.lock().unwrap();
    let nuevo = match interpretar(&texto) {
        Ok(nuevo) => nuevo,
        Err(error) => return Ok(fallido(texto, error)),
    };
    let anterior = if actual.registrado { interpretar(&actual.atajo).ok() } else { None };
    // La misma combinación escrita de otra forma ya está registrada: solo cambia cómo se guarda.
    let mismo = anterior == Some(nuevo);
    if !mismo {
        if let Err(error) = registrar(app, nuevo, &texto) {
            return Ok(fallido(texto, error));
        }
    }
    let mut config = config::leer();
    config.atajo = texto.clone();
    if let Err(e) = config::guardar(&config) {
        if !mismo {
            let _ = app.global_shortcut().unregister(nuevo);
        }
        return Err(e);
    }
    if let Some(anterior) = anterior.filter(|_| !mismo) {
        let _ = app.global_shortcut().unregister(anterior);
    }
    eprintln!("[aquiles] atajo {texto} registrado");
    *actual = EstadoAtajo { atajo: texto, registrado: true, error: None };
    Ok(actual.clone())
}

#[tauri::command]
pub fn atajo_actual(estado: State<'_, Atajo>) -> EstadoAtajo {
    estado.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn cambiar_atajo(app: AppHandle, estado: State<'_, Atajo>, atajo: String) -> Result<EstadoAtajo, String> {
    cambiar(&app, &estado, &atajo)
}

#[cfg(test)]
mod pruebas {
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    use super::*;

    #[test]
    fn atajos_validos_e_invalidos() {
        assert_eq!(interpretar("Ctrl+Alt+Space"), interpretar("ctrl+alt+space"));
        assert!(interpretar("Ctrl+Shift+K").is_ok());
        for malo in ["", "Ctrl+", "Ctrl+Alt+Patata", "K+Ctrl", "Space", "F5"] {
            assert!(interpretar(malo).is_err(), "{malo}");
        }
    }

    fn app_de_prueba() -> tauri::App<MockRuntime> {
        mock_builder()
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .build(mock_context(noop_assets()))
            .unwrap()
    }

    /// Con atajos de verdad del sistema (Ctrl+Alt+Shift+F9…F11). La segunda app hace de «otro
    /// programa» que ya tiene uno. `app.json` va a una carpeta temporal (AQUILES_HOME).
    #[test]
    #[cfg_attr(not(windows), ignore = "en Mac el plugin de atajos no arranca fuera del hilo principal")]
    fn cambiar_registra_guarda_y_conserva_el_anterior() {
        let datos = std::env::temp_dir().join(format!("aquiles-atajo-{}", crate::nucleo::generar_token()));
        std::fs::create_dir_all(&datos).unwrap();
        std::env::set_var("AQUILES_HOME", &datos);
        let guardado = || config::leer().atajo;
        std::fs::write(datos.join("app.json"), r#"{ "atajo": "Ctrl+Alt+Shift+F9" }"#).unwrap();

        let app = app_de_prueba();
        let otro = app_de_prueba();
        registrar_al_arrancar(&app);
        let (app, otro) = (app.handle(), otro.handle());
        let estado = app.state::<Atajo>();
        let f9: Shortcut = "Ctrl+Alt+Shift+F9".parse().unwrap();
        let f10: Shortcut = "Ctrl+Alt+Shift+F10".parse().unwrap();
        let f11: Shortcut = "Ctrl+Alt+Shift+F11".parse().unwrap();
        assert!(atajo_actual(estado.clone()).registrado);

        // La misma combinación con otra grafía: se guarda sin volver a registrarla.
        let r = cambiar(app, &estado, "ctrl+alt+shift+f9").unwrap();
        assert!(r.registrado && r.error.is_none());
        assert_eq!(guardado(), "ctrl+alt+shift+f9");

        // Ocupado por otro programa: no se guarda y el anterior sigue.
        otro.global_shortcut().register(f10).unwrap();
        let r = cambiar(app, &estado, "Ctrl+Alt+Shift+F10").unwrap();
        assert_eq!((r.atajo.as_str(), r.registrado), ("Ctrl+Alt+Shift+F10", false));
        assert!(r.error.unwrap().contains("Otro programa ya usa"));
        assert!(app.global_shortcut().is_registered(f9));
        assert_eq!(atajo_actual(estado.clone()).atajo, "ctrl+alt+shift+f9");
        assert_eq!(guardado(), "ctrl+alt+shift+f9");

        // No válido: igual.
        let r = cambiar(app, &estado, "Ctrl+Patata").unwrap();
        assert!(!r.registrado && r.error.unwrap().contains("no es un atajo válido"));
        assert!(app.global_shortcut().is_registered(f9));

        // Libre: se registra, se guarda y el anterior queda libre para otros.
        let r = cambiar(app, &estado, " Ctrl+Alt+Shift+F11 ").unwrap();
        assert_eq!(r, EstadoAtajo { atajo: "Ctrl+Alt+Shift+F11".into(), registrado: true, error: None });
        assert_eq!(guardado(), "Ctrl+Alt+Shift+F11");
        assert!(app.global_shortcut().is_registered(f11));
        assert!(!app.global_shortcut().is_registered(f9));
        otro.global_shortcut().register(f9).expect("F9 tendría que haber quedado libre");

        let _ = app.global_shortcut().unregister_all();
        let _ = otro.global_shortcut().unregister_all();
        std::env::remove_var("AQUILES_HOME");
        let _ = std::fs::remove_dir_all(&datos);
    }
}
