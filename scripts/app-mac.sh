#!/bin/bash
# Compila Aquiles.app (y el .dmg) en un Mac, con el núcleo, la app de Tauri y el dictado.
#
#   bash scripts/app-mac.sh               para la arquitectura de este Mac
#   bash scripts/app-mac.sh --universal   Apple Silicon e Intel en una sola app (necesita los dos targets de Rust)
#
# Firma: sin más, ad hoc (en otro Mac hay que abrirla con clic derecho → Abrir). Con una cuenta de desarrollador de
# Apple, define APPLE_SIGNING_IDENTITY (y, para notarizarla, APPLE_ID, APPLE_PASSWORD y APPLE_TEAM_ID): Tauri firma y
# notariza al compilar, y aquí no se vuelve a firmar ad hoc encima.
set -euo pipefail
raiz=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
universal=false
[ "${1:-}" = "--universal" ] && universal=true
export RUSTUP_TOOLCHAIN=stable

cd "$raiz"
if $universal; then
    rustup target add aarch64-apple-darwin x86_64-apple-darwin
    bun scripts/compilar-nucleo.ts --universal
    destino=(--target universal-apple-darwin)
    bundle="apps/escritorio/src-tauri/target/universal-apple-darwin/release/bundle/macos/Aquiles.app"
else
    bun scripts/compilar-nucleo.ts
    destino=()
    bundle="apps/escritorio/src-tauri/target/release/bundle/macos/Aquiles.app"
fi

(cd apps/escritorio && bun run tauri build "${destino[@]}")
bash apps/escritorio/src-tauri/macos/compilar-dictado.sh "$raiz/$bundle" $($universal && echo --universal)
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
    codesign --force --deep --sign - "$raiz/$bundle"
fi
echo "Aquiles.app: $raiz/$bundle"
