#!/bin/bash
# Instala o actualiza Aquiles en Mac o en Linux compilándolo desde una rama del repositorio (main por defecto).
# Es el equivalente de instalar.ps1.
#
#   git clone https://github.com/evilrender23/Aquiles
#   bash Aquiles/instalar.sh [--repo URL|RUTA] [--rama main] [--destino CARPETA] [--app RUTA/Aquiles.app]
#
# También vale descargado suelto, o con `curl -fsSL <url de raw.githubusercontent.com> | bash` si el
# repo es público. Desde un clon, sin --repo, instala desde el origin de ese clon. Con un repo privado,
# git pide las credenciales la primera vez (o usa las del llavero del sistema).
# La app lo relanza con --actualizar --esperar-pid <su pid> --relanzar.
#
# En <destino> (por defecto ~/Library/Application Support/Aquiles en Mac y ~/.local/share/Aquiles en Linux) deja:
#   codigo/    el clon, con las cachés (node_modules, target) para que la siguiente compilación sea rápida;
#   registro/  actualizacion.log, con las líneas que lee la app (PASO n/total, LISTO, APLICADO, ERROR),
#              y compilacion.log, con la salida de git, bun y cargo.
# Mac: la app va en --app, por defecto /Applications/Aquiles.app (~/Applications si no se puede escribir en
# /Applications), con version.json (commit, fecha, rama, repo, destino) en Contents/Resources.
# Linux: como en Windows, en <destino>/app (aquiles, aquiles-nucleo, skills/ y version.json), con un lanzador
# en ~/.local/share/applications/aquiles.desktop para que salga en el menú de aplicaciones.
#
# Sin --actualizar pregunta e instala lo que falte (Mac: herramientas de línea de comandos de Xcode; Linux: el
# compilador de C y las bibliotecas de GTK y WebKit, con el gestor de paquetes y sudo; y Bun y Rust).
# Con --actualizar (lo que lanza la app) no instala ni pregunta nada. Compila en app.nuevo y, si ya hay
# app, espera a que Aquiles se cierre (--esperar-pid) para cambiarla.

set -uo pipefail

case "$(uname -s)" in
    Darwin) LINUX=false ;;
    Linux) LINUX=true ;;
    *) echo "Este instalador es para Mac y Linux; en Windows, usa instalar.ps1." >&2; exit 2 ;;
esac

REPO='https://github.com/evilrender23/Aquiles'
RAMA='main'
if $LINUX; then DESTINO="${XDG_DATA_HOME:-$HOME/.local/share}/Aquiles"; else DESTINO="$HOME/Library/Application Support/Aquiles"; fi
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

if $LINUX; then
    APP="$DESTINO/app"
elif [ -z "$APP" ]; then
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
# Lo que Tauri necesita en Linux: C, pkg-config, GTK y WebKitGTK 4.1, D-Bus (el llavero) y AppIndicator (la bandeja,
# que se carga al arrancar).
hay_appindicator() {
    pkg-config --exists ayatana-appindicator3-0.1 || pkg-config --exists appindicator3-0.1 \
        || { PATH="$PATH:/sbin:/usr/sbin" ldconfig -p 2>/dev/null | grep -qE 'lib(ayatana-)?appindicator3\.so'; }
}
hay_sistema() { tiene cc && tiene pkg-config && pkg-config --exists webkit2gtk-4.1 dbus-1 && hay_appindicator && tiene git && tiene curl; }
hay_rust() { tiene rustup && rustup toolchain list 2>/dev/null | grep -q '^stable'; }

instalar_xcode() {
    xcode-select --install >/dev/null 2>&1
    echo 'Acepta la ventana de macOS que pide instalar las herramientas de línea de comandos; se espera a que acabe…'
    until hay_xcode; do sleep 5; done
}

# Los paquetes de cada familia de distribuciones (los de la guía de Tauri, más D-Bus para el llavero).
instalar_sistema() {
    if tiene apt-get; then
        sudo apt-get update && sudo apt-get install -y build-essential pkg-config curl git file \
            libwebkit2gtk-4.1-dev libdbus-1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
    elif tiene dnf; then
        sudo dnf install -y gcc gcc-c++ make pkgconf-pkg-config curl git file \
            webkit2gtk4.1-devel dbus-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel openssl-devel
    elif tiene pacman; then
        sudo pacman -S --needed --noconfirm base-devel curl git file \
            webkit2gtk-4.1 dbus libappindicator-gtk3 librsvg xdotool openssl
    elif tiene zypper; then
        sudo zypper install -y -t pattern devel_basis && sudo zypper install -y pkg-config curl git file \
            webkit2gtk3-devel dbus-1-devel libappindicator3-devel librsvg-devel libxdo-devel libopenssl-devel
    else
        fallar "No se reconoce el gestor de paquetes: instala a mano un compilador de C, pkg-config, git, curl y las bibliotecas de desarrollo de WebKitGTK 4.1 y D-Bus (ver https://v2.tauri.app/start/prerequisites/)."
    fi
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

# En orden: git viene con las herramientas de Xcode (o con los paquetes del sistema), y Rust las necesita para enlazar.
if $LINUX; then REQUISITOS='sistema bun rust'; else REQUISITOS='xcode bun rust'; fi
nombre_de() {
    case "$1" in
        xcode) echo 'Herramientas de línea de comandos de Xcode (con Git)' ;;
        sistema) echo 'Compilador de C, Git, curl y las bibliotecas de GTK, WebKitGTK y D-Bus (con sudo)' ;;
        bun) echo 'Bun' ;;
        rust) echo 'Rust (rustup, toolchain stable)' ;;
    esac
}
hay() {
    case "$1" in
        xcode) hay_xcode && tiene git ;;
        sistema) hay_sistema ;;
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
    # En Linux casa con aquiles y con aquiles-nucleo.
    if $LINUX; then pgrep -f "^$APP/aquiles" >/dev/null 2>&1; else pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; fi
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
            printf '\033[33mCierra Aquiles (Salir, en su icono de la bandeja o de la barra de menús) para terminar la instalación…\033[0m\n'
            avisado=true
        fi
        sleep 1
    done
}

# Lo compilado dentro de app.nuevo: el .app en Mac; en Linux, la propia carpeta.
pieza_nueva() {
    if $LINUX; then printf '%s' "$NUEVO"; else printf '%s' "$NUEVO/Aquiles.app"; fi
}

cambiar_app() {
    rm -rf "$ANTERIOR"
    mv "$APP" "$ANTERIOR" || fallar "No se pudo apartar la versión anterior ($APP)."
    if ! mv "$(pieza_nueva)" "$APP"; then
        mv "$ANTERIOR" "$APP"
        fallar "No se pudo cambiar a la versión nueva; sigue la anterior."
    fi
}

# El lanzador del menú de aplicaciones (Linux).
crear_lanzador() {
    local carpeta="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$carpeta" || return 1
    cat > "$carpeta/aquiles.desktop" <<LANZADOR
[Desktop Entry]
Type=Application
Name=Aquiles
Comment=Agente personal
Exec="$APP/aquiles"
Icon=$APP/aquiles.png
Terminal=false
Categories=Development;
StartupWMClass=aquiles
LANZADOR
    tiene update-desktop-database && update-desktop-database "$carpeta" >/dev/null 2>&1
    return 0
}

abrir_app() {
    if $LINUX; then
        # Sin la terminal ni este script: sigue abierta cuando acaban.
        (cd "$HOME" && setsid "$APP/aquiles" >/dev/null 2>&1 < /dev/null &)
    else
        open "$APP"
    fi
}

limpiar() {
    rm -rf "$CERROJO"
}

# En qué está el que tiene el cerrojo: compilando y esperando (a que se cierre Aquiles) se pueden
# interrumpir; cambiando (moviendo la app de sitio), no.
fase() {
    printf '%s\n' "$1" > "$CERROJO/fase"
}

# Que el pid del cerrojo sea de verdad un instalador y no otro proceso que heredó el número.
es_instalador() {
    ps -p "$1" -o command= 2>/dev/null | grep -q 'instalar\.sh'
}

# Un cerrojo con el pid dentro. Si lo tiene una instalación que sigue viva, se la sustituye: suele ser
# la que lanzó una app que ya se cerró, esperando a que se cierre también la que se abrió después
# (esperaría para siempre). Esta compila lo último de la rama y hace lo mismo que ella.
tomar_cerrojo() {
    local dueno i
    mkdir "$CERROJO" 2>/dev/null && return 0
    dueno=$(cat "$CERROJO/pid" 2>/dev/null)
    if [ -n "$dueno" ] && [ "$dueno" != "$$" ] && kill -0 "$dueno" 2>/dev/null && ! es_instalador "$dueno"; then
        # Otro proceso con el mismo pid: el cerrojo es de una instalación que ya no está. Salvo un bash
        # sin nombre de script (`curl … | bash`), que sí puede ser un instalador.
        if ps -p "$dueno" -o command= 2>/dev/null | grep -q bash; then fallar 'Ya hay otra instalación de Aquiles en marcha.'; fi
    elif [ -n "$dueno" ] && [ "$dueno" != "$$" ] && kill -0 "$dueno" 2>/dev/null; then
        if [ "$(cat "$CERROJO/fase" 2>/dev/null)" = cambiando ]; then
            fallar 'Otra instalación está cambiando Aquiles de versión; vuelve a intentarlo en un momento.'
        fi
        # Con su grupo de procesos (la app la lanza en uno propio): también git, bun o cargo si los había.
        kill -TERM -- "-$dueno" 2>/dev/null || kill -TERM "$dueno" 2>/dev/null
        for i in 1 2 3 4 5 6 7 8 9 10; do
            kill -0 "$dueno" 2>/dev/null || break
            sleep 1
        done
        kill -KILL -- "-$dueno" 2>/dev/null || kill -KILL "$dueno" 2>/dev/null
    fi
    # El anterior ya no está: su cerrojo sobra (su trap pudo borrarlo o no).
    rm -rf "$CERROJO"
    mkdir "$CERROJO" 2>/dev/null || fallar 'Ya hay otra instalación de Aquiles en marcha.'
}

principal() {
    mkdir -p "$REGISTRO" || { echo "No se puede crear $REGISTRO" >&2; exit 1; }
    tomar_cerrojo
    echo $$ > "$CERROJO/pid"
    fase compilando
    trap limpiar EXIT
    : > "$LOG"
    : > "$LOG_COMPILACION"
    rm -f "$NO_RELANZAR"

    if $LINUX; then paso 1 'Comprobando el compilador, Git, las bibliotecas de GTK y WebKit, Bun y Rust'
    else paso 1 'Comprobando las herramientas de Xcode, Git, Bun y Rust'; fi
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
    # El sidecar se llama con el triple de Rust: aarch64-apple-darwin, x86_64-unknown-linux-gnu…
    triple=$(RUSTUP_TOOLCHAIN=stable rustc -vV | sed -n 's/^host: //p')
    [ -n "$triple" ] || fallar 'No se pudo saber la arquitectura con rustc.'
    ejecutar "$CODIGO" bun build packages/nucleo/src/main.ts --compile \
        --outfile "apps/escritorio/src-tauri/binaries/aquiles-nucleo-$triple" || fallar "La compilación del núcleo falló (detalles en $LOG_COMPILACION)"

    paso 5 'Compilando la app (la primera vez tarda varios minutos)'
    escritorio="$CODIGO/apps/escritorio"
    if $LINUX; then
        # Sin paquete (.deb, AppImage): el ejecutable, el núcleo y las skills, como en Windows.
        ejecutar "$escritorio" env RUSTUP_TOOLCHAIN=stable bun run tauri build --no-bundle \
            || fallar "La compilación de la app falló (detalles en $LOG_COMPILACION)"
        compilado="$escritorio/src-tauri/target/release"
        [ -x "$compilado/aquiles" ] || fallar "La compilación no dejó $compilado/aquiles"
    else
        # rust-toolchain.toml pide el toolchain MSVC de Windows: en Mac se usa el stable.
        ejecutar "$escritorio" env RUSTUP_TOOLCHAIN=stable bun run tauri build --bundles app \
            || fallar "La compilación de la app falló (detalles en $LOG_COMPILACION)"
        compilado="$escritorio/src-tauri/target/release/bundle/macos/Aquiles.app"
        [ -x "$compilado/Contents/MacOS/aquiles" ] || fallar "La compilación no dejó $compilado"
        # El dictado por voz (Swift, con el reconocedor de macOS). Si no compila, Aquiles funciona igual, sin dictado.
        if ! ejecutar "$escritorio" bash src-tauri/macos/compilar-dictado.sh "$compilado"; then
            anotar "AVISO sin dictado por voz: no compiló aquiles-dictado (detalles en $LOG_COMPILACION)"
        fi
    fi

    paso 6 'Preparando la versión nueva'
    rm -rf "$NUEVO"
    mkdir -p "$NUEVO"
    local version
    version=$(printf '{\n  "commit": %s,\n  "fecha": %s,\n  "rama": %s,\n  "repo": %s,\n  "destino": %s\n}\n' \
        "$(json "$commit")" "$(json "$fecha")" "$(json "$RAMA")" "$(json "$origen")" "$(json "$DESTINO")")
    if $LINUX; then
        cp "$compilado/aquiles" "$compilado/aquiles-nucleo" "$NUEVO/" && cp -R "$compilado/skills" "$NUEVO/" \
            && cp "$escritorio/src-tauri/icons/128x128.png" "$NUEVO/aquiles.png" || fallar 'No se pudo copiar la app compilada.'
        printf '%s\n' "$version" > "$NUEVO/version.json"
    else
        ditto "$compilado" "$NUEVO/Aquiles.app" || fallar 'No se pudo copiar la app compilada.'
        printf '%s\n' "$version" > "$NUEVO/Aquiles.app/Contents/Resources/version.json"
        # version.json cambia el contenido del paquete: se vuelve a firmar (en local, sin identidad).
        ejecutar "$DESTINO" codesign --force --deep --sign - "$NUEVO/Aquiles.app" || fallar 'No se pudo firmar la app.'
    fi
    anotar "LISTO $commit"

    if [ -d "$APP" ]; then
        paso 7 'Esperando a que se cierre Aquiles para cambiar de versión'
        fase esperando
        esperar_cierre
        fase cambiando
        cambiar_app
    else
        paso 7 "Instalando en $(dirname "$APP")"
        fase cambiando
        mkdir -p "$(dirname "$APP")"
        mv "$(pieza_nueva)" "$APP" || fallar "No se pudo instalar en $APP."
    fi
    rm -rf "$NUEVO"
    if $LINUX && ! crear_lanzador; then anotar "AVISO no se pudo crear el lanzador del menú de aplicaciones"; fi
    fase hecho
    anotar "APLICADO $commit"
    # Instalada desde una copia de desarrollo: esa copia tiene que cerrarse antes, porque solo puede
    # haber un Aquiles abierto (en una actualización ya se esperó a que se cerrara).
    esperar_pid
    if { $RELANZAR || $INTERACTIVO; } && [ ! -e "$NO_RELANZAR" ]; then
        abrir_app
    fi
    rm -f "$NO_RELANZAR"
    if $INTERACTIVO; then printf '\033[32mAquiles %s está en %s.\033[0m\n' "${commit:0:7}" "$APP"; fi
}

# En la misma línea: bash lee el script según avanza, y git puede haberlo cambiado mientras tanto.
principal; exit $?
