//! Proceso principal de Aquiles: ventanas, bandeja, atajo, llavero, actualizaciones y el núcleo.

mod actualizaciones;
mod atajo;
mod config;
mod explorador;
mod llavero;
mod nucleo;
mod ventanas;

use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // La primera: si ya hay un Aquiles abierto, este se cierra antes de lanzar otro núcleo.
        .plugin(tauri_plugin_single_instance::init(ventanas::al_abrir_otra_instancia))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().arg(ventanas::ARG_MINIMIZADO).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(nucleo::Nucleo::new())
        .manage(actualizaciones::Actualizacion::new())
        .invoke_handler(tauri::generate_handler![
            nucleo::conexion_nucleo,
            nucleo::perfil_actual,
            nucleo::cambiar_perfil,
            nucleo::remoto_actual,
            nucleo::conectar_remoto,
            nucleo::desconectar_remoto,
            llavero::guardar_clave,
            llavero::hay_clave,
            llavero::borrar_clave,
            ventanas::mostrar_principal,
            explorador::abrir_carpeta,
            atajo::atajo_actual,
            atajo::cambiar_atajo,
            actualizaciones::buscar_actualizacion,
            actualizaciones::instalar_actualizacion,
            actualizaciones::estado_actualizacion,
            actualizaciones::aplicar_actualizacion,
            actualizaciones::actualizar_solo,
            actualizaciones::cambiar_actualizar_solo,
        ])
        .on_window_event(ventanas::al_evento_de_ventana)
        .setup(|app| {
            ventanas::crear_bandeja(app)?;
            atajo::registrar_al_arrancar(app);
            if !std::env::args().any(|a| a == ventanas::ARG_MINIMIZADO) {
                ventanas::mostrar_ventana_principal(app.handle());
            }
            nucleo::arrancar(app.handle(), false);
            actualizaciones::vigilar(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar Aquiles")
        .run(|app, evento| {
            if let RunEvent::Exit = evento {
                actualizaciones::al_salir(app);
                nucleo::parar(app);
            }
        });
}
