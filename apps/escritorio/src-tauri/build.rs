// Con el manifiesto de la app, los comandos propios también pasan por las capabilities: cada
// ventana solo puede llamar a los que tenga permitidos (la entrada rápida, a muy pocos).
const COMANDOS: &[&str] = &[
    "conexion_nucleo",
    "perfil_actual",
    "cambiar_perfil",
    "remoto_actual",
    "conectar_remoto",
    "desconectar_remoto",
    "guardar_clave",
    "hay_clave",
    "borrar_clave",
    "mostrar_principal",
    "atajo_actual",
    "cambiar_atajo",
    "buscar_actualizacion",
    "instalar_actualizacion",
];

/// Los tests que montan una app (el del actualizador) enlazan TaskDialogIndirect, que solo está
/// en Common Controls 6: sin su manifiesto no arrancan (STATUS_ENTRYPOINT_NOT_FOUND).
/// tauri-build solo se lo pone a los binarios; por el enlazador llega también a los tests, y se
/// quita el de tauri-build para que el .exe no lo lleve dos veces.
fn windows_con_manifiesto_para_tests() -> tauri_build::WindowsAttributes {
    if !std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|e| e == "msvc") {
        return tauri_build::WindowsAttributes::new();
    }
    let manifiesto = std::env::current_dir().unwrap().join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifiesto.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifiesto.display());
    tauri_build::WindowsAttributes::new_without_app_manifest()
}

fn main() {
    let atributos = tauri_build::Attributes::new()
        .windows_attributes(windows_con_manifiesto_para_tests())
        .app_manifest(tauri_build::AppManifest::new().commands(COMANDOS));
    tauri_build::try_build(atributos).expect("no se pudo preparar la compilación de Tauri");
}
