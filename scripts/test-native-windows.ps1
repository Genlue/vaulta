[CmdletBinding()]
param([switch]$SkipWindowChrome)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $root
$priorConfig = $env:TAURI_CONFIG
try {
    $config = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
    $port = if ($env:VAULTA_NATIVE_TEST_PORT) { [int]$env:VAULTA_NATIVE_TEST_PORT } else { 39377 }
    if ($port -lt 1024 -or $port -gt 65535) { throw 'Invalid VAULTA_NATIVE_TEST_PORT.' }
    $config.app.windows[0] | Add-Member -NotePropertyName 'additionalBrowserArgs' -NotePropertyValue "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
    $env:TAURI_CONFIG = @{ app = @{ windows = $config.app.windows } } | ConvertTo-Json -Depth 20 -Compress
    cargo build -p vaulta --bin vaulta --features custom-protocol --locked --offline
    if ($LASTEXITCODE -ne 0) { throw 'Native smoke build failed.' }
    node frontend/tests/native-smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Native smoke failed.' }
    if (-not $SkipWindowChrome) {
        $priorChromePort = $env:VAULTA_CHROME_TEST_PORT
        try {
            $env:VAULTA_CHROME_TEST_PORT = [string]$port
            # The first isolated WebView2 can take a moment to release its listener.
            Start-Sleep -Milliseconds 650
            node frontend/tests/window-chrome-native.mjs target/debug/vaulta.exe
            if ($LASTEXITCODE -ne 0) { throw 'Native window chrome smoke failed.' }
        } finally { $env:VAULTA_CHROME_TEST_PORT = $priorChromePort }
    }
} finally {
    $env:TAURI_CONFIG = $priorConfig
    Pop-Location
}
