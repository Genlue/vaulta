[CmdletBinding()]
param(
    [switch]$Offline,
    [switch]$Publish,
    [string]$NotesFile,
    [string]$TauriCli
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$repository = 'Genlue/vaulta'
Push-Location -LiteralPath $root
try {
    $config = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
    $version = $config.version
    if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
        throw "Expected a stable version in tauri.conf.json, not '$version'."
    }
    $tag = "v$version"
    $installerName = "vaulta_${version}_x64-setup.exe"
    $dist = Join-Path $root 'dist'
    $installer = Join-Path $dist $installerName
    $portable = Join-Path $dist "vaulta-$version-windows-x64.zip"
    $manifest = Join-Path $dist 'latest.json'
    if ($Publish) {
        # Build and release exactly the version already reviewed and pushed to main.
        $changes = git status --porcelain
        if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Commit the release source before publishing.' }
        $commit = git rev-parse HEAD
        if ($LASTEXITCODE -ne 0) { throw 'Could not resolve HEAD.' }
        $publishedHead = gh api "repos/$repository/commits/main" --jq '.sha'
        if ($LASTEXITCODE -ne 0 -or $publishedHead -ne $commit) { throw 'Push the release commit to GitHub main first.' }
    }

    if ($NotesFile) { $NotesFile = (Resolve-Path -LiteralPath $NotesFile).Path }
    $signer = if ($TauriCli) { $TauriCli } else { 'cargo' }
    $help = & $signer tauri signer sign --help | Out-String
    if ($LASTEXITCODE -ne 0 -or $help -notmatch '--app-version') {
        throw 'The Tauri CLI signer must support --app-version (e.g. 2.12.6).'
    }
    $previousKeyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
    $previousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    try {
        if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and -not $previousKeyPath) {
            $keyDir = Join-Path $env:LOCALAPPDATA 'VaultaReleaseSigning'
            $keyFile = Join-Path $keyDir 'vaulta.key'
            $passwordFile = Join-Path $keyDir 'password.dpapi'
            if (-not (Test-Path -LiteralPath $keyFile -PathType Leaf) -or -not (Test-Path -LiteralPath $passwordFile -PathType Leaf)) {
                throw 'Provide the existing release signing key and password through TAURI_SIGNING_PRIVATE_KEY[_PATH] and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.'
            }
            $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $keyFile
            $secure = Get-Content -LiteralPath $passwordFile -Raw | ForEach-Object { ConvertTo-SecureString $_.Trim() }
            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ([pscredential]::new('vaulta', $secure)).GetNetworkCredential().Password
        }
        & (Join-Path $PSScriptRoot 'build-windows.ps1') -NoBump -Offline:$Offline
        foreach ($path in @($installer, $portable)) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing x64 artifact: $path" }
        }
        $signature = "$installer.sig"
        & $signer tauri signer sign --app-version $version $installer
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $signature -PathType Leaf)) { throw 'Could not sign the updater package.' }
        $headline = "Vaulta $version"
        [ordered]@{
            version = $version
            notes = $headline
            pub_date = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
            platforms = [ordered]@{
                'windows-x86_64' = [ordered]@{
                    signature = (Get-Content -LiteralPath $signature -Raw).Trim()
                    url = "https://github.com/$repository/releases/download/$tag/$installerName"
                }
            }
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
    } finally {
        $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $previousKeyPath
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousPassword
    }

    if ($Publish) {
        # Do not expose a latest.json until all assets are attached to the draft.
        $notes = if ($NotesFile) { @('--notes-file', $NotesFile) } else { @('--generate-notes') }
        gh release create $tag $installer $portable $signature $manifest --repo $repository --target $commit --title $headline @notes --draft
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the draft release.' }
        gh release edit $tag --repo $repository --draft=false --latest
        if ($LASTEXITCODE -ne 0) { throw 'Could not publish the draft release.' }
    } else {
        Write-Host "Signed update assets: $dist"
    }
} finally { Pop-Location }
