# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `strahlenschutz`, eines pro Skill: eine
Anfrage, die `strahlenschutz`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 (gegen 00:00 UTC) mit `strahlenschutz` 0.3.0 gegen die
Live-API. Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [strahlenschutz-dose-snapshot](#strahlenschutz-dose-snapshot) · [strahlenschutz-map](#strahlenschutz-map) · [strahlenschutz-station-trend](#strahlenschutz-station-trend)

## strahlenschutz-dose-snapshot

> Wie hoch ist die Strahlung in Deutschland gerade? Liegt irgendeine Messstelle über dem natürlichen Untergrund?

```bash
strahlenschutz --compact latest
strahlenschutz --compact latest --sort "value D" --max 3     # Server-Sortierung: 3 defekte Messstellen mit value null zuerst
```

Der Skill hat die Messstellen selbst sortiert und nicht die Server-Sortierung verwendet, denn
die setzt ausgefallene Sonden an den Anfang. Nicht jeder „letzte" Messwert stammt aus derselben
Stunde, deshalb gibt der Überblick an, aus welchen Stunden die Werte stammen.

```
ODL-Messnetz Deutschland: 1677 Messstellen, 1589 mit Messwert (78 defekt + 10 Testbetrieb ohne Wert, ausgelassen)
Ergebnis: alle Werte im Bereich der natürlichen Untergrundstrahlung (max. 0,237 µSv/h). Nichts erhöht.
Messwerte: 1501 Messstellen für die Stunde bis 2026-10-05T23:00Z, 78 für 22:00Z,
           10 älter (bis zurück 2026-10-04T01:00Z: Rheinmünster OT Greffern, 082160630).

Höchste aktuelle Ortsdosisleistung (µSv/h), alle für die Stunde bis 23:00Z:
  0,237  Herrischried OT Großherrischwand  (083370490)  850 m  terrestrisch 0,183 + kosmisch 0,054
  0,218  Haidmühle                         (092721221)  833 m  terrestrisch 0,164 + kosmisch 0,054
  0,217  Niedermurach - OT Pertolzhofen    (093761481)  405 m  terrestrisch 0,169 + kosmisch 0,048
  0,209  Bernhardswald                     (093751192)  454 m  terrestrisch 0,161 + kosmisch 0,048
  0,207  Alpirsbach                        (082370020)  440 m  terrestrisch 0,159 + kosmisch 0,048
  … 1584 weitere
Niedrigste: 0,045 FINO 1 - Forschungsplattform (010020003), 0,054 FINO 2 - Forschungsplattform (010020004).
Die Spitzenwerte kommen von der Strahlung aus dem Boden (terrestrisch); der kosmische Anteil
liegt überall bei etwa 0,05 µSv/h. Ursache sind Geologie und Höhenlage vor Ort, keine Kontamination.
```

Als Nächstes angeboten: der stündliche Verlauf einer Messstelle (z. B. `timeseries 083370490`) oder eine GeoJSON-Karte.

## strahlenschutz-map

> Die aktuellen Messwerte der Ortsdosisleistung auf eine Karte bringen – als GeoJSON-Datei zum Hineinziehen in geojson.io.

```bash
strahlenschutz --compact latest | jq '{type: "FeatureCollection", features: [ .features[] | select(.properties.value != null) | select(.geometry.coordinates | …innerhalb Länge 5,5–15,5, Breite 47–55,5) | {…kenn, name, plz, value, unit, site_status_text, end_measure, height_above_sea, popup} ]}' > odl.geojson
strahlenschutz --compact latest | jq -r '.features[] | select(…außerhalb des Rahmens) | [kenn, name, site_status_text, coordinates] | @tsv'
```

Eine `odl.geojson` gab es noch nicht, deshalb hat der Skill den Standardnamen ohne Rückfrage
verwendet. Er hat eine Heatmap-Ebene gebaut und dafür Messstellen ohne Wert weggelassen. Die
Koordinaten blieben wie geliefert, aber der Skill hat sie nicht ungeprüft übernommen: Die
Rahmenprüfung fand eine Messstelle außerhalb Deutschlands.

```
odl.geojson geschrieben (783 KB): eine FeatureCollection mit 1589 Punkten.
  Weggelassen: 88 Messstellen mit value null (78 defekt, 10 Testbetrieb).
  Koordinaten: 1 Messstelle liegt außerhalb des Rahmens um Deutschland – Trollenhagen
               (130711451, defekt) bei [589.28, 3007.11], eine fehlerhafte Position in den
               BfS-Daten. Sie hat keinen Wert, die Heatmap hatte sie also schon weggelassen;
               eine Abdeckungskarte muss sie ebenfalls weglassen.
  Einfärben nach: value (µSv/h); Spanne in dieser Datei 0,045–0,237. Die Farbskala auf etwa
                  0,05–0,25 begrenzen, sonst sehen alle Punkte gleich aus.
  Eigenschaften: kenn, name, plz, value, unit, site_status_text, end_measure,
                 height_above_sea, popup („Schmalfeld: 0.076 µSv/h")
  Prüfung: eine gültige FeatureCollection; alle Koordinaten und Werte numerisch;
           Länge 6,02–15,03, Breite 47,40–55,02 (EPSG:4326). Die API rundet Koordinaten auf 0,01°.
```

Als Nächstes angeboten: die Datei auf https://geojson.io öffnen oder eine Abdeckungskarte, die die 88 ausgefallenen Messstellen grau zeigt (ohne Trollenhagen).

## strahlenschutz-station-trend

> Herrischried hat heute den höchsten Wert in Deutschland. Ist die Strahlung dort diese Woche gestiegen?

```bash
strahlenschutz --compact latest | jq -r '.features[] | [.properties.kenn, .properties.name, .properties.plz] | @tsv' | grep -i "herrischried"
strahlenschutz --compact timeseries 083370490 --sort "end_measure D" --max 48
strahlenschutz --compact timeseries 083370490                              # ganze Woche: 168 h, älteste zuerst
strahlenschutz --compact timeseries 083370490 --resolution ts-24h         # native Tagesreihe: 0 Features
```

„Herrischried" traf genau eine Messstelle, kenn `083370490` (PLZ 79737). Die native Tagesreihe war
leer, deshalb hat der Skill die Tagesmittel aus den Stundenwerten berechnet. Keiner der 168 Werte
war null.

```
Herrischried OT Großherrischwand (kenn 083370490), stündliche ODL-Messwerte
  aktuell: 0,237 µSv/h um 2026-10-05T23:00Z   (validiert)
  48 h:    0,232 – 0,241   Mittel 0,237
  Woche:   2026-09-29T00:00Z → 2026-10-05T23:00Z, Tagesmittel 0,233 – 0,243
           ein kurzer Anstieg: 0,265 um 2026-10-01T20:00Z (0,256 um 19:00Z, 0,257 um 21:00Z),
           bis 23:00Z wieder bei 0,239
  Ergebnis: gleichbleibend, kein steigender Trend. Die Tagesmittel lagen am Ende der Woche etwas
            niedriger (0,236–0,238) als am Anfang (0,242–0,243), und der Wert schwankt von Stunde
            zu Stunde um etwa 0,01 µSv/h. Er liegt die ganze Woche am oberen Rand des im Messnetz
            üblichen Bereichs von 0,05–0,25. Das ist das normale Niveau dieser Messstelle (850 m,
            überwiegend terrestrische Strahlung), keine Veränderung. Der Anstieg am 01.10. dauerte
            etwa drei Stunden – so ein kurzer Anstieg kann von Regen kommen.
```

Als Nächstes angeboten: eine CSV mit `end_measure,value` für ein Diagramm (zeitlich aufsteigend).
