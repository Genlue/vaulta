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

# The host glue is vendored as a workspace crate so an offline build does not
# need the sibling GlassDesign checkout. Keep the source of truth upstream.
$hostSource = Join-Path $source 'host'
$hostTarget = Join-Path $root 'crates/glass-design-host'
foreach ($file in 'Cargo.toml','src/lib.rs','assets/wallpaper.js','README.md') {
    $destination = Join-Path $hostTarget $file
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
    Copy-Item -LiteralPath (Join-Path $hostSource $file) -Destination $destination -ErrorAction Stop
}
# Loaded as a plain <script> from frontendDist, not bundled with the wasm.
Copy-Item -LiteralPath (Join-Path $hostSource 'assets/wallpaper.js') -Destination (Join-Path $root 'frontend/wallpaper.js') -ErrorAction Stop
Write-Host "Updated glass-design-host ($hostTarget)"
