# Instala o actualiza Aquiles compilándolo desde una rama del repositorio (main por defecto).
#
#   git clone https://github.com/evilrender23/Aquiles
#   powershell -ExecutionPolicy Bypass -File Aquiles\instalar.ps1 [-Repo URL|RUTA] [-Rama main] [-Destino CARPETA]
#
# También vale descargado suelto, o con `irm <url de raw.githubusercontent.com> | iex` si el repo es
# público. Desde un clon, sin -Repo, instala desde el origin de ese clon. Con un repo privado, git pide
# las credenciales la primera vez (Git Credential Manager, o la sesión de GitHub Desktop).
# La app lo relanza con -Actualizar -EsperarPid <su pid> -Relanzar.
#
# En <Destino> (por defecto %LOCALAPPDATA%\Aquiles) deja:
#   codigo\    el clon, con las cachés (node_modules, target) para que la siguiente compilación sea rápida;
#   app\       aquiles.exe, aquiles-nucleo.exe, skills\ y version.json (commit, fecha, rama, repo);
#   registro\  actualizacion.log, con las líneas que lee la app (PASO n/total, LISTO, APLICADO, ERROR),
#              y compilacion.log, con la salida de git, bun y cargo.
#
# Sin -Actualizar pregunta e instala con winget lo que falte (Git, Bun, Rust, Build Tools de C++, WebView2).
# Con -Actualizar (lo que lanza la app) no instala ni pregunta nada. Compila en app.nuevo y, si ya hay
# app\, espera a que Aquiles se cierre (-EsperarPid) para cambiar las carpetas.
# Se guarda sin BOM a propósito: `irm | iex` no lo admite.
param(
    [string]$Repo = 'https://github.com/evilrender23/Aquiles',
    [string]$Rama = 'main',
    [string]$Destino = (Join-Path $env:LOCALAPPDATA 'Aquiles'),
    [switch]$Actualizar,
    [int]$EsperarPid = 0,
    [switch]$Relanzar
)

# PowerShell 5.1 lee como ANSI un .ps1 sin BOM y estropearía los acentos: se vuelve a leer en UTF-8.
if ('ñ'.Length -ne 1) {
    $relectura = $PSCommandPath
    & ([scriptblock]::Create([IO.File]::ReadAllText($PSCommandPath, [Text.Encoding]::UTF8))) @PSBoundParameters
    exit $LASTEXITCODE
}

$ErrorActionPreference = 'Stop'
$interactivo = -not $Actualizar
$repoIndicado = [bool]($PSBoundParameters -and $PSBoundParameters.ContainsKey('Repo'))
# Ejecutado desde un clon de Aquiles y sin -Repo: el mismo repositorio (un fork, una copia local).
$propio = if ($PSCommandPath) { Split-Path $PSCommandPath } elseif ($relectura) { Split-Path $relectura }
if (-not $repoIndicado -and $propio -and (Test-Path (Join-Path $propio 'apps\escritorio\src-tauri\tauri.conf.json')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    try {
        $origenPropio = & git -C $propio remote get-url origin 2>$null
        if ($LASTEXITCODE -eq 0 -and $origenPropio) { $Repo = "$origenPropio".Trim() }
    } catch { }
}
if ($Actualizar) {
    # Sin nadie delante, git no debe quedarse esperando credenciales: mejor que falle y lo diga.
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'
}
$codigo = Join-Path $Destino 'codigo'
$app = Join-Path $Destino 'app'
$nuevo = Join-Path $Destino 'app.nuevo'
$anterior = Join-Path $Destino 'app.anterior'
$registro = Join-Path $Destino 'registro'
$log = Join-Path $registro 'actualizacion.log'
$logCompilacion = Join-Path $registro 'compilacion.log'
# La app lo deja si sale sin aplicar la actualización (Salir en la bandeja): se cambia de versión, pero no se abre.
$noRelanzar = Join-Path $registro 'no-relanzar'
$toolchain = 'stable-x86_64-pc-windows-msvc'
$TOTAL = 7
$utf8 = New-Object System.Text.UTF8Encoding $false
$script:cerrojo = $null
$script:salidaUltima = @()

function Anotar([string]$linea) {
    [IO.File]::AppendAllText($log, "$linea`r`n", $utf8)
}

function Paso([int]$n, [string]$texto) {
    Anotar "PASO $n/$TOTAL $texto"
    if ($interactivo) { Write-Host "[$n/$TOTAL] $texto" -ForegroundColor Cyan }
}

# Ejecuta un programa con su salida en compilacion.log (y en pantalla si es interactivo).
function Ejecutar([string]$exe, [string[]]$argumentos, [string]$carpeta = $codigo, [switch]$SinComprobar) {
    [IO.File]::AppendAllText($logCompilacion, "> $exe $($argumentos -join ' ')`r`n", $utf8)
    $lineas = New-Object System.Collections.Generic.List[string]
    Push-Location $carpeta
    try {
        # Con 'Stop', PowerShell 5.1 corta en la primera línea que el programa escriba en stderr.
        $ErrorActionPreference = 'Continue'
        & $exe @argumentos 2>&1 | ForEach-Object {
            $texto = "$_"
            $lineas.Add($texto)
            [IO.File]::AppendAllText($logCompilacion, "$texto`r`n", $utf8)
            if ($interactivo) { Write-Host $texto -ForegroundColor DarkGray }
        }
        $salida = $LASTEXITCODE
        $script:salidaUltima = $lineas
    } finally {
        Pop-Location
    }
    if ($salida -ne 0 -and -not $SinComprobar) {
        throw "$exe $($argumentos[0]) terminó con código $salida (detalles en $logCompilacion)"
    }
}

function Tiene([string]$comando) {
    [bool](Get-Command $comando -ErrorAction SilentlyContinue)
}

function Agregar-AlPath([string]$carpeta) {
    if ($carpeta -and (Test-Path $carpeta) -and -not (($env:Path -split ';') -contains $carpeta)) {
        $env:Path = "$carpeta;$env:Path"
    }
}

# Lo recién instalado no está en el PATH de esta consola, y winget no siempre deja enlace de Bun.
function Refrescar-Path {
    foreach ($ambito in 'Machine', 'User') {
        foreach ($carpeta in ([Environment]::GetEnvironmentVariable('Path', $ambito) -split ';')) {
            if ($carpeta -and -not (($env:Path -split ';') -contains $carpeta)) { $env:Path = "$env:Path;$carpeta" }
        }
    }
    Agregar-AlPath (Join-Path $env:USERPROFILE '.cargo\bin')
    Agregar-AlPath (Join-Path $env:USERPROFILE '.bun\bin')
    $bun = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Oven-sh.Bun_*\bun-windows-x64\bun.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bun) { Agregar-AlPath $bun.DirectoryName }
}

function Hay-BuildTools {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { return $false }
    [bool](& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
}

function Hay-WebView2 {
    $id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $claves = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$id", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$id", "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$id"
    foreach ($clave in $claves) {
        $version = (Get-ItemProperty $clave -ErrorAction SilentlyContinue).pv
        if ($version -and $version -ne '0.0.0.0') { return $true }
    }
    $false
}

function Hay-RustMsvc {
    (Tiene rustup) -and [bool]((& rustup toolchain list) -match "^$toolchain")
}

function Con-Winget([string]$id, [string[]]$extra = @()) {
    # winget sale con códigos raros aunque instale; lo que vale es que luego se encuentre.
    Ejecutar winget (@('install', '--id', $id, '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements') + $extra) $Destino -SinComprobar
}

# En orden: rustup avisa si no hay Build Tools, y el toolchain MSVC necesita rustup.
$requisitos = @(
    @{ Nombre = 'Git'; Hay = { Tiene git }; Instalar = { Con-Winget 'Git.Git' } },
    @{ Nombre = 'Bun'; Hay = { Tiene bun }; Instalar = { Con-Winget 'Oven-sh.Bun' } },
    @{ Nombre = 'Build Tools de Visual Studio con C++'; Hay = { Hay-BuildTools }
       Instalar = { Con-Winget 'Microsoft.VisualStudio.2022.BuildTools' @('--override', '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended') } },
    @{ Nombre = 'Rust (rustup)'; Hay = { Tiene rustup }; Instalar = { Con-Winget 'Rustlang.Rustup' } },
    @{ Nombre = "Rust $toolchain"; Hay = { Hay-RustMsvc }; Instalar = { Ejecutar rustup @('toolchain', 'install', $toolchain, '--profile', 'minimal') $Destino } },
    @{ Nombre = 'WebView2'; Hay = { Hay-WebView2 }; Instalar = { Con-Winget 'Microsoft.EdgeWebView2Runtime' } }
)

function Comprobar-Requisitos {
    # Bun no instala dependencias con rutas de más de 260 caracteres, y hay algunas de unos 180.
    $largas = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -ErrorAction SilentlyContinue).LongPathsEnabled -eq 1
    if ($codigo.Length -gt 70 -and -not $largas) {
        throw "La carpeta $Destino es demasiado larga para compilar (Windows limita las rutas a 260 caracteres): usa una más corta con -Destino."
    }
    Refrescar-Path
    $faltan = @($requisitos | Where-Object { -not (& $_.Hay) })
    if (-not $faltan) { return }
    $nombres = ($faltan | ForEach-Object { $_.Nombre }) -join ', '
    if (-not $interactivo) { throw "Falta $nombres. Ejecuta instalar.ps1 sin -Actualizar para instalarlo." }
    if (-not (Tiene winget)) { throw "Falta $nombres y no hay winget para instalarlo: instálalo a mano y vuelve a ejecutar el instalador." }
    Write-Host "Falta: $nombres" -ForegroundColor Yellow
    $respuesta = Read-Host '¿Instalarlo con winget? [T]odo / [u]no a uno / [n]ada'
    foreach ($requisito in $faltan) {
        # Puede haber llegado con otro (el toolchain MSVC con rustup).
        if (& $requisito.Hay) { continue }
        $si = switch -regex ($respuesta.Trim().ToLower()) {
            '^(t|todo|s|si|sí)?$' { $true }
            '^u' { (Read-Host "¿Instalar $($requisito.Nombre)? [S/n]") -notmatch '^\s*n' }
            default { $false }
        }
        if (-not $si) { throw "Sin $($requisito.Nombre) no se puede compilar Aquiles." }
        Write-Host "Instalando $($requisito.Nombre)…"
        & $requisito.Instalar
        Refrescar-Path
        if (-not (& $requisito.Hay)) {
            throw "Se instaló $($requisito.Nombre), pero no aparece: abre una consola nueva y vuelve a ejecutar el instalador."
        }
    }
}

# Un fallo de git al clonar o traer cambios, dicho de forma que se entienda.
function Explicar-ErrorGit([string]$origen) {
    $texto = $script:salidaUltima -join "`n"
    if ($texto -match 'Authentication failed|Repository not found|could not read Username|terminal prompts disabled|\b40[13]\b') {
        throw "Sin acceso a $origen`: hace falta permiso para ver el repositorio y haber iniciado sesión en GitHub con Git (Git Credential Manager) o con GitHub Desktop."
    }
    if ($texto -match 'Could not resolve host|unable to access') {
        throw "Sin conexión con $origen."
    }
}

function Descargar-Codigo {
    if (Test-Path (Join-Path $codigo '.git')) {
        if ($repoIndicado) { Ejecutar git @('remote', 'set-url', 'origin', $Repo) }
        $origen = (& git -C $codigo remote get-url origin).Trim()
        try { Ejecutar git @('fetch', '--prune', 'origin', $Rama) } catch { Explicar-ErrorGit $origen; throw }
        Ejecutar git @('reset', '--hard', "origin/$Rama")
        # Sin -x: lo ignorado (node_modules, target) es la caché.
        Ejecutar git @('clean', '-fd')
    } else {
        New-Item -ItemType Directory -Force $Destino | Out-Null
        try { Ejecutar git @('clone', '--branch', $Rama, $Repo, $codigo) $Destino } catch { Explicar-ErrorGit $Repo; throw }
    }
}

function Procesos-DeLaApp {
    Get-Process aquiles, aquiles-nucleo -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith("$app\", [StringComparison]::OrdinalIgnoreCase) }
}

function Esperar-Cierre {
    if ($EsperarPid) {
        $proceso = Get-Process -Id $EsperarPid -ErrorAction SilentlyContinue
        if ($proceso) { $proceso.WaitForExit() }
    }
    $avisado = $false
    while (Procesos-DeLaApp) {
        if ($interactivo -and -not $avisado) {
            Write-Host 'Cierra Aquiles (Salir, en la bandeja) para terminar la actualización…' -ForegroundColor Yellow
            $avisado = $true
        }
        Start-Sleep -Seconds 1
    }
}

# Recién cerrada la app, Windows o el antivirus pueden tener aún algún fichero abierto.
function Reintentar([scriptblock]$accion) {
    for ($intento = 1; ; $intento++) {
        try { & $accion; return } catch { if ($intento -ge 20) { throw } }
        Start-Sleep -Milliseconds 500
    }
}

function Cambiar-Carpetas {
    if (Test-Path $anterior) { Reintentar { Remove-Item $anterior -Recurse -Force } }
    Reintentar { Rename-Item $app 'app.anterior' }
    try {
        Rename-Item $nuevo 'app'
    } catch {
        Rename-Item $anterior 'app'
        throw "No se pudo cambiar a la versión nueva ($($_.Exception.Message)); sigue la anterior."
    }
}

function Crear-Acceso([switch]$Sustituir) {
    $acceso = Join-Path ([Environment]::GetFolderPath('Programs')) 'Aquiles.lnk'
    if ((Test-Path $acceso) -and -not $Sustituir) { return }
    $exe = Join-Path $app 'aquiles.exe'
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($acceso)
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $app
    $lnk.IconLocation = "$exe,0"
    $lnk.Description = 'Aquiles'
    $lnk.Save()
}

function Principal {
    New-Item -ItemType Directory -Force $registro | Out-Null
    try {
        $script:cerrojo = [IO.File]::Open((Join-Path $registro 'instalar.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch {
        throw 'Ya hay otra instalación de Aquiles en marcha.'
    }
    [IO.File]::WriteAllText($log, '', $utf8)
    [IO.File]::WriteAllText($logCompilacion, '', $utf8)
    Remove-Item $noRelanzar -ErrorAction SilentlyContinue

    Paso 1 'Comprobando Git, Bun, Rust, Build Tools y WebView2'
    Comprobar-Requisitos

    Paso 2 "Descargando el código ($Rama)"
    Descargar-Codigo
    $commit = (& git -C $codigo rev-parse HEAD).Trim()
    $version = [ordered]@{
        commit = $commit
        fecha = (& git -C $codigo log -1 --format=%cI).Trim()
        rama = $Rama
        repo = (& git -C $codigo remote get-url origin).Trim()
    }

    Paso 3 'Instalando las dependencias'
    Ejecutar bun @('install', '--frozen-lockfile')

    Paso 4 'Compilando el núcleo'
    Ejecutar bun @('run', 'compilar:nucleo')

    Paso 5 'Compilando la app (la primera vez tarda varios minutos)'
    # Sin instalador ni artefactos del actualizador: no hace falta ninguna clave.
    Ejecutar bun @('x', 'tauri', 'build', '--no-bundle') (Join-Path $codigo 'apps\escritorio')
    $compilado = Join-Path $codigo 'apps\escritorio\src-tauri\target\release'
    foreach ($pieza in 'aquiles.exe', 'aquiles-nucleo.exe', 'skills') {
        if (-not (Test-Path (Join-Path $compilado $pieza))) { throw "La compilación no dejó $pieza en $compilado" }
    }

    Paso 6 'Preparando la versión nueva'
    if (Test-Path $nuevo) { Reintentar { Remove-Item $nuevo -Recurse -Force } }
    New-Item -ItemType Directory $nuevo | Out-Null
    Copy-Item (Join-Path $compilado 'aquiles.exe'), (Join-Path $compilado 'aquiles-nucleo.exe') $nuevo
    Copy-Item (Join-Path $compilado 'skills') $nuevo -Recurse
    [IO.File]::WriteAllText((Join-Path $nuevo 'version.json'), ($version | ConvertTo-Json), $utf8)
    Anotar "LISTO $commit"

    if (Test-Path $app) {
        Paso 7 'Esperando a que se cierre Aquiles para cambiar de versión'
        Esperar-Cierre
        Cambiar-Carpetas
        Crear-Acceso
    } else {
        Paso 7 'Instalando en el menú Inicio'
        Move-Item $nuevo $app
        Crear-Acceso -Sustituir
    }
    Anotar "APLICADO $commit"
    # Instalada desde una copia de desarrollo: esa copia tiene que cerrarse antes, porque solo puede
    # haber un Aquiles abierto (en una actualización ya se esperó a que se cerrara).
    if ($EsperarPid) {
        $proceso = Get-Process -Id $EsperarPid -ErrorAction SilentlyContinue
        if ($proceso) { $proceso.WaitForExit() }
    }
    if (($Relanzar -or $interactivo) -and -not (Test-Path $noRelanzar)) {
        Start-Process (Join-Path $app 'aquiles.exe')
    }
    Remove-Item $noRelanzar -ErrorAction SilentlyContinue
    if ($interactivo) { Write-Host "Aquiles $($commit.Substring(0, 7)) está en $app y en el menú Inicio." -ForegroundColor Green }
}

$resultado = 0
$codificacion = [Console]::OutputEncoding
try {
    # Para leer bien la salida de git, bun y cargo, que escriben en UTF-8.
    try { [Console]::OutputEncoding = $utf8 } catch { }
    Principal
} catch {
    $resultado = 1
    $texto = ($_.Exception.Message -replace '\s*[\r\n]+\s*', ' ').Trim()
    try { Anotar "ERROR $texto" } catch { }
    if ($interactivo) { Write-Host "ERROR: $texto" -ForegroundColor Red }
} finally {
    if ($script:cerrojo) { $script:cerrojo.Dispose() }
    try { [Console]::OutputEncoding = $codificacion } catch { }
}
# Con -File, el código de salida; con `irm | iex`, no se cierra la consola de quien lo ejecuta.
if ($PSCommandPath -or $relectura) { exit $resultado }
