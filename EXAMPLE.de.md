# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `strahlenschutz`, eines pro Skill: eine
Anfrage, die `strahlenschutz`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `strahlenschutz` 0.0.6 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
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
ODL-Messnetz Deutschland: 1676 Messstellen, 1580 mit Messwert (83 defekt + 13 Testbetrieb ohne Wert, ausgelassen)
Ergebnis: alle Werte im Bereich der natürlichen Untergrundstrahlung (max. 0,231 µSv/h). Nichts erhöht.
Messwerte: 1492 Messstellen für die Stunde bis 2026-09-15T15:00Z, 77 für 14:00Z,
           11 älter (bis zurück 03:00Z).

Höchste aktuelle Ortsdosisleistung (µSv/h):
  0,231  Herrischried OT Großherrischwand  (083370490)  850 m  terrestrisch 0,177 + kosmisch 0,054
  0,204  Alpirsbach                        (082370020)  440 m  terrestrisch 0,156 + kosmisch 0,048
  0,203  Haidmühle                         (092721221)  833 m  terrestrisch 0,149 + kosmisch 0,054
  0,197  Gehlberg                          (160700171)  943 m  terrestrisch 0,141 + kosmisch 0,056
  0,196  Niedermurach - OT Pertolzhofen    (093761481)  405 m  (Stunde bis 14:00Z)
  … 1575 weitere
Niedrigste: 0,044 FINO 1 - Forschungsplattform (010020003), 0,05 FINO 2 - Forschungsplattform (010020004).
Die Spitzenwerte kommen von der Strahlung aus dem Boden (terrestrisch); der kosmische Anteil
liegt überall bei etwa 0,05 µSv/h. Ursache sind Geologie und Höhenlage vor Ort, keine Kontamination.
```

Als Nächstes angeboten: der stündliche Verlauf einer Messstelle (z. B. `timeseries 083370490`) oder eine GeoJSON-Karte.

## strahlenschutz-map

> Die aktuellen Messwerte der Ortsdosisleistung auf eine Karte bringen – als GeoJSON-Datei zum Hineinziehen in geojson.io.

```bash
strahlenschutz --compact latest | jq '{type: "FeatureCollection", features: [ .features[] | select(.properties.value != null) | {…kenn, name, plz, value, unit, site_status_text, end_measure, height_above_sea, popup} ]}' > odl.geojson
```

Eine `odl.geojson` gab es noch nicht, deshalb hat der Skill den Standardnamen ohne Rückfrage
verwendet. Er hat eine Heatmap-Ebene gebaut und dafür Messstellen ohne Wert weggelassen. Die
Koordinaten lagen schon als `[lon, lat]` vor und blieben unverändert.

```
odl.geojson geschrieben (779 KB): eine FeatureCollection mit 1580 Punkten.
  Weggelassen: 96 Messstellen mit value null (83 defekt, 13 Testbetrieb).
  Einfärben nach: value (µSv/h); Spanne in dieser Datei 0,044–0,231. Die Farbskala auf etwa
                  0,05–0,20 begrenzen, sonst sehen alle Punkte gleich aus.
  Eigenschaften: kenn, name, plz, value, unit, site_status_text, end_measure,
                 height_above_sea, popup („Diemelsee OT Adorf: 0.123 µSv/h")
  Prüfung: eine gültige FeatureCollection; alle Koordinaten und Werte numerisch;
           Länge 6,02–15,03, Breite 47,40–55,02 (EPSG:4326). Die API rundet Koordinaten auf 0,01°.
```

Als Nächstes angeboten: die Datei auf https://geojson.io öffnen oder eine Abdeckungskarte, die die 96 ausgefallenen Messstellen grau zeigt.

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
  aktuell: 0,231 µSv/h um 2026-09-15T15:00Z   (validiert)
  48 h:    0,227 – 0,237   Mittel 0,231
  Woche:   2026-09-08T16:00Z → 2026-09-15T15:00Z, Tagesmittel 0,227 – 0,232
           ein kurzer Anstieg: 0,264 um 2026-09-08T21:00Z, bis 23:00Z wieder bei 0,235
  Ergebnis: gleichbleibend, kein steigender Trend. Der Wert schwankt von Stunde zu Stunde um etwa
            0,01 µSv/h. Er liegt die ganze Woche knapp über dem üblichen Bereich von 0,05–0,20.
            Das ist das normale Niveau dieser Messstelle (850 m, überwiegend terrestrische
            Strahlung), keine Veränderung. Der Anstieg am 08.09. dauerte zwei Stunden – so ein
            kurzer Anstieg kann von Regen kommen.
```

Als Nächstes angeboten: eine CSV mit `end_measure,value` für ein Diagramm (zeitlich aufsteigend).
