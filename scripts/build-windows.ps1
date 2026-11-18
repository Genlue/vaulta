param([switch]$Offline)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
foreach ($asset in 'glass_web.js','glass_web_bg.wasm','glass.css','glass-defs.svg') {
    if (-not (Test-Path -LiteralPath (Join-Path $root "frontend/vendor/glassdesign/$asset") -PathType Leaf)) {
        throw "Missing GlassDesign asset '$asset'. Run scripts/sync-glassdesign.ps1."
    }
}
Push-Location $root
try {
    $priorOffline = $env:CARGO_NET_OFFLINE
    if ($Offline) { $env:CARGO_NET_OFFLINE = 'true' }
    try {
        cargo tauri build --ci --no-sign -- --locked
        if ($LASTEXITCODE -ne 0) { throw 'Vaulta build failed.' }
    } finally {
        $env:CARGO_NET_OFFLINE = $priorOffline
    }
    $dist = Join-Path $root 'dist'
    $version = (Get-Content -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
    $portableName = "vaulta-$version-windows-x64"
    $portable = Join-Path $dist $portableName
    New-Item -ItemType Directory -Force $portable | Out-Null
    foreach ($file in 'vaulta.exe','vaulta-agent.exe') {
        Copy-Item -LiteralPath (Join-Path $root "target/release/$file") -Destination $portable
    }
    Get-ChildItem -LiteralPath (Join-Path $root 'target/release/bundle/nsis') -Filter "vaulta_${version}_*-setup.exe" -File |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $dist }
    Compress-Archive -LiteralPath $portable -DestinationPath (Join-Path $dist "$portableName.zip") -Force
    Write-Host "Vaulta artifacts: $dist"
} finally { Pop-Location }
