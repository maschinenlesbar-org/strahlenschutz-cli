# Developing & integrating

This document covers `strahlenschutz-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`strahlenschutz`) and a typed WFS client
(`StrahlenschutzClient`) for the
[BfS ODL-Info](https://odlinfo.bfs.de/) open-data service
(`www.imis.bfs.de/ogc/opendata/ows`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed GeoJSON feature collection and the feature-kind enum.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the ODL-Info open-data WFS needs no key; this client only reads.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
strahlenschutz --help
```

## Library usage

```ts
import { StrahlenschutzClient, StrahlApiError } from "@maschinenlesbar.org/strahlenschutz-cli";

const client = new StrahlenschutzClient(); // defaults to https://www.imis.bfs.de

const latest = await client.latest({ maxFeatures: 5 }); // sent as WFS 2.0 `count`
const one = await client.station("091811461");
const series = await client.timeseries("091811461", "ts-24h");

try {
  await client.station("nope");
} catch (err) {
  if (err instanceof StrahlApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new StrahlenschutzClient({
  baseUrl: "https://www.imis.bfs.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 are retried with linear backoff
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Methods

`client.getFeature(kind, query)` (generic), `client.latest(query)`,
`client.station(kenn)`, `client.timeseries(kenn, resolution, query)`.
The `FeatureKindValues` enum and the `TYPE_NAMES` map are exported for reference.

## Architecture

```
src/
  client/
    enums.ts     # FeatureKind value set + TYPE_NAMES (friendly -> WFS typeName)
    types.ts     # GeoJSON Feature / FeatureCollection + query object
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects (with cross-origin credential strip), JSON decoding, error mapping
    errors.ts    # StrahlError / StrahlApiError / StrahlNetworkError / StrahlParseError
    client.ts    # StrahlenschutzClient — WFS GetFeature over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # latest / station / timeseries
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The CLI is built around injectable `CliDeps` (client factory + I/O), so the whole program can be
  driven in-process by tests with a mocked client and captured output — no subprocesses.
- The WFS boilerplate (`service=WFS`, `request=GetFeature`, `outputFormat=application/json`) is hidden
  behind friendly feature-kind methods; GeoJSON is returned faithfully.

## Technical terms

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
(synthesised for an unknown id) — all extending `StrahlError`. The CLI maps
`StrahlNotFoundError`/HTTP 404 to exit code `4`; all other errors map to `1`.

**Cross-origin credential strip.** On a redirect to a different origin, the
engine drops credential-bearing headers (`Authorization`/`X-API-Key`/`Cookie`);
an `https`→`http` downgrade redirect is refused outright.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically with linear backoff, up to `--max-retries`.
`StrahlApiError.isRetryable` is `true` for those two statuses.

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses.

**`kenn` validation.** The client validates the station id (digits only,
non-empty) before splicing it into the WFS `CQL_FILTER` (`kenn='<id>'`) and
rejects anything else with a clear error — defence in depth on top of the
percent-encoding the value already receives.

**Empty result vs. not-found.** The WFS returns an empty FeatureCollection with
HTTP **200** for an unknown `kenn`, never a 404. For a single-station lookup the
CLI treats "no features" as not-found and raises `StrahlNotFoundError`, mapping
it to exit code **4**.

**`FeatureKindValues` / `TYPE_NAMES`.** The const array of valid feature kinds
(`latest`, `ts-1h`, `ts-24h`) and the map that translates each to its WFS
`typeName` (e.g. `opendata:odlinfo_odl_1h_latest`).

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, and redirect handling (same-origin follow, cross-origin credential strip, https→http downgrade refusal, missing-Location, too-many-redirects) — mocked transport.
- **`client.test.ts`** — the fixed WFS params, typeName selection, `CQL_FILTER` mapping and encoding, `sortBy`/`startIndex` propagation, and `kenn` validation — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, validation and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
