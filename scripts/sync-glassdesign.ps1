[CmdletBinding()]
param(
    # A local checkout is a development override only; the default path is the
    # tagged upstream, matching how the Rust projects pin GlassDesign in Cargo.
    [string]$GlassDesignPath = '',
    [string]$Ref = 'v0.10.1'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$repository = 'https://github.com/Genlue/GlassDesign'
$stage = Join-Path $root 'target/glass-web-assets'
$output = Join-Path $root 'frontend/vendor/glassdesign'

if ($GlassDesignPath) {
    $source = (Resolve-Path -LiteralPath $GlassDesignPath).ProviderPath
    if (-not (Test-Path -LiteralPath (Join-Path $source 'scripts/build-web.ps1') -PathType Leaf)) {
        throw "GlassDesign is missing its Web adapter build script: $source"
    }
    $tag = (& git -C $source describe --tags --exact-match 2>$null)
    if (-not $tag) { $tag = $Ref }
    Write-Host "Source: local checkout $source ($tag)"
} else {
    if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) {
        throw 'git is required to fetch the pinned GlassDesign tag.'
    }
    $source = Join-Path $root 'target/glassdesign'
    if ((Test-Path -LiteralPath $source) -and -not (Test-Path -LiteralPath (Join-Path $source '.git') -PathType Container)) {
        throw "target/glassdesign exists but is not a git checkout. Remove it and retry."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $source '.git') -PathType Container)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $source) -Force | Out-Null
        & git clone --depth 1 --branch $Ref $repository $source
        if ($LASTEXITCODE -ne 0) { throw "git clone failed for $repository at $Ref." }
    } else {
        & git -C $source fetch --depth 1 --force origin $Ref
        if ($LASTEXITCODE -ne 0) { throw "git fetch failed for $repository at $Ref." }
        & git -C $source -c advice.detachedHead=false checkout --force FETCH_HEAD
        if ($LASTEXITCODE -ne 0) { throw "git checkout failed for $Ref." }
    }
    $tag = (& git -C $source describe --tags --exact-match 2>$null)
    if ($tag -ne $Ref) { throw "Expected GlassDesign $Ref, found '$tag' in $source." }
    Write-Host "Source: $repository @ $Ref"
}

$commit = (& git -C $source rev-parse HEAD).Trim()
if (-not $commit) { throw 'Cannot read the GlassDesign commit.' }
$builder = Join-Path $source 'scripts/build-web.ps1'
& $builder -OutDir $stage
if ($LASTEXITCODE -ne 0) { throw 'GlassDesign Web adapter build failed.' }

$files = 'glass_web.js', 'glass_web_bg.wasm', 'glass.css', 'glass-defs.svg'
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $stage $file) -Destination (Join-Path $output $file) -ErrorAction Stop
}
$license = Join-Path $source 'LICENSE'
if (-not (Test-Path -LiteralPath $license -PathType Leaf)) { $license = Join-Path $source '控件/LICENSE' }
Copy-Item -LiteralPath $license -Destination (Join-Path $output 'LICENSE') -ErrorAction Stop
if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'node is required to generate icons.js from the upstream icon table.'
}
& node (Join-Path $PSScriptRoot 'gen-glass-icons.mjs') (Join-Path $source '控件/src/base/icon.rs') (Join-Path $output 'icons.js')
if ($LASTEXITCODE -ne 0) { throw 'Icon snapshot generation failed.' }

# The repository stores text as LF (.gitattributes), so normalize here as well.
# Otherwise the hashes below describe bytes that a fresh checkout would not have.
function Write-Lf([string]$Path) {
    $text = [IO.File]::ReadAllText($Path) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
}
foreach ($file in $files) {
    if ($file -notlike '*.wasm') { Write-Lf (Join-Path $output $file) }
}
Write-Lf (Join-Path $output 'LICENSE')

# Provenance is the host's analogue of a `tag = "v0.10.1"` dependency line:
# both files describe the exact source of the committed runtime.
$hashes = @{}
foreach ($file in $files) {
    $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $output $file) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$synced = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$provenance = @"
# GlassDesign embedded web assets

`glass_web.js`, `glass_web_bg.wasm`, `glass.css`, and `glass-defs.svg` are built from
GlassDesign ``$Ref`` (commit ``$commit``) by ``scripts/sync-glassdesign.ps1``. That script
fetches the pinned tag from <$repository>, runs its ``scripts/build-web.ps1`` and copies the
four files here, so the JS and WASM always come from one build. ``icons.js`` is generated
from the same commit's ``控件/src/base/icon.rs``. See ``LICENSE`` for GlassDesign's license.

Synced: $synced
"@
[IO.File]::WriteAllText((Join-Path $output 'PROVENANCE.md'), ($provenance -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false))
$manifest = [ordered]@{
    repository = $repository
    tag        = $Ref
    commit     = $commit
    synced     = $synced
    files      = $hashes
}
$json = ($manifest | ConvertTo-Json -Depth 3) -replace "`r`n", "`n"
[IO.File]::WriteAllText((Join-Path $output 'UPSTREAM.json'), "$json`n", [Text.UTF8Encoding]::new($false))
Write-Host "Updated GlassDesign runtime $Ref ($commit) in $output"
