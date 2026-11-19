@echo off
rem One-click rebuild for vaulta. Double-click it, or run it from a terminal:
rem   rebuild.cmd              build and bump the patch version
rem   rebuild.cmd -NoBump      rebuild the current version in place
rem   rebuild.cmd -Test        run the frontend smoke test first
rem   rebuild.cmd -SyncGlass   refresh GlassDesign assets first
rem
rem This file is ASCII-only on purpose: cmd parses a .cmd with the active code
rem page, so non-ASCII text here would break on Chinese Windows (cp936).
rem Chinese messages live in scripts\rebuild.ps1, which runs under UTF-8.
setlocal EnableExtensions
chcp 65001 >nul 2>nul
set "ROOT=%~dp0"

if not exist "%ROOT%scripts\rebuild.ps1" (
    echo [rebuild] scripts\rebuild.ps1 is missing next to this file.
    pause
    exit /b 1
)

rem PowerShell 5.1 is not supported; prefer a PowerShell 7 install path.
set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%PWSH%" set "PWSH=%LOCALAPPDATA%\Microsoft\PowerShell\7\pwsh.exe"
if not exist "%PWSH%" (
    where /q pwsh >nul 2>nul
    if errorlevel 1 (
        echo [rebuild] PowerShell 7 pwsh was not found. Install it first.
        pause
        exit /b 1
    )
    set "PWSH=pwsh"
)

"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\rebuild.ps1" %*
set "CODE=%ERRORLEVEL%"

rem Whether to wait for a key: double-click (no -NoPause) pauses, scripts do not.
echo %* | findstr /i /c:"-NoPause" >nul 2>nul
if errorlevel 1 (
    set "HOLD=1"
) else (
    set "HOLD="
)

if "%CODE%"=="0" goto :done
echo.
echo [rebuild] failed, exit code %CODE%
if defined HOLD pause
exit /b %CODE%

:done
if defined HOLD pause
exit /b 0
