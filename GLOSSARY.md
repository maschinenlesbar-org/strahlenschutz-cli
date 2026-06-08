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
string (digits only), e.g. `091811461`. The client validates the shape (digits
only, non-empty) before splicing it into the WFS `viewparams` filter. CLI:
`station <kenn>`, `--station <kenn>`, `timeseries <kenn>`.

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
`timeseries --resolution ts-24h`.

These values are the `FeatureKindValues` const array; the `TYPE_NAMES` map (both
exported) translates each friendly kind to its WFS `typeName`.

---

## The WFS interface

**WFS — Web Feature Service.** The OGC standard the BfS open-data endpoint speaks
(version **2.0**). The client fixes the boilerplate parameters so callers never
set them by hand.

**OGC — Open Geospatial Consortium.** The standards body behind WFS and GeoJSON.

**ows endpoint.** The single service path the client targets:
`/ogc/opendata/ows` on `https://www.imis.bfs.de`.

**GetFeature.** The WFS operation that retrieves features. The client sends fixed
parameters `service=WFS`, `request=GetFeature` and
`outputFormat=application/json` on every call.

**typeName.** The WFS parameter naming the feature type to fetch (e.g.
`opendata:odlinfo_odl_1h_latest`); set from the chosen feature kind via
`TYPE_NAMES`.

**viewparams.** A server-side templating parameter. Filtering by station is
expressed as `viewparams=kenn:<id>`.

**count.** The WFS 2.0 result-limit parameter (the CLI's `--max`). The WFS 1.x
`maxFeatures` is silently ignored by this server, so the client always sends
`count`.

**startIndex.** The WFS 2.0 paging offset (the CLI's `--start`). It is only
honoured when accompanied by a `count`; a bare `startIndex` is rejected with HTTP
400, so the client supplies a default page size (`1000`) when paging without an
explicit limit.

**sortBy.** The WFS parameter selecting the property to sort results by; append
`+D` for descending order (CLI: `--sort <prop>`).

**outputFormat.** Fixed to `application/json` so every response is GeoJSON.

---

## Client query options

**FeatureQuery.** The query object accepted by the client's methods:
`station` (→ `viewparams=kenn:<id>`), `sortBy`, `maxFeatures` (→ `count`) and
`startIndex`.

**maxFeatures (`--max`).** Maximum number of features to return; sent on the wire
as the WFS 2.0 `count` parameter.

**startIndex (`--start`).** Offset for paging.

---

## Search & API concepts

**Empty result vs. not-found.** The WFS returns an empty FeatureCollection with
HTTP **200** for an unknown `kenn`, never a 404. For a single-station lookup the
CLI treats "no features" as not-found and raises `StrahlNotFoundError`, mapping it
to exit code **4**.

**Rate limiting / transient errors.** Statuses **429** and **503** are treated as
transient and retried automatically with linear backoff (`--max-retries`,
`StrahlApiError.isRetryable`).

**Cross-origin credential strip.** On a redirect to a different origin, the engine
drops credential-bearing headers (`Authorization`/`X-API-Key`/`Cookie`); an
`https`→`http` downgrade redirect is refused outright.

**Read-only, no auth.** The ODL-Info open-data WFS needs no key; this client only
issues read-only `GET` requests.

---

## Project / technical terms

**API client.** [`StrahlenschutzClient`](src/client/client.ts) — the typed
wrapper over the WFS that hides the boilerplate and exposes the feature kinds as
methods. Usable as a library independently of the CLI.

**Methods.** `getFeature(kind, query)` (generic), `latest(query)`,
`station(kenn)` and `timeseries(kenn, resolution, query)`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, handles redirects, decodes JSON and
maps errors. Sits between the client's methods and the transport.

**Query-string builder.** [`query.ts`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, stringifies
booleans, ISO-formats `Date`, and encodes spaces as `%20`.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object. Lets the whole
CLI run in tests with a mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `StrahlApiError` (non-2xx,
carries `status`/`detail`/`isRetryable`), `StrahlNetworkError` (transport
failure/timeout), `StrahlParseError` (bad JSON) and `StrahlNotFoundError`
(synthesised for an unknown id) — all extending `StrahlError`. The CLI maps a
not-found/`404` to exit code `4`, other errors to `1`.
