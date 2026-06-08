# strahlenschutz-cli

A TypeScript **API client** and **command-line interface** for the open
[BfS ODL-Info](https://odlinfo.bfs.de/) open-data WFS (`imis.bfs.de`) operated by
the **Bundesamt für Strahlenschutz** — Germany's **ambient gamma dose-rate (ODL)**
measurement network: latest readings and hourly/daily time series, as GeoJSON.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed GeoJSON feature collection and the feature-kind enum.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the ODL-Info open-data WFS needs no key; this client only reads.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
strahlenschutz --help
```

---

## How the API works

The service is an OGC **WFS**. This client fixes the boilerplate parameters
(`service=WFS`, `request=GetFeature`, `outputFormat=application/json`) and exposes
the three published feature types as friendly commands. Every response is a
**GeoJSON FeatureCollection**; a station is identified by its `kenn` id (found in
each feature's `properties`).

A `kenn` is a numeric station id. The client validates it (digits only, non-empty)
before splicing it into the WFS `viewparams` filter and rejects anything else with
a clear error — defence in depth on top of the percent-encoding the value already
receives. Cross-origin redirects drop credential-bearing headers
(`Authorization`/`X-API-Key`/`Cookie`) and `https`→`http` downgrade redirects are
refused.

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://www.imis.bfs.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |

Global options go **before** the command, e.g. `strahlenschutz --compact latest --max 5`.

### Commands

```text
latest [--station <kenn>] [--max <n>] [--start <n>] [--sort <prop>]
       latest ODL reading per station (GeoJSON)
station <kenn>          latest reading for one station
timeseries <kenn> [--resolution ts-1h|ts-24h] [--max] [--start] [--sort]
       hourly (default) or daily time series for a station
```

### Examples

```bash
# Five most recent station readings
strahlenschutz latest --max 5

# One station by its kenn id
strahlenschutz station 091811461

# Daily time series for a station
strahlenschutz timeseries 091811461 --resolution ts-24h
```

Exit codes: `0` success, `4` on a `404` from the API, `1` for any other error, non-zero for usage errors.

---

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

`client.getFeature(kind, query)` (generic), `client.latest(query)`, `client.station(kenn)`,
`client.timeseries(kenn, resolution, query)`. The `FeatureKindValues` enum and the
`TYPE_NAMES` map are exported for reference.

---

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
- The WFS boilerplate is hidden behind friendly feature-kind methods; GeoJSON is returned faithfully.

---

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, and redirect handling (same-origin follow, cross-origin credential strip, https→http downgrade refusal, missing-Location, too-many-redirects) — mocked transport.
- **`client.test.ts`** — the fixed WFS params, typeName selection, viewparams mapping and encoding, `sortBy`/`startIndex` propagation, and `kenn` validation — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, validation and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
