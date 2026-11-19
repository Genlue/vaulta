# 一键重建：把当前工作区的改动打成 Windows 安装包和便携包。
#
# 中文兼容：
#   - 本文件以 UTF-8（带 BOM）保存，pwsh 7 和编辑器都能正确识别；
#   - 运行前把控制台输入/输出切到 UTF-8，中文字面量与 cargo 的输出都不会乱码；
#   - 路径一律用 -LiteralPath 与引号，仓库放在含中文或空格的目录下也能跑；
#   - 调用方 rebuild.cmd 只用 ASCII，避免 cmd 按 936 代码页解析脚本时出错。
#
# 用法（在仓库根目录）：
#   .\rebuild.cmd                 打包，补丁号 +1（仓库惯例）
#   .\rebuild.cmd -NoBump         原地重打当前版本，覆盖同名产物
#   .\rebuild.cmd -Test           先跑前端冒烟测试，通过后再打包
#   .\rebuild.cmd -SyncGlass      先从隔壁 GlassDesign 同步玻璃资源再打包
#   .\rebuild.cmd -Version 0.4.0  指定版本号
#   .\rebuild.cmd -Offline        打包时禁用 Cargo 网络访问
#   .\rebuild.cmd -NoPause        结束时不等待按键（供脚本/CI 调用）
[CmdletBinding()]
param(
    [switch]$NoBump,
    [string]$Version,
    [switch]$Offline,
    [switch]$Test,
    [switch]$SyncGlass,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

# 没有控制台时（CI、管道）这两行会失败，忽略即可。
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$root = Split-Path -Parent $PSScriptRoot
$clock = [System.Diagnostics.Stopwatch]::StartNew()

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

try {
    if (-not (Test-Path -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -PathType Leaf)) {
        throw "这里不是 vaulta 仓库根目录：$root"
    }

    Write-Host ''
    Write-Host 'vaulta 重建' -ForegroundColor Cyan
    Write-Host "仓库：$root"
    Write-Host "PowerShell：$($PSVersionTable.PSVersion)"

    # 隔壁 GlassDesign 的样式比 vendor 里新时，先提醒但不擅自重编 WASM。
    if (-not $SyncGlass) {
        $glassSource = Join-Path (Split-Path -Parent $root) 'GlassDesign/控件/css/glass.css'
        $glassVendor = Join-Path $root 'frontend/vendor/glassdesign/glass.css'
        if ((Test-Path -LiteralPath $glassSource -PathType Leaf) -and (Test-Path -LiteralPath $glassVendor -PathType Leaf)) {
            if ((Get-Item -LiteralPath $glassSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $glassVendor).LastWriteTimeUtc) {
                Write-Warning 'GlassDesign 的 glass.css 比 frontend/vendor 里的新。要一起更新请加 -SyncGlass。'
            }
        }
    }

    if ($SyncGlass) {
        Write-Step '同步 GlassDesign 运行时'
        & (Join-Path $PSScriptRoot 'sync-glassdesign.ps1')
    }

    if ($Test) {
        Write-Step '前端冒烟测试'
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '未找到 node，无法运行前端冒烟测试。' }
        & node (Join-Path $root 'frontend/tests/smoke.mjs')
        if ($LASTEXITCODE -ne 0) { throw '前端冒烟测试未通过，已停止打包。' }
    }

    Write-Step '打包 Windows 产物'
    $build = @{}
    if ($NoBump) { $build.NoBump = $true }
    if ($Version) { $build.Version = $Version }
    if ($Offline) { $build.Offline = $true }
    & (Join-Path $PSScriptRoot 'build-windows.ps1') @build

    # 产物清单以 tauri.conf.json 为准：build-windows.ps1 可能刚把版本号 +1。
    $built = (Get-Content -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
    $setup = Join-Path $root "dist/vaulta_${built}_x64-setup.exe"
    $zip = Join-Path $root "dist/vaulta-$built-windows-x64.zip"
    foreach ($file in $setup, $zip) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "缺少产物：$file" }
    }

    $setupItem = Get-Item -LiteralPath $setup
    $zipItem = Get-Item -LiteralPath $zip
    $fileVersion = $setupItem.VersionInfo.FileVersion
    $clock.Stop()

    Write-Step '完成'
    Write-Host ("版本    {0}" -f $built)
    Write-Host ("安装包  {0}  ({1:N1} MB, 文件版本 {2})" -f $setupItem.Name, ($setupItem.Length / 1MB), $fileVersion)
    Write-Host ("便携包  {0}  ({1:N1} MB)" -f $zipItem.Name, ($zipItem.Length / 1MB))
    Write-Host ("目录    {0}" -f (Join-Path $root 'dist'))
    Write-Host ("用时    {0:N0} 秒" -f $clock.Elapsed.TotalSeconds)
    exit 0
} catch {
    $clock.Stop()
    Write-Host ''
    Write-Host "重建失败：$($_.Exception.Message)" -ForegroundColor Red
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
    exit 1
}
