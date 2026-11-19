@echo off
REM LarpCode launcher. Starts the installed desktop app.
REM The Start Menu and desktop shortcuts use LarpCode.vbs instead.
start "" "%~dp0..\electron\electron.exe" "%~dp0..\desktop-pkg"
