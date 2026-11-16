# Architektur – OSMViewer Web

Stand: 2026-11-10 (2. Ausbaustufe: Platten-Cache, mehrere Dateien, Vergleich). Ablöse des Java/Swing-Fat-Clients `OSMViewer` (989 Java-Dateien, ~70 JARs, native DLLs).

## Ziele und Leitplanken

1. Browserfähig, lokal und gehostet lauffähig.
2. Herstellerunabhängig: keine Bibliothek, kein SDK, kein API-Schlüssel, kein Build-Werkzeug.
3. Kernaufgaben: GPX bearbeiten, Routen/Wegpunkte auf freiem Kartenmaterial darstellen, Routen in ideal zugeschnittenen Ausschnitten drucken, GPX optimieren.
4. Nicht im Umfang: Aufzeichnung (GPS/NMEA/seriell), Diashow.

## Entscheidungen

| # | Entscheidung | Begründung | Verworfen |
|---|---|---|---|
| 1 | **JavaScript (ES2022-Module) ohne Build-Schritt**, Typen als JSDoc | Läuft unverändert in jedem Browser und in Node; in 10 Jahren noch startbar, ohne dass ein Toolchain-Stand rekonstruiert werden muss (das Altprojekt scheitert genau daran: Ant, NetBeans-Formulare, JDK-Bindung, native DLLs). | TypeScript + Bundler (bräuchte npm-Abhängigkeiten); Java/GWT, Blazor/WASM (schwere Runtime, weiter Herstellerbindung) |
| 2 | **Null Laufzeit-Abhängigkeiten**, eigene Kachelkarte auf `<canvas>` | Der benötigte Kartenumfang (XYZ-Raster, Web-Mercator, Linien, Marker) ist klein (~250 Zeilen). Derselbe Renderer zeichnet Bildschirm *und* Druckseite – nur so ist „was das Layout berechnet, wird gedruckt“ garantiert. | Leaflet/OpenLayers/MapLibre (gut, aber externe Abhängigkeit; Druck in definierter Auflösung dort nur über Umwege) |
| 3 | **Kern strikt von der Oberfläche getrennt** (`src/core` kennt kein DOM) | Kern läuft in Node: testbar ohne Browser, als CLI nutzbar, UI austauschbar. | – |
| 4 | **Eigener kleiner XML-Parser** statt `DOMParser` | `DOMParser` gibt es in Node nicht; GPX/KML brauchen nur Elemente, Attribute, Text, CDATA, Entities (150 Zeilen). | – |
| 5 | **Dokumentmodell = einfache JSON-Objekte**, Unbekanntes als Roh-XML in `extra` | `structuredClone` liefert Undo-Schnappschüsse gratis; Fremd-Extensions (Garmin u. a.) überleben das Speichern in Schema-Reihenfolge. | Klassenhierarchie wie JAXB im Altprojekt |
| 6 | **Optimierung über RDP-Gewichte** (jeder Punkt erhält die Toleranz, bis zu der er erhalten bleibt) | Ein Durchlauf beantwortet alle Modi – Toleranz, Stufe, Prozent, exakte Punktzahl – und macht den Schieberegler verzögerungsfrei. Ersetzt sowohl den flächenbasierten `TrackShrink` (Java) als auch die Binärsuche des Python-Werkzeugs. | Visvalingam-Whyatt zusätzlich (kein Mehrwert gegenüber Punktzahl-Modus) |
| 7 | **Drucklayout als reine Funktion** (`core/printlayout.js`) mit gebrochenem Zoom | Der Ausschnitt wird exakt eingepasst statt auf ganze Kachelraster (Altprojekt: `getNrOfTilesForPage`). Streckenkarten: gieriges Zerlegen entlang des Wegs, Format je Seite. | Server-seitige PDF-Erzeugung (JasperReports/iText im Altprojekt) – der Browser druckt und erzeugt PDF selbst |
| 8 | **Dienste als austauschbare HTTP-Endpunkte** (OSRM, Nominatim, Open-Meteo-Höhen) | Schlüssellos, in den Einstellungen umstellbar auf eigene Instanzen. Höhen per API statt SRTM-Kachel-Download. | – |
| 9 | ~~Ein Arbeitsdokument, weitere Dateien werden hinzugefügt~~ → abgelöst durch Nr. 14 | Ursprünglich gewählt, um die Oberfläche einfach zu halten; das Prüfen vor dem Übernehmen war damit nicht möglich. | – |
| 10 | Oberfläche **deutsch**, Texte direkt im UI-Code | Ein Nutzerkreis; i18n-Schicht wäre Aufwand ohne Nutzen. Kern ist sprachneutral bis auf Fehlermeldungen. | – |
| 11 | **Platten-Cache im lokalen Server** (`serve.mjs` + `server/datastore.mjs`), im Datenordner der Java-Version | Ein Browser darf nicht in beliebige Ordner schreiben; der ohnehin nötige lokale Server kann es. Gleicher Ort und gleiche Store-Namen wie bisher → vorhandene Höhendaten werden sofort genutzt, exportierte Kacheln ebenso. Nur Katalogquellen werden geladen (kein offener Proxy), Anfragen fremder Webseiten (`Sec-Fetch-Site: cross-site`) werden abgewiesen. | Service Worker/Cache API (Daten im Browserprofil versteckt, an einen Browser gebunden); Berkeley-DB direkt lesen (nur mit Java-Bibliothek möglich) |
| 12 | Alter Kachel-Cache: **einmaliger Export** mit `tools/MapCacheExport.java` nach `z/x/y`-Dateien | Java nur noch als Migrationswerkzeug, ohne die alten Klassen (DPL-`RawStore`, nur lesend). `z/x/y` ist das Format, das fast jedes Kartenwerkzeug versteht. Quellen ohne heutigen Server bleiben als Offline-Archiv nutzbar. | Container-Format wie MBTiles (SQLite fehlt im JDK und wäre für den Browser wieder eine Abhängigkeit) |
| 13 | Höhen: lokale `.hgt`-Zellen zuerst, fehlende von AWS Terrain Tiles (`skadi`), Rest online | Der SRTM-Server der Java-Version leitet nur noch um (die gespeicherten `*.index.html` sind Umleitungsseiten). | – |
| 14 | **Mehrere offene Dateien** statt Zusammenführen beim Öffnen; Vergleichsdateien **temporär**; Herkunft im GPX-Feld `<src>` | Prüfen vor Übernehmen, ohne die Arbeitsdatei zu verändern. `<src>` ist GPX-Standard, überlebt also Speichern und andere Programme. Eine aktive Datei bleibt das einzige Bearbeitungsziel – Gesten und Befehle bleiben eindeutig. | Mehrere gleichzeitig editierbare Dateien; eigenes Extension-Feld für „temporär“ |
| 15 | **Vergleich geometrisch** (`core/compare.js`): Abtastung alle Toleranz/2, räumliches Gitter, Abdeckung als Längenanteil | Dieselbe Tour aus zwei Geräten hat nie dieselben Punkte; Namensgleichheit sagt nichts. 200 km Track gegen 200 km Track in < 1 s. | Punkt-für-Punkt-Vergleich; Hausdorff-Distanz (eine Zahl, sagt nicht *wie viel* neu ist) |
| 16 | **Poster als SVG aus Vektorkacheln** (`core/mvt.js`, `core/poster.js`): eigener Decoder für Mapbox Vector Tiles, Daten von OpenFreeMap (OpenMapTiles-Schema, schlüssellos) | Nur Vektordaten lassen sich beliebig groß drucken und frei einfärben; Rasterkacheln wären bei 70 × 100 cm unscharf und stilistisch festgelegt. Das Format ist ein offener Standard, der Decoder hat 130 Zeilen. Ohne Kartendaten entsteht trotzdem ein Poster (nur Route). PNG entsteht im Browser aus demselben SVG. | Rasterkacheln entsättigen; Overpass-Abfragen (für große Gebiete zu langsam und zu schwer); MapLibre (Abhängigkeit, kein Vektor-Export) |
| 17 | **Topo aus Vektordaten + eigenen Höhenlinien** (`core/contours.js`, Marching Squares über ein Höhenraster von `serve.mjs`) | Freie, schlüssellose Vektor-Topokarten gibt es nicht; OpenMapTiles enthält aber Wege, Bäche, Fels, Gletscher und Gipfel, und die Höhendaten liegen ohnehin lokal (SRTM). Höhenlinien daraus sind Vektoren und damit beliebig groß druckbar. | Fertige Höhenlinien-Kacheln (nur mit Schlüssel bzw. Anbieterbindung); Schummerung (Rasterbild) |
| 18 | **Rasterkarte als wählbare Poster-Grundlage** – Kacheln werden zu einem Bild im Kartenrahmen, Route und Text bleiben Vektor | Macht jede Kachelquelle (OpenTopoMap, Archiv-Ebenen der Java-Version) nutzbar und ist der Ausweg, wenn die Vektorkarte nicht erreichbar ist. Die Druckgröße ist durch den höchsten Zoom der Quelle begrenzt; die erreichte Auflösung wird berechnet und angezeigt. | Raster stillschweigend hochskalieren |
| 19 | **Berkeley DB nicht als Cache-Format** (auch wenn immer `serve.mjs` läuft) | Das Format ist nur über die Java-Bibliothek `je` (Oracle) les- und schreibbar – Node bräuchte dauerhaft einen Java-Hilfsprozess, also wieder JDK-, Versions- und Herstellerbindung, die das Projekt ablösen sollte. JE erlaubt zudem nur einen schreibenden Prozess pro Datenbank: Alt- und Neuprogramm könnten den Cache nicht gleichzeitig nutzen. Dateien `z/x/y` sind dagegen von jedem Werkzeug les- und prüfbar. Kompatibilität besteht über den einmaligen Export. | Java-Sidecar als Lese-/Schreibbrücke; Neuimplementierung des JE-Formats in JavaScript |

## Aufbau

```
index.html            Gerüst der Oberfläche
serve.mjs             lokaler Server (nur localhost): Dateien, Kachel-Cache, Höhendaten
serve.py              Ersatz ohne Node: nur Dateien, kein Cache
server/datastore.mjs  Platten-Cache: Kacheln, Archiv-Ebenen, HGT-Zellen
tools/MapCacheExport.java  einmaliger Export des alten Berkeley-DB-Kachel-Caches
src/core/             reine Logik, DOM-frei, in Node lauffähig
  xml.js              XML lesen/schreiben
  gpx.js              GPX 1.0/1.1 lesen, 1.1 schreiben, Dokumentmodell
  kml.js              KML-Import/-Export
  geo.js              Distanzen, Kurs, Bounding Box, Web-Mercator
  time.js             tolerantes Lesen von Zeitstempeln
  compare.js          Vergleich zweier Dokumente (neu / teilweise / enthalten / identisch)
  mvt.js              Vektorkacheln (Mapbox Vector Tile) dekodieren
  poster.js           Poster: Layouts, Kartenstile, Schriften, SVG-Erzeugung, Raster-Auflösung
  contours.js         Höhenlinien aus einem Höhenraster (Marching Squares)
  grid.js             Koordinatengitter (Gradnetz bzw. UTM-Gitter je Zone) und Eckkoordinaten
  hgt.js              SRTM-.hgt lesen (SRTM3 und SRTM1), bilineare Höhe
  simplify.js         Track-Optimierung (RDP-Gewichte, 5 Modi)
  repair.js           Duplikate, Lücken-Split, Verkehrsmittel-Split
  stats.js            Länge, Dauer, Auf-/Abstieg (mit Hysterese)
  ops.js              Merge, Extrakt, Umkehren, Teilen, Track↔Route
  coords.js           Koordinaten lesen/formatieren (DD, DMM, DMS, UTM, MGRS, Maidenhead, OLC)
  printlayout.js      Seiteneinpassung, Mehrseiten-Layout, Maßstab
  tilesources.js      Katalog freier Kartenquellen, URL-Vorlagen
src/services/         fetch-Aufrufe: osrm.js, nominatim.js, elevation.js (URL-Bau und Antwort-Parsing getrennt testbar)
src/ui/               Browser-Oberfläche
  store.js            Arbeitsbereich (offene Dateien, aktive/Arbeits-Datei, temporär), Undo/Redo über Dateien, Einstellungen
  mapview.js          Kachelkarte, Navigation, statisches Rendern für den Druck
  overlay.js          Vektor-Darstellung des Dokuments (Bildschirm und Druck)
  editor.js           Gesten: wählen, ziehen, einfügen, löschen, zeichnen
  sidebar.js          Baum und Eigenschaften
  profile.js          Höhenprofil
  actions.js          Befehle und Dialoge (Optimieren, Reparieren, Einstellungen …)
  print.js            Druckdialog, Vorschau, Seitenaufbau
  poster.js           Poster-Dialog, Vorschau, SVG-/PNG-Export
  app.js              Verdrahtung: Werkzeugleiste, Dateien, Suche, Tastatur
cli/gpxtool.mjs       Kommandozeile auf Basis von src/core
test/                 node:test – Kern, Algorithmen, UI-Rauchtest mit DOM-Attrappe
```

Abhängigkeitsrichtung: `ui → services → core`, nie umgekehrt. Kernfunktionen verändern ihre Argumente nicht; die UI ändert das Dokument ausschließlich über `store.mutate()`, das vorher einen Undo-Schnappschuss ablegt.

## Abbildung Alt → Neu

| Altsystem | Neu |
|---|---|
| JAXB-Klassen `util/imp/gpx/*`, `GPXWrapper` | `core/gpx.js` |
| `KmlPoiParser`, `KmlTrackParser`, `KMLExporter` | `core/kml.js` |
| `TrackOptimizerDialog` + `gpstools/TrackShrink`, `tools/gpx_optimizer*.py` | `core/simplify.js`, Dialog in `ui/actions.js` |
| `tools/gpx_repair.py` | `core/repair.js` |
| `MergeGPXDialog` | „Vergleichen“ + „Neue übernehmen“/„Alles“ (`ops.transferItems`, `core/compare.js`); CLI `merge` |
| `PDFReport`, `TileCalc`, JasperReports, iText | `core/printlayout.js`, `ui/print.js` (Browserdruck/PDF) |
| MOBAC-Kartenquellen (`mobac/mapsources`) | `core/tilesources.js` (nur noch frei nutzbare, funktionierende Quellen) |
| `OsrmRouting`, `RoutingBuilderDialog` | `services/osrm.js`, „Route berechnen“ |
| `SearchLocationDialog`, Nominatim/Geonames | `services/nominatim.js`, Suchfeld |
| `GoToWaypointDialog`, `ParseLatLon`, `CoordinateConversion`, `Maidenhead`, OLC | `core/coords.js` – ein gemeinsamer Parser für alle Eingabefelder |
| `SrtmHandler`, `ChartCreator` (JFreeChart) | `services/elevation.js`, `ui/profile.js` |
| Berkeley-DB-Kachelcache (`MapCache\db-*`) | `MapCache\tiles\<store>\z\x\y` über `serve.mjs`; Altbestand per `tools/MapCacheExport.java` |
| `SrtmHandler` (`MapCache\hgtCacheDirectory`) | dieselben `.hgt`-Dateien, gelesen von `core/hgt.js` |
| GPS/NMEA/RXTX, Diashow, WorldWind-3D, SUA/OpenAir, Wetter, IGC/OLC, Wikipedia/Overpass-POI | nicht portiert |

## Validierung

Automatisiert (`node --test`, 79 Tests):

- **GPX/KML**: alle vier GPX-Beispieldateien und die KML-Datei des Altprojekts werden gelesen; Schreiben → Lesen ergibt dasselbe Dokument, zweites Schreiben ist byte-identisch; Extensions, Farben und Schema-Reihenfolge geprüft.
- **Optimierung**: RDP-Garantie (maximale Abweichung ≤ Toleranz) mit unabhängiger sphärischer Abstandsrechnung auf einem echten Track nachgemessen; Monotonie, exakte Zielzahlen, 200 000 Punkte in < 5 s. Gegenprobe mit dem alten Python-Werkzeug auf `sample.gpx`: identische Punktanzahl in allen Modi (70/70, 25/25, 158/158), 94–95 % identische Punkte – die Abweichung kommt daher, dass hier der Abstand zur *Strecke* statt zur unendlichen Geraden gemessen wird.
- **Koordinaten**: UTM gegen veröffentlichten Referenzwert (CN Tower, < 1,5 m), OLC gegen den Referenzcode der Spezifikation, MGRS-100-km-Felder für bekannte Orte, Hin- und Rückrechnung über ein weltweites Raster (> 2000 Punkte) für UTM, MGRS, Maidenhead, OLC; 23 Eingabevarianten und 11 abzulehnende Eingaben.
- **Drucklayout**: alle Punkte liegen auf ihrer Seite, Format wird passend gewählt, Seite wird ausgefüllt, Maßstab stimmt (190 mm bei 1:50 000 = 9,5 km), Mehrseiten-Layout lückenlos.
- **Lokaler Server** (gegen einen nachgebildeten Kachel-/Höhenserver): Download → Platte → zweiter Abruf ohne Netz, gleichzeitige Anfragen teilen einen Download, veraltete Kacheln überbrücken Ausfälle, `--offline` lädt nie, kein offener Proxy, keine Pfadtricks, fremde Webseiten abgewiesen, Archiv-Ebenen nur von der Platte, HGT aus `hgtCacheDirectory`, `SRTM\…\*.hgt.zip` und Nachladen, Meeresflächen werden gemerkt.
- **Mit den echten Altdaten** (nur lesend): `MapCacheExport.java` gegen Kopien der Stores `Mapnik`, `Custom OSM Mapnik` (PNG) und `ArcGISSatellite` (JPEG): 18 313 Kacheln, alle gültig, erneuter Lauf überspringt vorhandene; eine exportierte Kachel wird vom Server ohne Download ausgeliefert. Höhen aus den vorhandenen Zellen: Innsbruck 581 m, Hafelekar-Grat 2290 m, Berlin 39 m. Ein Offline-Lauf auf dem echten Datenordner hat nichts geschrieben.
- **Vergleich/Übernahme**: konstruierte Fälle (identisch, 8 m versetzt neu aufgezeichnet, halbe Strecke gemeinsam – Abdeckung auf 3 % genau, fremd), Altdateien gegeneinander, 200 km gegen 200 km; Übernahme mit neuer ID und `<src>`, Verschieben, Unveränderlichkeit der Eingaben, `<src>` übersteht Speichern.
- **Koordinatengitter**: runde Schrittweiten je Format, jeder Punkt einer UTM-Linie liegt auf 5 cm genau auf dem beschrifteten Wert, Zonengrenze, Südhalbkugel, Äquator, Rückfall auf Gradnetz.
- **Poster**: Vektorkachel-Decoder gegen die Beispiele der Spezifikation und gegen einen unabhängig geschriebenen Encoder; Layout (Route im Rahmen, zentriert, Maßstab und Maßstabsleiste auf 1 % genau, Kachelabdeckung); Kartenelemente landen an der richtigen Stelle (Ort auf dem Routenstart, See darum), Ebenen-Reihenfolge, Filter, Beschriftungskollision; SVG ist gültiges XML. Ein erzeugtes Poster wurde mit einem SVG-Renderer gerendert und angesehen – mit künstlichen Kartendaten.
- **Oberfläche**: Rauchtest gegen eine DOM-Attrappe (`test/helpers/fakedom.mjs`), die das echte `index.html` lädt: Erkennung des lokalen Servers (Kacheln über den Cache, Archiv-Ebene), Start, Datei-Drop, Vergleichsdateien, „Neue übernehmen“/„Alles“, Auswahl und Verschieben über Dateigrenzen samt Undo, Auswahl, Punkt ziehen/einfügen/löschen, Undo, Werkzeuge, Optimierer, Reparatur, Suche, Speichern, Druckvorschau, Kontextmenü, Einstellungen.

Nicht automatisiert geprüft (siehe „Offene Punkte“):

- Darstellung in einem echten Browser (Layout/CSS, tatsächliches Kachelbild, Druckausgabe auf Papier/PDF).
- Antworten der Live-Dienste (Kachelserver, OSRM, Nominatim, Open-Meteo, AWS-Höhenzellen) – die Entwicklungsumgebung hatte keinen Netzzugang; getestet sind URL-Bau und das Parsen dokumentierter Antwortformate. Insbesondere die Adresse der AWS-Höhenzellen ist ungeprüft (änderbar mit `--hgt-url`).
- Topo-Poster: der Abruf fehlender Höhenzellen und das Bild echter Höhenlinien (Glättung, Dichte) sind ungeprüft; ebenso die Rasterkarte mit echten Kacheln.
- Poster mit echten OpenFreeMap-Kacheln: Abruf, Dekodierung realer Kacheln und das tatsächliche Kartenbild (Dichte von Straßen und Ortsnamen je Detailstufe, Farbwirkung der Stile) sind ungeprüft.
- Export der großen Stores (My Topo 11 GB, Iskort 6,6 GB …) – nur an den kleineren Stores gemessen.
- Der Java-Altcode für UTM/MGRS konnte nicht als Gegenprobe laufen (kein `javac` verfügbar).

## Bekannte Grenzen

- Kein Kartenumbruch an der Datumsgrenze (Tracks über ±180° werden nicht umgebrochen gezeichnet).
- UTM/MGRS nur WGS84 (NAD27 des Altsystems entfällt), gültig 80° S – 84° N.
- Der UTM-Buchstabe wird als Breitenband gelesen (`33U`), nicht als N/S-Hemisphäre.
- Undo hält 40 Schnappschüsse des ganzen Dokuments; bei sehr großen Dokumenten (> 500 000 Punkte) speicherintensiv.
- Sitzungswiederherstellung (localStorage) nur bis 40 000 Punkte über alle offenen Dateien.
- Platten-Cache nur mit `serve.mjs` (Node), nicht mit `serve.py` oder einem fremden Webserver.
- Eigene Kartenquellen (Einstellungen) laufen am Cache vorbei direkt zum Server – der lokale Server lädt bewusst nur Katalogquellen.
- Der Cache wird nicht automatisch verkleinert; `/api/usage` zeigt den Platzbedarf je Quelle.
- Gecachte Kacheln aus Google-/Microsoft-Stores der Java-Version sind als Archiv sichtbar, aber nur für den eigenen Gebrauch gedacht; Yandex nutzt eine andere Projektion und liegt verschoben.
- PNG-Export funktioniert nur mit Kartenquellen, die CORS erlauben; Drucken geht immer.
- Poster: Höhenlinien nur mit `serve.mjs` und bis ca. 2,5° Kartenausdehnung; Wanderwege erst ab Kartendaten-Zoom 11 (kleinere Gebiete bzw. „Kartendetail: Fein“); Höhenlinien sind nicht beschriftet.
- Poster: Schrift wird im SVG nicht eingebettet (das öffnende Programm setzt Helvetica/Arial o. ä.); Vektordaten enden bei Zoom 14, sehr kleine Gebiete auf großem Papier wirken daher grob; PNG ist auf die Canvas-Grenze des Browsers beschränkt (ca. 16 000 px Kantenlänge).
- Routing-Server begrenzen Stützpunkte; Routen werden in Abschnitten zu 25 Punkten angefragt.

## Offene Punkte / sinnvolle nächste Schritte

1. Einmaliger Durchlauf im echten Browser: Layout, Kacheln je Quelle, Druck A4/A3 hoch/quer, Mehrseitendruck.
2. Optional: Gebiet für unterwegs vorab in den Cache laden (Kacheln entlang einer Route bis Zoom N).
3. Optional: Ein-Datei-Variante (alles in ein HTML), falls ein Start ohne lokalen Server gewünscht ist.
4. Optional: automatisches Routing beim Zeichnen („Straßen folgen“), POI-Suche (Overpass).
