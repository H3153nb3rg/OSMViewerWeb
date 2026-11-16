# OSMViewer Web

Routenplaner und GPX-Editor für den Browser – Nachfolger des Java-Fat-Clients **OSMViewer**.
Keine Installation, kein Build-Schritt, **keine Fremdbibliotheken** (0 Abhängigkeiten).

## Starten

ES-Module lassen sich nicht direkt von `file://` laden, daher wird ein kleiner lokaler Webserver mitgeliefert:

| Weg | Befehl |
|---|---|
| Windows, Doppelklick | `start.cmd` (nimmt Node.js, sonst Python) |
| Node.js ≥ 18 – **empfohlen** | `node serve.mjs` → <http://localhost:8137/> – mit Kachel- und Höhendaten-Cache auf der Platte |
| Python 3 | `python serve.py` → <http://localhost:8137/> – nur Auslieferung, ohne Platten-Cache |
| beliebiger Webserver | Ordner statisch ausliefern (nginx, IIS, GitHub Pages …) – ohne Platten-Cache |

Ausgelegt für aktuelle Chromium-, Firefox- und Safari-Versionen (ES2022, `<dialog>`, Pointer Events); in einem echten Browser noch nicht abgenommen, siehe ARCHITECTURE.md → Validierung.

## Lokaler Cache (mit `node serve.mjs`)

Alle Downloads landen im Datenordner des alten Java-OSMViewer, `%APPDATA%\JF\OSMViewer`:

| Was | Wo | Verhalten |
|---|---|---|
| Kartenkacheln | `MapCache\tiles\<Quelle>\z\x\y.png/.jpg` | einmal geladen, dann von der Platte; nach 30 Tagen bei Netz aufgefrischt, ohne Netz weiter benutzt |
| Höhendaten | `MapCache\hgtCacheDirectory\N47E011.hgt` | dieselben Dateien wie die Java-Version; fehlende Zellen werden nachgeladen |
| Vektorkacheln für Poster | `MapCache\tiles\OpenFreeMap\z\x\y.pbf` | wie Kartenkacheln |
| Suche, Routing | – | nicht gecacht (Ergebnisse ändern sich mit den OSM-Daten) |

Die Ordnernamen der Kartenquellen entsprechen denen der Java-Version (`Mapnik`, `OpenTopoMap`, `ArcGISSatellite` …). Der alte Kachel-Cache selbst steckt in Berkeley-DB-Dateien (`MapCache\db-*`), die ein Browser nicht lesen kann. Einmalig umwandeln:

```
tools\export-legacy-cache.cmd                         alle Quellen (bei dir ca. 39 GB – Platz beachten)
tools\export-legacy-cache.cmd "OpenTopoMap" "My Topo"  nur ausgewählte
```

Das braucht ein JDK ≥ 11 und die `je-4.0.103.jar` aus dem alten Projekt; die alten Datenbanken werden nur gelesen. Exportierte Quellen, die es im neuen Katalog gibt, werden direkt weiterverwendet; alle anderen (z. B. Bergfex, My Topo, Iskort) erscheinen in der Kartenauswahl unter **„Lokales Archiv (offline)“**.

Optionen: `node serve.mjs [port] --data <ordner> --offline --max-age <tage>` (`--max-age 0` = nie auffrischen, wie die Java-Version). Ohne lokalen Server lädt der Browser direkt von den Diensten; dann gilt nur der Browser-Cache.

## Mehrere Dateien, Vergleichen und Übernehmen

- **Öffnen** öffnet Dateien zusätzlich (nichts wird verworfen); die aktive Datei wird bearbeitet, die anderen werden gestrichelt in eigener Farbe darüber angezeigt.
- **Vergleichen** (oder eine Datei auf die Karte ziehen) öffnet sie **temporär**: Sie ist so markiert, wird nie ungefragt gespeichert und fragt beim Schließen nicht nach.
- Jedes Element einer Vergleichsdatei zeigt, ob es in der **Arbeitsdatei** schon vorkommt: *neu*, *xx % vorhanden* (teilweise gleicher Weg), *vorhanden* oder *identisch*. Der Vergleich ist geometrisch (Toleranz 30 m für Linien, 25 m für Wegpunkte) – auch dieselbe Strecke mit anderer Aufzeichnung wird erkannt.
- Übernehmen: im Dateikopf **„Neue übernehmen“** oder **„Alles“**, pro Element **Kopieren/Verschieben** in eine beliebige andere offene Datei (Eigenschaften → „Datei & Herkunft“, auch per Rechtsklick auf der Karte). Übernommene Elemente tragen ihre **Datenquelle** (Dateiname) im GPX-Standardfeld `<src>` – sichtbar in der Liste („← utah.gpx“) und änderbar.
- Ein Rückgängig-Schritt umfasst beide beteiligten Dateien. „Behalten“ macht eine temporäre Datei zu einer normalen.

## Funktionen

- **Dateien**: GPX 1.0/1.1 und KML öffnen (auch per Drag & Drop), mehrere gleichzeitig, vergleichen und Daten übernehmen (siehe oben), als GPX 1.1 oder KML speichern, Auswahl einzeln exportieren. Unbekannte Inhalte (Garmin-Extensions, `hdop`, Links …) bleiben beim Speichern erhalten.
- **Karte**: frei verfügbare Rasterkarten (OpenStreetMap, OpenTopoMap, CyclOSM, basemap.at, USGS Topo/Luftbild, Esri …), Wanderweg-/Radweg-Überlagerung, eigene XYZ-Quellen in den Einstellungen.
- **Bearbeiten**: Wegpunkte setzen/verschieben, Routen zeichnen, Punkte von Routen und Tracks verschieben, einfügen (Doppelklick auf die gewählte Linie), löschen; Track teilen, Segmente verbinden/trennen, umkehren, duplizieren, Track ↔ Route; Rückgängig/Wiederholen.
- **Optimieren**: Punktreduktion nach Douglas-Peucker mit Live-Vorschau – Stufe 1–10 (relativ zur Aufzeichnungsdichte), Toleranz in Metern, Prozent oder exakte Punktanzahl.
- **Reparieren**: doppelte Punkte entfernen, an Aufzeichnungslücken teilen, nach Verkehrsmittel (zu Fuß / Fahrzeug) trennen.
- **Drucken**: Ausschnitt wird für die gewählte Route/den Track berechnet – eine Seite exakt eingepasst (Hoch-/Querformat automatisch), auf runden Maßstab, oder als Streckenkarte über mehrere Seiten in festem Maßstab. Wahlweise mit Koordinatengitter und/oder beschrifteten Eckpunkten im wählbaren Koordinatensystem (Grad, UTM/MGRS). Vorschau, Druck/PDF über den Browser, PNG-Export.
- **Poster-Export**: Route oder Track (oder alle sichtbaren) als Wandbild – Knopf „Poster“ in der Leiste bzw. „Poster …“ in den Eigenschaften.
  - **Layout** per Vorschaubild wählbar: Galerie, Karte, Atlas, Kompass, Horizont (Musterblatt: `docs/poster-layouts.svg`); sieben **Kartenstile**, fünf **Schriften**.
  - **Kartengrundlage**: vereinfachte Vektorkarte · **Topo** (Wege, Bäche, Fels/Gletscher, Gipfel mit Höhe, dazu Höhenlinien aus den lokalen Höhendaten) · **Rasterkarte** aus jeder Kachelquelle, z. B. OpenTopoMap, wahlweise farblich zurückgenommen · ohne Karte.
  - **Text**: Überschrift, Unterzeile und frei editierbare Kennzahlen („Bezeichnung: Wert“ pro Zeile – vorbelegt aus den Daten; eine Route hat keine Zeiten, eine Dauer lässt sich eintragen), Höhenprofil, Nordpfeil, Maßstab, Koordinaten.
  - **Ausgabe**: **SVG** (Vektor, in jeder Größe verlustfrei) oder **PNG** bis 300 dpi; A4 bis A0 und 30 × 40 bis 70 × 100 cm. Eine Rasterkarte bleibt auch im SVG ein Bild: der Dialog zeigt die erreichte Auflösung und warnt, wenn das Format dafür zu groß ist.
- **Routing** über OSRM (Auto, Fahrrad, zu Fuß), **Ortssuche** über Nominatim, **Koordinateneingabe** in DD, DMM, DMS, UTM, MGRS, Maidenhead, Plus Code.
- **Höhenprofil** mit Kartenkopplung, Höhen nachladen – zuerst aus den lokalen SRTM-Dateien, für Lücken online (Open-Meteo/Copernicus DEM).

Nicht portiert (bewusst): GPS-Live-Aufzeichnung/NMEA, Diashow/Bildbetrachter, 3D-Ansicht (WorldWind), Luftraum-/Wetter-Overlays, IGC/OLC.

## Bedienung in Kürze

| Aktion | Bedienung |
|---|---|
| Karte verschieben / zoomen | Ziehen / Mausrad, Doppelklick, `+` `−`, Zwei-Finger-Geste |
| Element wählen | Klick auf Linie, Wegpunkt oder Listeneintrag; Doppelklick in der Liste zoomt |
| Punkt verschieben | gewähltes Element: Punkt ziehen |
| Punkt einfügen / löschen | Doppelklick auf die gewählte Linie / `Entf` bzw. Rechtsklick |
| Wegpunkt / Route | „＋ Wegpunkt“/„＋ Route“ in der Leiste, „＋“ in der Liste oder `W`/`R`; dann in die Karte klicken. Eine neue Route steht sofort in der Liste, eine gewählte Route wird fortgesetzt. `Esc`, Doppelklick oder „Fertig“ beendet |
| Routenpunkt per Koordinate | Route wählen → Eigenschaften → „Punkt per Koordinate“: eine Koordinate pro Zeile in beliebiger Schreibweise, `Enter` fügt hinzu. Ohne gewählten Punkt wird angehängt, sonst nach dem gewählten Punkt eingefügt |
| Navigationsroute zwischen zwei Punkten | Rechtsklick in die Karte → „Route von hier (Start)“ / „Route hierher (Ziel)“; ebenso „Start“/„Ziel“ bei Suchergebnissen, am Suchmarker und in den Eigenschaften eines Wegpunkts. Sobald beide gesetzt sind, entsteht eine Route mit Start und Ziel samt berechnetem Track; Zwischenziele lassen sich danach in der Route ergänzen und neu berechnen |
| Suchmarker entfernen | „Marker ✕“ neben dem Suchfeld, Suchfeld leeren, `Esc`/`Entf`, oder Klick auf den Marker → „Suchmarker entfernen“ |
| Koordinatengitter | Auswahl in der Leiste: Gitter, Eckkoordinaten oder beides – im Koordinatenformat der Einstellungen |
| Rückgängig / Wiederholen | `Strg+Z` / `Strg+Y` |
| Speichern / Öffnen / Drucken | `Strg+S` (`Umschalt` = Speichern unter) / `Strg+O` / `Strg+P` |

## Kommandozeile

Dieselbe Kernbibliothek ohne Browser (ersetzt die Python-Helfer aus `OSMViewer/tools`):

```
node cli/gpxtool.mjs info     tour.gpx
node cli/gpxtool.mjs optimize tour.gpx -o klein.gpx --level 5        (oder --tolerance 15 | --percent 30 | --count 500)
node cli/gpxtool.mjs repair   tour.gpx -o neu.gpx --gaps --split-mode
node cli/gpxtool.mjs merge    a.gpx b.kml -o alles.gpx
node cli/gpxtool.mjs convert  orte.kml -o orte.gpx
```

## Tests

```
node --test
```

79 Tests, ohne Netzwerk und ohne Browser lauffähig. Details zur Architektur und zum Stand der Validierung: [ARCHITECTURE.md](ARCHITECTURE.md).

## Externe Dienste

Karten, Routing, Suche, Höhen und die Vektordaten für den Poster-Export (OpenFreeMap, OpenMapTiles-Schema) kommen von öffentlichen, schlüssellosen Diensten; alle Adressen sind in den Einstellungen austauschbar (z. B. eigener OSRM- oder Kachelserver). Bitte die Nutzungsbedingungen beachten – insbesondere keine Massendrucke über `tile.openstreetmap.org` und höchstens eine Nominatim-Anfrage pro Sekunde.
