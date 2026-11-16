@echo off
rem Exportiert den Kachel-Cache des alten Java-OSMViewer (Berkeley DB) als z/x/y-Bilddateien,
rem die OSMViewer Web direkt verwendet. Liest die alten Datenbanken nur, aendert sie nicht.
rem
rem   export-legacy-cache.cmd                      alle Kartenquellen
rem   export-legacy-cache.cmd "OpenTopoMap" "My Topo"   nur diese (Namen ohne "db-")
rem
rem Benoetigt ein JDK ab Version 11 (java startet die .java-Datei direkt) und die
rem je-4.0.103.jar aus dem alten Projekt. Abbrechen und erneut starten ist jederzeit moeglich.
setlocal
set "JAR=%~dp0..\..\OSMViewer\lib\je-4.0.103.jar"
if not "%OSMV_JE_JAR%"=="" set "JAR=%OSMV_JE_JAR%"
set "CACHE=%APPDATA%\JF\OSMViewer\MapCache"
if not "%OSMV_DATA%"=="" set "CACHE=%OSMV_DATA%\MapCache"
if not exist "%JAR%" ( echo je-4.0.103.jar nicht gefunden: %JAR% & echo Pfad mit OSMV_JE_JAR setzen. & exit /b 1 )
if not exist "%CACHE%" ( echo Alter Kachel-Cache nicht gefunden: %CACHE% & exit /b 1 )
echo Quelle: %CACHE%
echo Ziel:   %CACHE%\tiles
java -cp "%JAR%" "%~dp0MapCacheExport.java" "%CACHE%" "%CACHE%\tiles" %*
endlocal
