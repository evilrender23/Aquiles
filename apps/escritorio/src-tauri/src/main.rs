// Sin consola extra en Windows al ejecutar la versión compilada.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aquiles_lib::run()
}
