@echo off
rem One-click backup launcher (calls backup.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup.ps1"
echo.
echo Backup finished. Press any key to close...
pause >nul
