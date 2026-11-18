[CmdletBinding()]
param(
    [string]$GlassDesignPath = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'GlassDesign')
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = (Resolve-Path -LiteralPath $GlassDesignPath).ProviderPath
$builder = Join-Path $source 'scripts/build-web.ps1'
$stage = Join-Path $root 'target/glass-web-assets'
$output = Join-Path $root 'frontend/vendor/glassdesign'
if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) { throw 'GlassDesign is missing its Web adapter build script.' }
& $builder -OutDir $stage
foreach ($file in 'glass_web.js','glass_web_bg.wasm','glass.css','glass-defs.svg') {
    Copy-Item -LiteralPath (Join-Path $stage $file) -Destination (Join-Path $output $file) -ErrorAction Stop
}
Write-Host "Updated GlassDesign runtime ($output)"
