# Firma de código para bundle.windows.signCommand: Tauri lo llama con cada binario del
# instalador (aquiles.exe, el núcleo, el desinstalador y el propio instalador).
# Solo firma si AQUILES_CERT_HUELLA tiene la huella SHA-1 de un certificado del almacén del
# usuario; sin ella no hace nada, para que el build funcione en máquinas sin certificado.
# AQUILES_CERT_SELLO cambia el servidor de sellado de tiempo.
param([Parameter(Mandatory = $true)][string]$Ruta)

if (-not $env:AQUILES_CERT_HUELLA) { exit 0 }

$signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signtool) {
    # El SDK de Windows no lo pone en el PATH: el de la versión más reciente.
    $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool) {
    Write-Error "No se encuentra signtool.exe (Windows SDK)"
    exit 1
}

$sello = if ($env:AQUILES_CERT_SELLO) { $env:AQUILES_CERT_SELLO } else { "http://timestamp.digicert.com" }
& $signtool sign /sha1 $env:AQUILES_CERT_HUELLA /fd sha256 /tr $sello /td sha256 /d Aquiles $Ruta
exit $LASTEXITCODE
