@echo off
title Agent Ash — Launcher
cd /d "%~dp0"

echo [Agent Ash] Starting web server on port 3000...
start "Agent Ash — Web Server" cmd /c "npx serve . -p 3000"

echo [Agent Ash] Fetching initial price...
node fetch-price.js

echo [Agent Ash] Price loop running (every 6 hours). Close this window to stop.
:loop
timeout /t 21600 /nobreak >nul
echo [Agent Ash] Refreshing price...
node fetch-price.js
goto loop
