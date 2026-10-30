//! Abrir carpetas en el Explorador. Para un fichero está `revealItemInDir` del plugin opener,
//! que solo lo señala. `openPath` del plugin no se permite: abrir un .exe, .lnk o .url lo
//! ejecutaría, y su ámbito no sabe distinguir carpetas de ficheros.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Abre `ruta` en el Explorador solo si es una carpeta local que existe.
#[tauri::command]
pub fn abrir_carpeta(app: AppHandle, ruta: String) -> Result<(), String> {
    let carpeta = std::fs::canonicalize(&ruta).map_err(|e| format!("No se encuentra «{ruta}»: {e}"))?;
    if !carpeta.is_dir() {
        return Err(format!("«{ruta}» no es una carpeta"));
    }
    app.opener().open_path(carpeta.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}
