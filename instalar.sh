#!/bin/bash
# Instala o actualiza Aquiles en Mac compilándolo desde una rama del repositorio (main por defecto).
# Es el equivalente de instalar.ps1.
#
#   git clone https://github.com/evilrender23/Aquiles
#   bash Aquiles/instalar.sh [--repo URL|RUTA] [--rama main] [--destino CARPETA] [--app RUTA/Aquiles.app]
#
# También vale descargado suelto, o con `curl -fsSL <url de raw.githubusercontent.com> | bash` si el
# repo es público. Desde un clon, sin --repo, instala desde el origin de ese clon. Con un repo privado,
# git pide las credenciales la primera vez (o usa las del llavero de macOS).
# La app lo relanza con --actualizar --esperar-pid <su pid> --relanzar.
#
# En <destino> (por defecto ~/Library/Application Support/Aquiles) deja:
#   codigo/    el clon, con las cachés (node_modules, target) para que la siguiente compilación sea rápida;
#   registro/  actualizacion.log, con las líneas que lee la app (PASO n/total, LISTO, APLICADO, ERROR),
#              y compilacion.log, con la salida de git, bun y cargo.
# La app va en --app: por defecto /Applications/Aquiles.app (~/Applications si no se puede escribir en
# /Applications), con version.json (commit, fecha, rama, repo, destino) en Contents/Resources.
#
# Sin --actualizar pregunta e instala lo que falte (herramientas de línea de comandos de Xcode, Bun, Rust).
# Con --actualizar (lo que lanza la app) no instala ni pregunta nada. Compila en app.nuevo y, si ya hay
# app, espera a que Aquiles se cierre (--esperar-pid) para cambiarla.

set -uo pipefail

REPO='https://github.com/evilrender23/Aquiles'
RAMA='main'
DESTINO="$HOME/Library/Application Support/Aquiles"
APP=''
ACTUALIZAR=false
ESPERAR_PID=0
RELANZAR=false
REPO_INDICADO=false

while [ $# -gt 0 ]; do
    case "$1" in
        --repo) REPO="$2"; REPO_INDICADO=true; shift 2 ;;
        --rama) RAMA="$2"; shift 2 ;;
        --destino) DESTINO="$2"; shift 2 ;;
        --app) APP="$2"; shift 2 ;;
        --actualizar) ACTUALIZAR=true; shift ;;
        --esperar-pid) ESPERAR_PID="$2"; shift 2 ;;
        --relanzar) RELANZAR=true; shift ;;
        *) echo "Opción desconocida: $1" >&2; exit 2 ;;
    esac
done

if [ -z "$APP" ]; then
    if [ -w /Applications ]; then APP='/Applications/Aquiles.app'; else APP="$HOME/Applications/Aquiles.app"; fi
fi
INTERACTIVO=true
$ACTUALIZAR && INTERACTIVO=false

# Abierto desde la app (Finder, Dock), el PATH es el mínimo: aquí se añade donde suelen estar Bun, Rust y Homebrew.
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Ejecutado desde un clon de Aquiles y sin --repo: el mismo repositorio (un fork, una copia local).
PROPIO=''
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    PROPIO=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi
if ! $REPO_INDICADO && [ -n "$PROPIO" ] && [ -f "$PROPIO/apps/escritorio/src-tauri/tauri.conf.json" ] && command -v git >/dev/null 2>&1; then
    ORIGEN_PROPIO=$(git -C "$PROPIO" remote get-url origin 2>/dev/null) && [ -n "$ORIGEN_PROPIO" ] && REPO="$ORIGEN_PROPIO"
fi
if $ACTUALIZAR; then
    # Sin nadie delante, git no debe quedarse esperando credenciales: mejor que falle y lo diga.
    export GIT_TERMINAL_PROMPT=0
fi

CODIGO="$DESTINO/codigo"
NUEVO="$DESTINO/app.nuevo"
ANTERIOR="$DESTINO/app.anterior"
REGISTRO="$DESTINO/registro"
LOG="$REGISTRO/actualizacion.log"
LOG_COMPILACION="$REGISTRO/compilacion.log"
CERROJO="$REGISTRO/instalar.lock"
ULTIMA="$REGISTRO/ultima-salida.log"
# La app lo deja si sale sin aplicar la actualización (Salir en la barra de menús): se cambia de versión, pero no se abre.
NO_RELANZAR="$REGISTRO/no-relanzar"
TOTAL=7

anotar() {
    printf '%s\n' "$1" >> "$LOG"
}

paso() {
    anotar "PASO $1/$TOTAL $2"
    if $INTERACTIVO; then printf '\033[36m[%s/%s] %s\033[0m\n' "$1" "$TOTAL" "$2"; fi
}

fallar() {
    local texto
    texto=$(printf '%s' "$1" | tr '\n' ' ' | sed 's/  */ /g')
    anotar "ERROR $texto" 2>/dev/null
    if $INTERACTIVO; then printf '\033[31mERROR: %s\033[0m\n' "$texto" >&2; fi
    exit 1
}

# ejecutar CARPETA PROGRAMA ARGUMENTOS…: la salida va a compilacion.log (y a la pantalla si es interactivo).
ejecutar() {
    local carpeta=$1 resultado
    shift
    printf '> %s\n' "$*" >> "$LOG_COMPILACION"
    if $INTERACTIVO; then
        (cd "$carpeta" && "$@") 2>&1 | tee "$ULTIMA" | tee -a "$LOG_COMPILACION" | sed $'s/^/\033[2m/; s/$/\033[0m/'
        resultado=${PIPESTATUS[0]}
    else
        (cd "$carpeta" && "$@") > "$ULTIMA" 2>&1
        resultado=$?
        cat "$ULTIMA" >> "$LOG_COMPILACION"
    fi
    return "$resultado"
}

tiene() {
    command -v "$1" >/dev/null 2>&1
}

hay_xcode() { xcode-select -p >/dev/null 2>&1; }
hay_rust() { tiene rustup && rustup toolchain list 2>/dev/null | grep -q '^stable'; }

instalar_xcode() {
    xcode-select --install >/dev/null 2>&1
    echo 'Acepta la ventana de macOS que pide instalar las herramientas de línea de comandos; se espera a que acabe…'
    until hay_xcode; do sleep 5; done
}

instalar_bun() {
    ejecutar "$DESTINO" bash -c 'curl -fsSL https://bun.sh/install | bash'
}

instalar_rust() {
    if ! tiene rustup; then
        ejecutar "$DESTINO" bash -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal"
    fi
    ejecutar "$DESTINO" rustup toolchain install stable --profile minimal
}

# En orden: git viene con las herramientas de Xcode, y Rust las necesita para enlazar.
REQUISITOS='xcode bun rust'
nombre_de() {
    case "$1" in
        xcode) echo 'Herramientas de línea de comandos de Xcode (con Git)' ;;
        bun) echo 'Bun' ;;
        rust) echo 'Rust (rustup, toolchain stable)' ;;
    esac
}
hay() {
    case "$1" in
        xcode) hay_xcode && tiene git ;;
        bun) tiene bun ;;
        rust) hay_rust ;;
    esac
}

comprobar_requisitos() {
    local faltan='' nombres='' r respuesta si
    for r in $REQUISITOS; do
        hay "$r" || { faltan="$faltan $r"; nombres="$nombres${nombres:+, }$(nombre_de "$r")"; }
    done
    [ -z "$faltan" ] && return 0
    $INTERACTIVO || fallar "Falta $nombres. Ejecuta instalar.sh sin --actualizar para instalarlo."
    printf '\033[33mFalta: %s\033[0m\n' "$nombres"
    # Con `curl | bash` la entrada es el propio script: se pregunta en la terminal.
    printf '¿Instalarlo? [T]odo / [u]no a uno / [n]ada '
    read -r respuesta < /dev/tty
    respuesta=$(printf '%s' "$respuesta" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
    for r in $faltan; do
        # Puede haber llegado con otro.
        hay "$r" && continue
        case "$respuesta" in
            ''|t|todo|s|si|sí) si=true ;;
            u*)
                printf '¿Instalar %s? [S/n] ' "$(nombre_de "$r")"
                read -r si < /dev/tty
                case "$si" in [nN]*) si=false ;; *) si=true ;; esac ;;
            *) si=false ;;
        esac
        $si || fallar "Sin $(nombre_de "$r") no se puede compilar Aquiles."
        echo "Instalando $(nombre_de "$r")…"
        "instalar_$r"
        hay "$r" || fallar "Se instaló $(nombre_de "$r"), pero no aparece: abre una terminal nueva y vuelve a ejecutar el instalador."
    done
}

# Un fallo de git al clonar o traer cambios, dicho de forma que se entienda.
explicar_error_git() {
    if grep -qiE 'Authentication failed|Repository not found|could not read Username|terminal prompts disabled|(^|[^0-9])40[13]([^0-9]|$)' "$ULTIMA"; then
        fallar "Sin acceso a $1: hace falta permiso para ver el repositorio y haber iniciado sesión en GitHub con Git."
    fi
    if grep -qiE 'Could not resolve host|unable to access' "$ULTIMA"; then
        fallar "Sin conexión con $1."
    fi
    fallar "git falló con $1 (detalles en $LOG_COMPILACION)"
}

descargar_codigo() {
    local origen
    if [ -d "$CODIGO/.git" ]; then
        if $REPO_INDICADO; then ejecutar "$CODIGO" git remote set-url origin "$REPO"; fi
        origen=$(git -C "$CODIGO" remote get-url origin)
        ejecutar "$CODIGO" git fetch --prune origin "$RAMA" || explicar_error_git "$origen"
        ejecutar "$CODIGO" git reset --hard "origin/$RAMA" || fallar "git reset falló (detalles en $LOG_COMPILACION)"
        # Sin -x: lo ignorado (node_modules, target) es la caché.
        ejecutar "$CODIGO" git clean -fd || fallar "git clean falló (detalles en $LOG_COMPILACION)"
    else
        mkdir -p "$DESTINO"
        ejecutar "$DESTINO" git clone --branch "$RAMA" "$REPO" "$CODIGO" || explicar_error_git "$REPO"
    fi
}

# Lo que hay entre comillas en JSON: barras y comillas escapadas.
json() {
    printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

procesos_de_la_app() {
    pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1
}

esperar_pid() {
    if [ "$ESPERAR_PID" -gt 0 ] 2>/dev/null; then
        while kill -0 "$ESPERAR_PID" 2>/dev/null; do sleep 1; done
    fi
}

esperar_cierre() {
    local avisado=false
    esperar_pid
    while procesos_de_la_app; do
        if $INTERACTIVO && ! $avisado; then
            printf '\033[33mCierra Aquiles (Salir, en el icono de la barra de menús) para terminar la instalación…\033[0m\n'
            avisado=true
        fi
        sleep 1
    done
}

cambiar_app() {
    rm -rf "$ANTERIOR"
    mv "$APP" "$ANTERIOR" || fallar "No se pudo apartar la versión anterior ($APP)."
    if ! mv "$NUEVO/Aquiles.app" "$APP"; then
        mv "$ANTERIOR" "$APP"
        fallar "No se pudo cambiar a la versión nueva; sigue la anterior."
    fi
}

limpiar() {
    rm -rf "$CERROJO"
}

principal() {
    mkdir -p "$REGISTRO" || { echo "No se puede crear $REGISTRO" >&2; exit 1; }
    # Un cerrojo con el pid dentro: si el que lo tenía ya no existe, se queda con él.
    if ! mkdir "$CERROJO" 2>/dev/null; then
        local dueno
        dueno=$(cat "$CERROJO/pid" 2>/dev/null)
        if [ -n "$dueno" ] && kill -0 "$dueno" 2>/dev/null; then
            fallar 'Ya hay otra instalación de Aquiles en marcha.'
        fi
    fi
    echo $$ > "$CERROJO/pid"
    trap limpiar EXIT
    : > "$LOG"
    : > "$LOG_COMPILACION"
    rm -f "$NO_RELANZAR"

    paso 1 'Comprobando las herramientas de Xcode, Git, Bun y Rust'
    comprobar_requisitos

    paso 2 "Descargando el código ($RAMA)"
    descargar_codigo
    local commit fecha origen triple escritorio compilado
    commit=$(git -C "$CODIGO" rev-parse HEAD)
    fecha=$(git -C "$CODIGO" log -1 --format=%cI)
    origen=$(git -C "$CODIGO" remote get-url origin)

    paso 3 'Instalando las dependencias'
    ejecutar "$CODIGO" bun install --frozen-lockfile || fallar "bun install falló (detalles en $LOG_COMPILACION)"

    paso 4 'Compilando el núcleo'
    # El sidecar se llama con el triple de Rust: aarch64-apple-darwin o x86_64-apple-darwin.
    triple=$(RUSTUP_TOOLCHAIN=stable rustc -vV | sed -n 's/^host: //p')
    [ -n "$triple" ] || fallar 'No se pudo saber la arquitectura con rustc.'
    ejecutar "$CODIGO" bun build packages/nucleo/src/main.ts --compile \
        --outfile "apps/escritorio/src-tauri/binaries/aquiles-nucleo-$triple" || fallar "La compilación del núcleo falló (detalles en $LOG_COMPILACION)"

    paso 5 'Compilando la app (la primera vez tarda varios minutos)'
    escritorio="$CODIGO/apps/escritorio"
    # rust-toolchain.toml pide el toolchain MSVC de Windows: en Mac se usa el stable.
    ejecutar "$escritorio" env RUSTUP_TOOLCHAIN=stable bun run tauri build --bundles app \
        || fallar "La compilación de la app falló (detalles en $LOG_COMPILACION)"
    compilado="$escritorio/src-tauri/target/release/bundle/macos/Aquiles.app"
    [ -x "$compilado/Contents/MacOS/aquiles" ] || fallar "La compilación no dejó $compilado"

    paso 6 'Preparando la versión nueva'
    rm -rf "$NUEVO"
    mkdir -p "$NUEVO"
    ditto "$compilado" "$NUEVO/Aquiles.app" || fallar 'No se pudo copiar la app compilada.'
    printf '{\n  "commit": %s,\n  "fecha": %s,\n  "rama": %s,\n  "repo": %s,\n  "destino": %s\n}\n' \
        "$(json "$commit")" "$(json "$fecha")" "$(json "$RAMA")" "$(json "$origen")" "$(json "$DESTINO")" \
        > "$NUEVO/Aquiles.app/Contents/Resources/version.json"
    # version.json cambia el contenido del paquete: se vuelve a firmar (en local, sin identidad).
    ejecutar "$DESTINO" codesign --force --deep --sign - "$NUEVO/Aquiles.app" || fallar 'No se pudo firmar la app.'
    anotar "LISTO $commit"

    if [ -d "$APP" ]; then
        paso 7 'Esperando a que se cierre Aquiles para cambiar de versión'
        esperar_cierre
        cambiar_app
    else
        paso 7 "Instalando en $(dirname "$APP")"
        mkdir -p "$(dirname "$APP")"
        mv "$NUEVO/Aquiles.app" "$APP" || fallar "No se pudo instalar en $APP."
    fi
    rm -rf "$NUEVO"
    anotar "APLICADO $commit"
    # Instalada desde una copia de desarrollo: esa copia tiene que cerrarse antes, porque solo puede
    # haber un Aquiles abierto (en una actualización ya se esperó a que se cerrara).
    esperar_pid
    if { $RELANZAR || $INTERACTIVO; } && [ ! -e "$NO_RELANZAR" ]; then
        open "$APP"
    fi
    rm -f "$NO_RELANZAR"
    if $INTERACTIVO; then printf '\033[32mAquiles %s está en %s.\033[0m\n' "${commit:0:7}" "$APP"; fi
}

principal
