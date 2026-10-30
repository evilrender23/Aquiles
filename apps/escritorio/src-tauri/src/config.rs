//! Configuración de la app en `app.json`, junto a los perfiles del núcleo: el perfil activo,
//! el atajo de la entrada rápida, si se actualiza sola y, si lo hay, el núcleo remoto. El token
//! del remoto no va aquí, sino en el llavero.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigApp {
    #[serde(default = "perfil_por_defecto")]
    pub perfil: String,
    #[serde(default = "atajo_por_defecto")]
    pub atajo: String,
    #[serde(default = "verdadero", rename = "actualizarSolo")]
    pub actualizar_solo: bool,
    #[serde(default)]
    pub remoto: Option<Remoto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Remoto {
    pub url: String,
}

fn perfil_por_defecto() -> String {
    "principal".into()
}

fn atajo_por_defecto() -> String {
    "Ctrl+Alt+Space".into()
}

fn verdadero() -> bool {
    true
}

impl Default for ConfigApp {
    fn default() -> Self {
        Self { perfil: perfil_por_defecto(), atajo: atajo_por_defecto(), actualizar_solo: true, remoto: None }
    }
}

/// La misma carpeta que `directorioDatos()` del núcleo: AQUILES_HOME o %APPDATA%\Aquiles.
fn directorio_datos() -> PathBuf {
    if let Some(carpeta) = std::env::var_os("AQUILES_HOME") {
        return carpeta.into();
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_default();
    base.join("Aquiles")
}

fn ruta() -> PathBuf {
    directorio_datos().join("app.json")
}

/// Mismo patrón que `perfiles.crear` del protocolo: `^[a-z0-9][a-z0-9_-]{0,39}$`.
pub fn perfil_valido(nombre: &str) -> bool {
    let minuscula_o_cifra = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let mut letras = nombre.chars();
    nombre.len() <= 40
        && letras.next().is_some_and(minuscula_o_cifra)
        && letras.all(|c| minuscula_o_cifra(c) || c == '_' || c == '-')
}

fn interpretar(texto: &str) -> ConfigApp {
    let mut config: ConfigApp = serde_json::from_str(texto).unwrap_or_else(|e| {
        eprintln!("[aquiles] app.json no es válido ({e}): se usa la configuración por defecto");
        ConfigApp::default()
    });
    // Un nombre editado a mano no puede llegar al núcleo como `--perfil`.
    if !perfil_valido(&config.perfil) {
        config.perfil = perfil_por_defecto();
    }
    config
}

/// Se lee cada vez: el núcleo puede cambiar el perfil y pedir el reinicio con el código 75.
pub fn leer() -> ConfigApp {
    std::fs::read_to_string(ruta()).map(|t| interpretar(&t)).unwrap_or_default()
}

pub fn guardar(config: &ConfigApp) -> Result<(), String> {
    let ruta = ruta();
    if let Some(carpeta) = ruta.parent() {
        std::fs::create_dir_all(carpeta).map_err(|e| e.to_string())?;
    }
    let texto = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&ruta, texto).map_err(|e| format!("No se pudo guardar {}: {e}", ruta.display()))
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn nombres_de_perfil() {
        for bueno in ["principal", "a", "0", "trabajo-2", "mi_perfil", &"a".repeat(40)] {
            assert!(perfil_valido(bueno), "{bueno}");
        }
        for malo in ["", "-a", "_a", "Mayus", "con espacio", "ñu", "a/b", "..", &"a".repeat(41)] {
            assert!(!perfil_valido(malo), "{malo}");
        }
    }

    #[test]
    fn app_json_por_defecto_y_de_ida_y_vuelta() {
        assert_eq!(interpretar("{}"), ConfigApp::default());
        assert_eq!(interpretar("no es json"), ConfigApp::default());
        assert_eq!(interpretar(r#"{ "perfil": "../fuera" }"#).perfil, "principal");

        let config = ConfigApp {
            perfil: "trabajo".into(),
            atajo: "Ctrl+Shift+K".into(),
            actualizar_solo: false,
            remoto: Some(Remoto { url: "wss://casa:47420".into() }),
        };
        let texto = serde_json::to_string(&config).unwrap();
        assert!(!texto.contains("token"));
        assert_eq!(interpretar(&texto), config);
        assert_eq!(serde_json::to_value(ConfigApp::default()).unwrap(), serde_json::json!({ "perfil": "principal", "atajo": "Ctrl+Alt+Space", "actualizarSolo": true, "remoto": null }));
    }
}
