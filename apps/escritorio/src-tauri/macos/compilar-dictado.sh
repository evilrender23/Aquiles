#!/bin/bash
# Compila aquiles-dictado (dictado.swift) dentro de una Aquiles.app ya hecha y se asegura de que su Info.plist
# lleve los textos de los permisos de micrófono y reconocimiento de voz. No firma: eso lo hace quien llama.
#
#   bash compilar-dictado.sh RUTA/Aquiles.app
set -euo pipefail
app=$1
aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
swiftc -O -swift-version 5 -o "$app/Contents/MacOS/aquiles-dictado" "$aqui/dictado.swift" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$aqui/dictado-Info.plist"
# Tauri suma src-tauri/Info.plist; por si no, se añaden aquí (sin tocar los que ya estén).
plist="$app/Contents/Info.plist"
anadir() {
    /usr/libexec/PlistBuddy -c "Print :$1" "$plist" >/dev/null 2>&1 || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$plist"
}
anadir NSMicrophoneUsageDescription 'Aquiles usa el micrófono para el dictado por voz.'
anadir NSSpeechRecognitionUsageDescription 'Aquiles convierte en texto lo que dictas.'
