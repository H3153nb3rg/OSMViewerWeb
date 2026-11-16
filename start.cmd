@echo off
rem Startet OSMViewer Web lokal und oeffnet den Browser.
cd /d "%~dp0"
set PORT=8137
start "" "http://localhost:%PORT%/"
where node >nul 2>nul && (node serve.mjs %PORT% & goto :eof)
where python >nul 2>nul && (python serve.py %PORT% & goto :eof)
where py >nul 2>nul && (py -3 serve.py %PORT% & goto :eof)
echo Weder Node.js noch Python gefunden. Bitte eines davon installieren oder den Ordner mit einem beliebigen Webserver ausliefern.
pause
