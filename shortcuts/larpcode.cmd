@echo off
REM LarpCode CLI launcher. The installer adds this folder to the user PATH,
REM so `larpcode` works from any terminal, just like `opencode`.
REM
REM Pass a directory or any CLI flag:
REM   larpcode C:\path\to\project
REM   larpcode --help

setlocal
set "APP_ROOT=%~dp0.."
for %%I in ("%APP_ROOT%") do set "APP_ROOT=%%~fI"
set "CLI=%APP_ROOT%\desktop-pkg\resources\opencode-cli.exe"

if not exist "%CLI%" (
  echo LarpCode CLI was not found at:
  echo   %CLI%
  echo Reinstall LarpCode and try again.
  pause
  exit /b 1
)

REM Keep the sidecar's state out of an installed OpenCode profile. These match
REM the folders configureApplication gives the desktop app.
set "XDG_DATA_HOME=%APPDATA%\ai.larpcode.desktop\xdg\data"
set "XDG_CONFIG_HOME=%APPDATA%\ai.larpcode.desktop\xdg\config"
set "XDG_CACHE_HOME=%APPDATA%\ai.larpcode.desktop\xdg\cache"
set "XDG_STATE_HOME=%APPDATA%\ai.larpcode.desktop\xdg\state"

if not exist "%XDG_DATA_HOME%" mkdir "%XDG_DATA_HOME%" >nul 2>&1
if not exist "%XDG_CONFIG_HOME%" mkdir "%XDG_CONFIG_HOME%" >nul 2>&1
if not exist "%XDG_CACHE_HOME%" mkdir "%XDG_CACHE_HOME%" >nul 2>&1
if not exist "%XDG_STATE_HOME%" mkdir "%XDG_STATE_HOME%" >nul 2>&1

title LarpCode CLI
"%CLI%" %*
exit /b %ERRORLEVEL%
