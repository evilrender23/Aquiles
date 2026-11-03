#!/bin/bash
# Compila los paquetes de Aquiles para Linux (.deb y .rpm por defecto), con el núcleo y la app de Tauri.
#
#   bash scripts/app-linux.sh                 .deb y .rpm
#   bash scripts/app-linux.sh deb,appimage    los que se digan (appimage descarga sus herramientas la primera vez)
#
# Hacen falta las bibliotecas de GTK, WebKitGTK 4.1 y D-Bus (instalar.sh las instala). Para usarlo a diario es mejor
# instalar.sh: deja la app en ~/.local/share/Aquiles y se actualiza sola; los paquetes no se actualizan solos.
set -euo pipefail
raiz=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
paquetes=${1:-deb,rpm}
# rust-toolchain.toml pide el toolchain MSVC de Windows.
export RUSTUP_TOOLCHAIN=stable

cd "$raiz"
bun scripts/compilar-nucleo.ts
(cd apps/escritorio && bun run tauri build --bundles "$paquetes")
echo "Paquetes en $raiz/apps/escritorio/src-tauri/target/release/bundle/"
