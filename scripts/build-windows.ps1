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
    $lockPath = Join-Path $root 'Cargo.lock'
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

    $changed = $Version -ne $current
    $saved = @{}
    if ($changed) {
        # Keep byte-for-byte copies so a failed build does not consume a version.
        $saved = @{
            Conf = Get-Content -LiteralPath $confPath -Raw
            Cargo = Get-Content -LiteralPath $cargoPath -Raw
            Lock = Get-Content -LiteralPath $lockPath -Raw
        }
    }

    try {
        if ($changed) {
            $utf8 = [System.Text.UTF8Encoding]::new($false)
            $conf = [regex]::Replace($saved.Conf, '"version"\s*:\s*"' + [regex]::Escape($current) + '"', '"version": "' + $Version + '"', 1)
            [System.IO.File]::WriteAllText($confPath, $conf, $utf8)
            $cargo = [regex]::Replace($saved.Cargo, '(?m)^version\s*=\s*"' + [regex]::Escape($current) + '"', 'version = "' + $Version + '"', 1)
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
    } catch {
        if ($changed) {
            $utf8 = [System.Text.UTF8Encoding]::new($false)
            [System.IO.File]::WriteAllText($confPath, $saved.Conf, $utf8)
            [System.IO.File]::WriteAllText($cargoPath, $saved.Cargo, $utf8)
            [System.IO.File]::WriteAllText($lockPath, $saved.Lock, $utf8)
            Write-Warning "Build failed; restored version $current."
        }
        throw
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
    # ZipFile writes no progress records, so CI logs stay free of archive chatter.
    $zip = Join-Path $dist "$portableName.zip"
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($portable, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    Write-Host "Vaulta $Version artifacts: $dist"
} finally { Pop-Location }
