param(
    [switch]$Offline,
    [switch]$NoBump,
    [string]$Version
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
foreach ($asset in 'glass_web.js','glass_web_bg.wasm','glass.css','glass-defs.svg') {
    if (-not (Test-Path -LiteralPath (Join-Path $root "frontend/vendor/glassdesign/$asset") -PathType Leaf)) {
        throw "Missing GlassDesign asset '$asset'. Run scripts/sync-glassdesign.ps1."
    }
}
Push-Location $root
try {
    $confPath = Join-Path $root 'src-tauri/tauri.conf.json'
    $cargoPath = Join-Path $root 'src-tauri/Cargo.toml'
    $current = (Get-Content -LiteralPath $confPath -Raw | ConvertFrom-Json).version

    # Every packaged build gets its own patch version. Pass -Version to set one
    # explicitly (minor/major releases), or -NoBump to rebuild the current one.
    if (-not $Version) {
        if ($NoBump) {
            $Version = $current
        } elseif ($current -match '^(\d+)\.(\d+)\.(\d+)') {
            $Version = '{0}.{1}.{2}' -f $Matches[1], $Matches[2], ([int]$Matches[3] + 1)
        } else {
            throw "Cannot auto-bump version '$current'. Pass -Version explicitly."
        }
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') {
        throw "Invalid version '$Version'. Expected major.minor.patch."
    }

    if ($Version -ne $current) {
        # Replace only the version fields; keep the rest of each file byte-for-byte.
        $utf8 = [System.Text.UTF8Encoding]::new($false)
        $conf = Get-Content -LiteralPath $confPath -Raw
        $conf = [regex]::Replace($conf, '"version"\s*:\s*"' + [regex]::Escape($current) + '"', '"version": "' + $Version + '"', 1)
        [System.IO.File]::WriteAllText($confPath, $conf, $utf8)
        $cargo = Get-Content -LiteralPath $cargoPath -Raw
        $cargo = [regex]::Replace($cargo, '(?m)^version\s*=\s*"' + [regex]::Escape($current) + '"', 'version = "' + $Version + '"', 1)
        [System.IO.File]::WriteAllText($cargoPath, $cargo, $utf8)
        # Refresh the workspace lock entry before the --locked build.
        cargo check -p vaulta --offline | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to refresh Cargo.lock after the version bump.' }
        Write-Host "Version: $current -> $Version"
    } else {
        Write-Host "Version: $Version (unchanged)"
    }

    $priorOffline = $env:CARGO_NET_OFFLINE
    if ($Offline) { $env:CARGO_NET_OFFLINE = 'true' }
    try {
        cargo tauri build --ci --no-sign -- --locked
        if ($LASTEXITCODE -ne 0) { throw 'Vaulta build failed.' }
    } finally {
        $env:CARGO_NET_OFFLINE = $priorOffline
    }
    $dist = Join-Path $root 'dist'
    $portableName = "vaulta-$Version-windows-x64"
    $portable = Join-Path $dist $portableName
    New-Item -ItemType Directory -Force $portable | Out-Null
    foreach ($file in 'vaulta.exe','vaulta-agent.exe') {
        Copy-Item -LiteralPath (Join-Path $root "target/release/$file") -Destination $portable
    }
    Get-ChildItem -LiteralPath (Join-Path $root 'target/release/bundle/nsis') -Filter "vaulta_${Version}_*-setup.exe" -File |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $dist }
    Compress-Archive -LiteralPath $portable -DestinationPath (Join-Path $dist "$portableName.zip") -Force
    Write-Host "Vaulta $Version artifacts: $dist"
} finally { Pop-Location }
