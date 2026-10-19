@echo off
where node >nul 2>nul || (echo Cinq needs Node.js 20+ from https://nodejs.org & pause & exit /b 1)
node "%~dp0server\cli.js" install-plugin
pause
