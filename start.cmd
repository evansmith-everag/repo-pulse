@echo off
rem Starts Repo Pulse and opens it in your browser. Needs Node.js 18 or newer on the PATH.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Download it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if "%PORT%"=="" set PORT=4317
rem Full path so a Unix "timeout" from Git on the PATH can't shadow the Windows one.
start "" /b cmd /c "%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul & start "" http://127.0.0.1:%PORT%"
:run
node server.js
rem Exit code 75 means "I installed an update, start me again".
if errorlevel 75 if not errorlevel 76 goto run
if errorlevel 1 (
  echo.
  echo Repo Pulse stopped with an error. Read the message above, then press any key to close.
  pause >nul
)
