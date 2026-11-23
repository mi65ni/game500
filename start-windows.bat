@echo off
REM 500 card game: starts the server and a free public Cloudflare link on a Windows PC.
REM Needs Node.js (https://nodejs.org, LTS). Keep this window open while you play.
cd /d "%~dp0"
where node >nul 2>nul || (echo Please install Node.js from https://nodejs.org first. & pause & exit /b 1)
if not exist node_modules call npm install --omit=dev
if not exist bin mkdir bin
if not exist bin\cloudflared.exe (
  echo Downloading cloudflared...
  curl -L -o bin\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
)
start "500 server" cmd /k "node server.js"
timeout /t 2 >nul
echo.
echo Look for a line ending in .trycloudflare.com below - that's the link to send your mates.
echo.
bin\cloudflared.exe tunnel --no-autoupdate --url http://localhost:8500
pause
