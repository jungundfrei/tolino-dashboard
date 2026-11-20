# Tolino-Dashboard «Zürich auf einen Blick»

Touch-Dashboard für den Tolino Shine 3 (Fully Kiosk Browser 1.44.1) mit vier Tabs:

- **Heute:** Uhr, Wetter mit Schirm-/Mütze-Hinweis, nächste 4 Tage, nächster Termin, Netatmo, Abfuhr, Feiertag, Mond
- **Termine:** Familienkalender der nächsten 30 Tage, nach Tagen gruppiert
- **ÖV:** Abfahrten ab Bahnhof Wiedikon (S-Bahn und Tram/Bus) mit Minuten-Countdown; per Knopf umschaltbar auf die nächsten Verbindungen zum Flughafen ab Höfliweg, Goldbrunnenplatz und Binz
- **Sport:** umschaltbar zwischen Formel 1 (nächster GP mit allen Sessions, Strecke, letztes Podium, Fahrer-WM) und FC Bayern (nächstes/letztes Spiel, Tabelle, Topskorer, Champions League). Die Daten kommen aus Kopien der TRMNL-Skripte in `sport/`, F1 alle 2 Std., Bayern stündlich.
- **Advent** (vom 1. Advent bis 26. Dezember): Adventskranz, an jedem Adventssonntag brennt eine Kerze mehr, dazu 24 Türchen mit je einem Weihnachtsbild. Das Türchen des Tages ist offen, frühere lassen sich antippen und nochmals anschauen.

Die Tabs sind standardmässig links. Für Tabs unten die Seite einmal mit `#k=…&nav=unten` öffnen (zurück mit `&nav=seite`); der Tolino merkt sich die Wahl.

Längere Listen werden mit ‹ › geblättert statt gescrollt (schont das E-Ink). Ein zweites Tippen auf den Tab springt zurück zur ersten Seite.

## So funktioniert es

1. **GitHub Actions** holt alle 15 Minuten die Daten. Die Logik ist dieselbe wie im TRMNL-Plugin (`build/serverless.js` ist eine Kopie davon), dazu kommen ÖV und mehr News.
2. Die Daten landen per **SFTP auf deinem cyon-Webspace**, zusammen mit der Seite `index.html`. Im GitHub-Repo selbst liegen keine Daten.
3. Der **Tolino** zeigt die Seite in Fully Kiosk an, lädt die Daten alle 5 Minuten neu und zählt die ÖV-Minuten selbst herunter.

Die Daten liegen auf dem Server in einem Ordner mit geheimem Namen (`DASHBOARD_KEY`). Nur wer diesen Namen kennt, kann den Kalender sehen. Ordner-Listing und Suchmaschinen sind gesperrt (`.htaccess`).

## Einrichten

### 1. GitHub-Repo

1. Neues Repo **tolino-dashboard** anlegen. **Öffentlich** ist am einfachsten: Es enthält nur Code, keine Daten. Bei privaten Repos reichen die Gratis-Minuten von GitHub für einen 15-Minuten-Takt nicht ganz.
2. Alle Dateien aus diesem Ordner hochladen, inklusive `.github/workflows/dashboard.yml`.

### 2. Secrets eintragen

Im Repo unter **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Inhalt |
|---|---|
| `DASHBOARD_KEY` | geheimer Ordnername, z. B. `Q9gBaIQIuVgMgaef6R65tcBG` (nur Buchstaben/Ziffern, mind. 16 Zeichen) |
| `KALENDER_1` | dieselbe «Privatadresse im iCal-Format» wie beim TRMNL |
| `SFTP_HOST` | Server von cyon, siehe my.cyon (z. B. `s123.cyon.net` oder deine Domain) |
| `SFTP_USER` | SSH/SFTP-Benutzer aus my.cyon |
| `SFTP_PASSWORD` | Passwort dieses Benutzers |
| `SFTP_PFAD` | Zielordner, z. B. `public_html/tolino` (der Ordner wird angelegt) |

Optional:

- `FOOTBALL_DATA_TOKEN`: derselbe Token von football-data.org wie beim FC-Bayern-Plugin (ohne ihn bleibt die Bayern-Seite leer)

- `KALENDER_2`: ein zweiter Kalender
- `NETATMO_CLIENT_ID`, `NETATMO_CLIENT_SECRET`, `NETATMO_REFRESH_TOKEN`: **Wichtig: eine eigene, zweite Netatmo-App** auf dev.netatmo.com anlegen, nicht die vom TRMNL verwenden. Netatmo tauscht den Token bei jeder Erneuerung aus. Würden TRMNL und Tolino dieselbe App nutzen, würden sie sich gegenseitig abmelden. Token erzeugen wie in der TRMNL-Anleitung (Scope `read_station`, Refresh Token kopieren).

Unter **Variables** (gleiche Seite, Reiter «Variables») kannst du optional ändern: `PLZ` (Standard 8055), `ORT` (Zürich), `NEWS_FEED` (SRF), `OEV_STATIONEN` (Standard `Zürich Wiedikon;Zürich, Bahnhof Wiedikon`, mehrere mit Strichpunkt).

Für die Verbindungen zum Flughafen (ÖV-Tab, Knopf «✈ Flughafen»): `ROUTE_VON` (Standard `Zürich, Höfliweg;Zürich, Goldbrunnenplatz;Zürich, Binz`, mehrere mit Strichpunkt) und `ROUTE_NACH` (Standard `Zürich Flughafen`). Die Verbindungen aller Start-Haltestellen werden gemischt und nach Abfahrt sortiert. Optional lässt sich der Fussweg in Minuten anhängen, z. B. `Zürich, Binz=7`. Dann zeigt die Minutenzahl rechts, wann du zu Hause losgehen musst.

### 3. Ersten Lauf starten

**Actions → Tolino-Dashboard → Run workflow.** Im Log unter «Daten holen» steht am Ende z. B. `data.json geschrieben (25.3 KB). Fehler: keine`. Danach im Browser am PC testen:

`https://deine-domain.ch/tolino/#k=DEIN_DASHBOARD_KEY`

### 4. Tolino einrichten (Fully Kiosk)

1. In Fully von links nach rechts wischen → **Settings → Web Content Settings → Start URL**: die Adresse von oben, mit `#k=…` am Ende. Danach merkt sich die Seite den Schlüssel.
2. **Lädt die Seite nicht** (Zertifikatsfehler): Android 4.4 kennt neuere Let's-Encrypt-Zertifikate nicht. Dann in den Web-Content-Einstellungen **«Ignore SSL Errors»** einschalten.
3. Unter **Device Management** (o. ä.): **Keep Screen On** an, **Launch on Boot** an.
   Für **Querformat** dort **Screen Orientation** (bzw. «Force Screen Orientation») auf **Landscape** stellen. Die Seite passt sich automatisch an: Im Querformat ist «Heute» zweispaltig und zeigt zusätzlich die drei folgenden Termine.
4. Den Tolino **dauerhaft am Strom** lassen. Mit WLAN und Bildschirm an hält der Akku nur kurz.

## Gut zu wissen

- **ÖV live:** Die Seite versucht, die Abfahrten direkt bei transport.opendata.ch zu holen («live» oben rechts). Klappt das auf dem alten Tolino nicht, nimmt sie den Fahrplan aus GitHub («Fahrplan · Stand …»). Verspätungen sind dann bis zu 15 Minuten alt.
- **Fusszeile:** «Stand» zeigt, wann GitHub die Daten zuletzt geholt hat. Sind sie älter als 45 Minuten, steht dort ein Hinweis. «Quelle(n) gestört» heisst: eine Quelle hat nicht geantwortet, Details im Actions-Log.
- **GitHub pausiert geplante Workflows** in öffentlichen Repos nach 60 Tagen ohne Commit. Du bekommst vorher eine E-Mail. Dann unter Actions einfach wieder «Enable workflow» klicken oder eine kleine Änderung committen.
- **Schlüssel wechseln:** neuen `DASHBOARD_KEY` setzen, Workflow laufen lassen, auf dem Server den alten Ordner löschen und auf dem Tolino die Start-URL mit dem neuen `#k=` öffnen.

## Dateien

- `index.html`: die Dashboard-Seite (ES5, läuft im alten Android-Browser)
- `build/build.js`: holt die Daten und schreibt `_site/<KEY>/data.json`
- `build/serverless.js`: Kopie der TRMNL-Datenlogik (30 Tage Termine, 12 News)
- `.github/workflows/dashboard.yml`: Zeitplan und Upload per SFTP
