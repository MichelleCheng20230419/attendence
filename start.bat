@echo off
title Attendance System - Backend Server
cd /d "%~dp0server"

echo ============================================
echo   Attendance System - One-click Start
echo ============================================
echo.
echo [1/2] Stopping old server on port 3000 ...
set "FOUND=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  set "FOUND=1"
  echo   Stopping PID %%p ...
  taskkill /F /PID %%p >nul 2>&1
)
if "%FOUND%"=="0" echo   No running server found.
timeout /t 1 /nobreak >nul

echo [2/2] Starting server (dev mode, auto-reload on code change) ...
echo       URL: http://localhost:3000
echo       Close this window to stop the server.
echo.
node --watch src/index.js

pause
