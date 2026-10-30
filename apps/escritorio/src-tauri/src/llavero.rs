//! Claves en el llavero del sistema (Administrador de credenciales en Windows).

const SERVICIO: &str = "Aquiles";

/// Entrada del llavero → variable de entorno con la que la lee el núcleo
/// (proveedores en packages/nucleo/src/proveedores/index.ts, canales y búsqueda web).
pub const CLAVES: [(&str, &str); 9] = [
    ("anthropic", "AQUILES_CLAVE_ANTHROPIC"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("telegram", "AQUILES_TELEGRAM_TOKEN"),
    ("discord", "AQUILES_DISCORD_TOKEN"),
    ("slack", "AQUILES_SLACK_TOKEN"),
    ("slack-app", "AQUILES_SLACK_APP_TOKEN"),
    ("correo", "AQUILES_CORREO_CLAVE"),
    ("brave", "AQUILES_BRAVE_KEY"),
];

fn entrada(nombre: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICIO, nombre).map_err(|e| e.to_string())
}

pub fn leer(nombre: &str) -> Option<String> {
    entrada(nombre).ok()?.get_password().ok()
}

#[tauri::command]
pub fn guardar_clave(proveedor: String, clave: String) -> Result<(), String> {
    entrada(&proveedor)?.set_password(&clave).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hay_clave(proveedor: String) -> Result<bool, String> {
    match entrada(&proveedor)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn borrar_clave(proveedor: String) -> Result<(), String> {
    match entrada(&proveedor)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    /// Escribe, lee y borra una entrada de prueba en el llavero del sistema.
    #[test]
    fn llavero_ida_y_vuelta() {
        let proveedor = format!("prueba-{}", &crate::nucleo::generar_token()[..8]);
        let valor = crate::nucleo::generar_token();
        guardar_clave(proveedor.clone(), valor.clone()).unwrap();
        assert!(hay_clave(proveedor.clone()).unwrap());
        assert_eq!(leer(&proveedor).unwrap(), valor);
        borrar_clave(proveedor.clone()).unwrap();
        assert!(!hay_clave(proveedor.clone()).unwrap());
        assert_eq!(leer(&proveedor), None);
    }
}
