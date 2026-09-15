# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`strahlenschutz-cli` vorkommen. Das Fachgebiet ist das deutsche Messnetz zur
Strahlenüberwachung; dieses Glossar nennt neben dem deutschen Originalbegriff den in CLI/API
verwendeten Begriff (sofern es einen gibt).

> **Übersetzungstabelle.** Die CLI verwendet diese Entsprechungen:
>
> | Deutsch | Englisch / API-Begriff |
> | --- | --- |
> | Ortsdosisleistung (ODL) | ambient gamma dose rate |
> | Messstelle / Sonde | measurement station / probe |
> | Kennung (kenn) | station id |
> | Bundesamt für Strahlenschutz (BfS) | Federal Office for Radiation Protection |
> | Zeitreihe | time series |

---

## Das Messprogramm

**Strahlenschutz.** Das Politikfeld, dem diese API dient – die Überwachung der
Umweltradioaktivität zum Schutz der Bevölkerung.

**BfS – Bundesamt für Strahlenschutz.** Die Bundesbehörde, die das bundesweite Messnetz für die
Gamma-Ortsdosisleistung betreibt und dessen Messwerte als Open Data veröffentlicht.

**ODL-Info.** Das öffentliche Angebot des BfS ([`odlinfo.bfs.de`](https://odlinfo.bfs.de/)),
das die Daten zur Gamma-Ortsdosisleistung für die Öffentlichkeit aufbereitet; dahinter steht der
Open-Data-Endpoint, den dieses Tool einbindet.

**IMIS – Integriertes Mess- und Informationssystem.** Das System zur Überwachung der
Umweltradioaktivität in Deutschland. Der Open-Data-Dienst läuft unter `imis.bfs.de`.

---

## Was gemessen wird

**ODL – Ortsdosisleistung.** Die Messgröße dieses Messnetzes: die Dosisleistung der
Gammastrahlung an einem Ort, also wie viel ionisierende Gammastrahlung pro Zeiteinheit vorhanden
ist. Angegeben je Messstelle.

**µSv/h (Mikrosievert pro Stunde).** Die Einheit, in der die Gamma-Ortsdosisleistung angegeben
wird. Das Sievert (Sv) ist die SI-Einheit der Äquivalentdosis; bei normaler Untergrundstrahlung
liegen die Messwerte bei einem Bruchteil eines Mikrosieverts pro Stunde.

**Messwert.** Ein einzelner ODL-Wert einer Messstelle zu einem Zeitpunkt, enthalten in den
`properties` eines GeoJSON-Features.

---

## Messstellen & Geografie

**Messstelle / Sonde.** Ein fest installierter Sensor im Messnetz des BfS, der die
Gamma-Ortsdosisleistung vor Ort misst. Rund 1.700 Sonden decken Deutschland ab.

**kenn (Messstellen-ID).** Die Kennung der Messstelle. Eine **numerische** Zeichenkette mit
festem Format (nur Ziffern), z. B. `091811461`. Der Client prüft das Format (nur Ziffern, nicht
leer), bevor er sie in den WFS-`CQL_FILTER` einsetzt (`kenn='<id>'`). CLI:
`station <kenn>`, `--station <kenn>`, `timeseries <kenn>`.

**GeoJSON-Feature.** Ein Element der Antwort: eine Messstelle mit ihrem Messwert, mit einer
`geometry` (meist ein Point mit `[lon, lat]`-Koordinaten) und einem `properties`-Objekt, das die
Metadaten der Messstelle und den ODL-Wert enthält.

**FeatureCollection.** Eine WFS-`GetFeature`-Antwort als GeoJSON: eine Hülle
`type: "FeatureCollection"` mit einem Array `features`, dazu optional die Felder
`totalFeatures`, `numberReturned` und `timeStamp`.

---

## Feature-Arten (Ressourcen)

Der Dienst veröffentlicht drei WFS-Feature-Typen, die Client und CLI als verständliche
„Feature-Arten“ bereitstellen und ihrem WFS-`typeName` zuordnen:

**latest.** Der jeweils neueste ODL-Messwert je Messstelle.
WFS-`typeName`: `opendata:odlinfo_odl_1h_latest`. CLI: `latest`, `station`.

**ts-1h (stündliche Zeitreihe).** Die ODL-Zeitreihe einer Messstelle aus Stundenmittelwerten.
WFS-`typeName`: `opendata:odlinfo_timeseries_odl_1h`. CLI:
`timeseries --resolution ts-1h` (Standard).

**ts-24h (tägliche Zeitreihe).** Die ODL-Zeitreihe einer Messstelle aus Tagesmittelwerten.
WFS-`typeName`: `opendata:odlinfo_timeseries_odl_24h`. CLI:
`timeseries --resolution ts-24h`.

Diese Werte bilden das const-Array `FeatureKindValues`; die Map `TYPE_NAMES` (beide exportiert)
übersetzt jede Feature-Art in ihren WFS-`typeName`.

---

## Die WFS-Schnittstelle

**WFS – Web Feature Service.** Der OGC-Standard, den der Open-Data-Endpoint des BfS spricht
(Version **2.0**). Der Client setzt die immer gleichen Standardparameter selbst, sodass Aufrufer
sie nie von Hand angeben müssen.

**OGC – Open Geospatial Consortium.** Das Standardisierungsgremium hinter WFS. (GeoJSON ist
kein OGC-Standard, sondern von der IETF in RFC 7946 festgelegt.)

**ows-Endpoint.** Der einzige Dienstpfad, den der Client anspricht:
`/ogc/opendata/ows` auf `https://www.imis.bfs.de`.

**GetFeature.** Die WFS-Operation, die Features abruft. Der Client sendet bei jedem Aufruf die
festen Parameter `service=WFS`, `request=GetFeature` und
`outputFormat=application/json`.

**typeName.** Der WFS-Parameter, der den abzurufenden Feature-Typ benennt (z. B.
`opendata:odlinfo_odl_1h_latest`); er wird über `TYPE_NAMES` aus der gewählten Feature-Art
gesetzt.

**CQL_FILTER.** Der OGC-CQL-Filterausdruck, der serverseitig angewendet wird. Die Filterung nach
Messstelle wird als `CQL_FILTER=kenn='<id>'` ausgedrückt. (Die frühere Form `viewparams=kenn:<id>`
ignoriert dieser Server beim Typ `latest` stillschweigend, deshalb wird sie nicht verwendet.)

**count.** Der WFS-2.0-Parameter zur Begrenzung der Ergebnisanzahl (`--max` in der CLI). Das
`maxFeatures` aus WFS 1.x ignoriert dieser Server stillschweigend, deshalb sendet der Client
immer `count`.

**startIndex.** Der Paginierungs-Offset in WFS 2.0 (`--start` in der CLI). Er wird nur
zusammen mit einem `count` berücksichtigt; ein alleinstehender `startIndex` wird mit HTTP 400
abgelehnt, deshalb setzt der Client beim Blättern ohne ausdrückliches Limit eine
Standard-Seitengröße (`1000`).

**sortBy.** Der WFS-Parameter, der die Eigenschaft bestimmt, nach der sortiert wird; für
absteigende Reihenfolge hängen Sie ` D` an (mit Leerzeichen, z. B. `end_measure D`)
(CLI: `--sort <prop>`).

**outputFormat.** Fest auf `application/json` gesetzt, damit jede Antwort GeoJSON ist.

---

## Abfrageoptionen des Clients

**FeatureQuery.** Das Abfrageobjekt, das die Methoden des Clients entgegennehmen:
`station` (→ `CQL_FILTER=kenn='<id>'`), `sortBy`, `maxFeatures` (→ `count`) und
`startIndex`.

**maxFeatures (`--max`).** Höchstzahl der zurückzugebenden Features; wird als
WFS-2.0-Parameter `count` übertragen.

**startIndex (`--start`).** Offset für die Paginierung.

---

## Such- & API-Konzepte

**Leeres Ergebnis vs. nicht gefunden.** Der WFS liefert für eine unbekannte `kenn` eine leere
FeatureCollection mit HTTP **200**, nie einen 404. Bei der Abfrage einer einzelnen Messstelle
wertet die CLI „keine Features“ als nicht gefunden und löst `StrahlNotFoundError` aus, der auf
den Exit-Code **4** abgebildet wird.

**Rate Limiting / vorübergehende Fehler.** Die Status **429** und **503** gelten als
vorübergehend und werden automatisch mit linearem Backoff wiederholt (`--max-retries`,
`StrahlApiError.isRetryable`).

**Entfernen von Zugangsdaten beim Wechsel des Origins.** Bei einer Weiterleitung auf einen anderen
Origin entfernt die Engine Header mit Zugangsdaten (`Authorization`/`X-API-Key`/`Cookie`);
eine Weiterleitung mit Downgrade von `https`→`http` wird grundsätzlich abgelehnt.

**Nur lesend, keine Authentifizierung.** Der Open-Data-WFS von ODL-Info braucht keinen
Schlüssel; dieser Client stellt ausschließlich lesende `GET`-Anfragen.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `StrahlenschutzClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder, `FeatureKindValues`/`TYPE_NAMES`, die Validierung von `kenn` –
> stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)**.
