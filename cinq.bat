@echo off
rem Without arguments (or double-clicked) this starts the server, syncing every place into the Cinq folder next to it.
where node >nul 2>nul || (echo Cinq needs Node.js 20+ from https://nodejs.org & pause & exit /b 1)
if "%~1"=="" (
	title Cinq
	node "%~dp0server\cli.js" run
	pause
) else (
	node "%~dp0server\cli.js" %*
)
