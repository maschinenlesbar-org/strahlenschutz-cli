# Glossary

A reference for the domain concepts and project-specific terms used throughout
`strahlenschutz-cli`. The domain is the German radiation-monitoring network; this
glossary gives the term used in the CLI/API (where one exists) alongside the
original German.

> **Translation table.** The CLI follows these:
>
> | German | English / API term |
> | --- | --- |
> | Ortsdosisleistung (ODL) | ambient gamma dose rate |
> | Messstelle / Sonde | measurement station / probe |
> | Kennung (kenn) | station id |
> | Bundesamt für Strahlenschutz (BfS) | Federal Office for Radiation Protection |
> | Zeitreihe | time series |

---

## The monitoring programme

**Strahlenschutz.** "Radiation protection." The policy field this API serves —
monitoring environmental radioactivity to protect the population.

**BfS — Bundesamt für Strahlenschutz.** The German Federal Office for Radiation
Protection, the public authority that operates the national gamma dose-rate
monitoring network and publishes its readings as open data.

**ODL-Info.** The BfS public service ([`odlinfo.bfs.de`](https://odlinfo.bfs.de/))
that presents ambient gamma dose-rate data to the public, backed by the open-data
endpoint this tool wraps.

**IMIS — Integriertes Mess- und Informationssystem.** The "Integrated Measuring
and Information System" for monitoring environmental radioactivity in Germany. The
open-data service is hosted under `imis.bfs.de`.

---

## What is measured

**ODL — Ortsdosisleistung (ambient gamma dose rate).** The quantity this network
measures: the gamma radiation dose rate at a location, i.e. how much ionising
gamma radiation is present per unit time. Reported per measurement station.

**µSv/h (microsievert per hour).** The unit in which the ambient gamma dose rate
is reported. The sievert (Sv) is the SI unit of equivalent dose; readings are on
the order of a fraction of a microsievert per hour at normal background levels.

**Reading / measurement value.** A single ODL value for a station at a point in
time, carried in a GeoJSON feature's `properties`.

---

## Stations & geography

**Messstelle / Sonde (measurement station / probe).** A fixed sensor in the BfS
network that measures the local ambient gamma dose rate. Roughly 1 700 probes
cover Germany.

**kenn (station id).** The station identifier (Kennung). A fixed-format **numeric**
string (digits only), e.g. `091811461`. The client trims surrounding whitespace, then
validates the shape (digits only, non-empty) before splicing it into the WFS `CQL_FILTER` (`kenn='<id>'`), and checks that every
feature of the answer carries that `kenn` (a server that drops the filter is an error,
not another station's data). CLI: `station <kenn>`, `--station <kenn>`,
`timeseries <kenn>`.

**GeoJSON Feature.** One element of the response: a station together with its
reading, with a `geometry` (typically a Point with `[lon, lat]` coordinates) and a
`properties` object holding the station metadata and ODL value.

**FeatureCollection.** A WFS `GetFeature` response as GeoJSON: a `type:
"FeatureCollection"` envelope with a `features` array, plus optional
`totalFeatures`, `numberReturned` and `timeStamp` fields.

---

## Feature kinds (resources)

The service publishes three WFS feature types, surfaced by the client/CLI as
friendly "feature kinds" mapped to their WFS `typeName`:

**latest.** The most recent ODL reading per station.
WFS `typeName`: `opendata:odlinfo_odl_1h_latest`. CLI: `latest`, `station`.

**ts-1h (hourly time series).** The hourly-averaged ODL time series for a station.
WFS `typeName`: `opendata:odlinfo_timeseries_odl_1h`. CLI:
`timeseries --resolution ts-1h` (the default).

**ts-24h (daily time series).** The daily-averaged ODL time series for a station.
WFS `typeName`: `opendata:odlinfo_timeseries_odl_24h`. CLI:
`timeseries --resolution ts-24h`. The layer currently holds one station only,
Flensburg (`010010001`, about a year of daily values; checked 26 Sep 2026); every
other station returns an empty collection.

These values are the `FeatureKindValues` const array; the `TYPE_NAMES` map (both
exported) translates each friendly kind to its WFS `typeName`. The two time-series
kinds are also exported as `TimeseriesResolutionValues`. The library checks every
kind against these lists before any request: `getFeature()` rejects anything outside
`FeatureKindValues`, and `timeseries()` (CLI: `--resolution`) anything outside
`TimeseriesResolutionValues`, `latest` included, with a `StrahlValidationError`.

---

## The WFS interface

**WFS — Web Feature Service.** The OGC standard the BfS open-data endpoint speaks
(version **2.0**). The client fixes the boilerplate parameters so callers never
set them by hand.

**OGC — Open Geospatial Consortium.** The standards body behind WFS. (GeoJSON is not an
OGC standard; it is specified by the IETF in RFC 7946.)

**ows endpoint.** The single service path the client targets:
`/ogc/opendata/ows` on `https://www.imis.bfs.de`.

**GetFeature.** The WFS operation that retrieves features. The client sends fixed
parameters `service=WFS`, `request=GetFeature` and
`outputFormat=application/json` on every call.

**typeName.** The WFS parameter naming the feature type to fetch (e.g.
`opendata:odlinfo_odl_1h_latest`); set from the chosen feature kind via
`TYPE_NAMES`.

**CQL_FILTER.** The OGC CQL filter expression applied server-side. Filtering by
station is expressed as `CQL_FILTER=kenn='<id>'`. (The earlier `viewparams=kenn:<id>`
form is silently ignored by this server on the `latest` type, so it is not used.)

**count.** The WFS 2.0 result-limit parameter (the CLI's `--max`). The WFS 1.x
`maxFeatures` is silently ignored by this server, so the client always sends
`count`.

**startIndex.** The WFS 2.0 paging offset (the CLI's `--start`). The BfS layers
have no primary key, so the server can only page a **sorted** result: a
`startIndex` without a `sortBy` is rejected with HTTP 400 ("Cannot do natural order
without a primary key"). The client therefore always sends a `sortBy` (see below).
Without a `count` (`--max`), the server returns everything from the offset on.

**sortBy.** The WFS parameter selecting the property to sort results by; append
` D` (a space, e.g. `end_measure D`) for descending order, and separate several
keys with commas (`end_measure D,kenn`) (CLI: `--sort <prop>`). Without `--sort`
the client sorts by `kenn` (`latest`) or `kenn,end_measure` (time series, i.e.
oldest first) — the `DEFAULT_SORT_BY` map — so every query can be paged. A blank
sort (`""` or whitespace) is rejected before any request, by the CLI and the library
alike, since it would replace that default. The direction must be `D`/`DESC`
(descending) or `A`/`ASC` (ascending), in any case: the WFS reads any other token
(`DSC`, a typo) as ascending with no error, so the client rejects it; whitespace is
normalised before sending (`"end_measure  D"`, with two spaces, also read as
ascending upstream, goes out as `end_measure D`).

**outputFormat.** Fixed to `application/json` so every response is GeoJSON.

**ExceptionReport.** The OGC XML document the WFS answers a bad request with
(usually HTTP 400, for some errors HTTP 200), e.g. for an unknown `--sort`
property. The CLI shows its `ExceptionText` after the status:
`Error: HTTP 400 for GET …: Illegal property name: bogus_prop for feature type …`
(exit `1`); a `200` one reads `WFS exception (HTTP 200) for GET …`.

---

## Client query options

**FeatureQuery.** The query object accepted by the client's methods:
`station` (→ `CQL_FILTER=kenn='<id>'`), `sortBy`, `maxFeatures` (→ `count`) and
`startIndex`.

**maxFeatures (`--max`).** Maximum number of features to return; sent on the wire
as the WFS 2.0 `count` parameter.

**startIndex (`--start`).** Offset for paging.

---

## Search & API concepts

**Empty result vs. not-found.** The WFS returns an empty FeatureCollection with
HTTP **200** for an unknown `kenn`, never a 404. For a single-station lookup
(`station <kenn>`) the client's `station()` treats "no features" as not-found and
raises `StrahlNotFoundError` (exported), which the CLI maps to exit code **4**. `timeseries <kenn>` and
`latest --station <kenn>` pass the empty collection through with exit **0**: a real
station can have an empty series as well (a `defekt` station, or `ts-24h`), so an
empty result there doesn't prove the id is unknown.

**Rate limiting / transient errors.** Statuses **429** and **503** are treated as
transient and retried automatically (`--max-retries`, or the library's `maxRetries`:
`0`–`10`, the exported `MAX_RETRIES`, default `2`; `StrahlApiError.isRetryable`). Each retry backs off linearly (200 ms, 400 ms, …),
or waits longer when the server's `Retry-After` (seconds or an HTTP date) asks for it;
`Retry-After: 0` or a past date never shortens the wait. A `Retry-After` above 30 s is
not retried: the error is reported at once and names the requested wait. A reset
connection is retried the same way (linear backoff); a timeout is not.

**Cross-origin credential strip.** On a redirect to a different origin, the engine
drops credential-bearing headers (`Authorization`/`X-API-Key`/`Cookie`); an
`https`→`http` downgrade redirect is refused outright. A same-origin redirect (relative
or absolute `Location`) keeps them. A base URL's `user:pw@` is sent as that
`Authorization` header, never inside the URL, and a `Location`'s own userinfo is
ignored.

**Read-only, no auth.** The ODL-Info open-data WFS needs no key; this client only
issues read-only `GET` requests.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `StrahlenschutzClient`, the request engine, transport, retry/backoff, error
> types, query builder, `FeatureKindValues`/`TYPE_NAMES`, `kenn` validation —
> now live in **[DEVELOPING.md](DEVELOPING.md)**.
