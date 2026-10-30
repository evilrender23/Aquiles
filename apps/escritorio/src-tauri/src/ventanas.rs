//! Ventanas y bandeja.
//!
//! Cerrar la ventana principal solo la esconde: Aquiles sigue en la bandeja y el núcleo, con
//! las tareas programadas y los canales. Para salir de verdad está «Salir» en la bandeja.
//! La entrada rápida es una segunda ventana con la misma interfaz (`?vista=rapida`), creada
//! oculta al arrancar para que el atajo global (atajo.rs) la muestre sin esperar a que cargue.

use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewWindow, Window, WindowEvent};

use crate::nucleo;

pub const PRINCIPAL: &str = "main";
pub const RAPIDA: &str = "rapida";
/// Con este argumento (el del arranque con Windows) la app empieza solo en la bandeja.
pub const ARG_MINIMIZADO: &str = "--minimizado";

pub fn mostrar_ventana_principal(app: &AppHandle) {
    if let Some(ventana) = app.get_webview_window(PRINCIPAL) {
        let _ = ventana.unminimize();
        let _ = ventana.show();
        let _ = ventana.set_focus();
    }
}

/// La entrada rápida lo llama tras crear una sesión, con su id, para seguir en la ventana grande.
/// La principal, para traerse al frente aunque esté escondida en la bandeja (al pulsar una
/// notificación), cosa que `setFocus` no hace.
#[tauri::command]
pub fn mostrar_principal(app: AppHandle, sesion_id: Option<String>) {
    if let Some(rapida) = app.get_webview_window(RAPIDA) {
        let _ = rapida.hide();
    }
    mostrar_ventana_principal(&app);
    if let Some(id) = sesion_id {
        let _ = app.emit_to(PRINCIPAL, "abrir-sesion", id);
    }
}

/// Centrada en horizontal, a un quinto de la altura del monitor donde está el ratón.
fn colocar_arriba<R: Runtime>(ventana: &WebviewWindow<R>) {
    let monitor = ventana
        .cursor_position()
        .ok()
        .and_then(|p| ventana.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| ventana.primary_monitor().ok().flatten());
    let (Some(monitor), Ok(tamano)) = (monitor, ventana.outer_size()) else {
        return;
    };
    let area = monitor.work_area();
    let x = area.position.x + (area.size.width as i32 - tamano.width as i32) / 2;
    let y = area.position.y + area.size.height as i32 / 5;
    let _ = ventana.set_position(PhysicalPosition::new(x, y));
}

fn mostrar_rapida<R: Runtime>(app: &AppHandle<R>) {
    if let Some(ventana) = app.get_webview_window(RAPIDA) {
        colocar_arriba(&ventana);
        let _ = ventana.show();
        let _ = ventana.set_focus();
    }
}

pub fn alternar_rapida<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(RAPIDA) {
        Some(ventana) if ventana.is_visible().unwrap_or(false) => {
            let _ = ventana.hide();
        }
        Some(_) => mostrar_rapida(app),
        None => {}
    }
}

/// Salir de verdad: sin núcleo y sin bandeja.
fn salir(app: &AppHandle) {
    nucleo::parar(app);
    app.exit(0);
}

pub fn al_evento_de_ventana(ventana: &Window, evento: &WindowEvent) {
    match (ventana.label(), evento) {
        (PRINCIPAL | RAPIDA, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            let _ = ventana.hide();
        }
        (RAPIDA, WindowEvent::Focused(false)) => {
            let _ = ventana.hide();
        }
        _ => {}
    }
}

/// Otra instancia (doble clic en el acceso directo con Aquiles ya abierto) enfoca esta.
pub fn al_abrir_otra_instancia(app: &AppHandle, argumentos: Vec<String>, _cwd: String) {
    if !argumentos.iter().any(|a| a == ARG_MINIMIZADO) {
        mostrar_ventana_principal(app);
    }
}

pub fn crear_bandeja(app: &App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("abrir", "Abrir Aquiles")
        .text("rapida", "Entrada rápida")
        .separator()
        .text("salir", "Salir")
        .build()?;
    let mut bandeja = TrayIconBuilder::with_id("aquiles")
        .tooltip("Aquiles")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, evento| match evento.id().as_ref() {
            "abrir" => mostrar_ventana_principal(app),
            "rapida" => mostrar_rapida(app),
            "salir" => salir(app),
            _ => {}
        })
        .on_tray_icon_event(|bandeja, evento| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = evento {
                mostrar_ventana_principal(bandeja.app_handle());
            }
        });
    if let Some(icono) = app.default_window_icon() {
        bandeja = bandeja.icon(icono.clone());
    }
    bandeja.build(app)?;
    Ok(())
}
