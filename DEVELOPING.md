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
import { StrahlenschutzClient, StrahlApiError, StrahlNotFoundError } from "@maschinenlesbar.org/strahlenschutz-cli";

const client = new StrahlenschutzClient(); // defaults to https://www.imis.bfs.de

const latest = await client.latest({ maxFeatures: 5 }); // sent as WFS 2.0 `count`
const one = await client.station("091811461");
const series = await client.timeseries("091811461", "ts-24h");

try {
  await client.station("999999999");
} catch (err) {
  if (err instanceof StrahlNotFoundError) console.error(err.message); // unknown kenn
  else if (err instanceof StrahlApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new StrahlenschutzClient({
  baseUrl: "https://www.imis.bfs.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 and resets: linear backoff, longer if Retry-After asks (<= 30 s)
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

The numeric options are range-checked when the client is built: `timeoutMs` is an
integer from `0` (no timeout) to `MAX_TIMEOUT_MS` (2³¹−1 ms), `maxRetries` from `0`
to `MAX_RETRIES` (10), `maxRedirects` from `0` to `MAX_REDIRECTS` (10), and
`maxResponseBytes` (`0` = unlimited) is a non-negative safe integer, and
`retryDelayMs` an integer from `0` to `MAX_RETRY_AFTER_MS` (30 000). Anything else (`-1`, `1.5`, `NaN`, `Infinity`, `11` retries) throws a
`StrahlValidationError` (`Invalid maxRetries: Must be <= 10.`) instead of silently
disabling the timeout or the size cap. The CLI's `--timeout`, `--max-retries` and
`--max-response-bytes` apply the same bounds.

`baseUrl` is checked by the exported `validateBaseUrl` (rule: `baseUrlProblem`) when
the client is built: no whitespace or control characters, surrounding or inner
(`new URL()` would trim or strip them silently, but the WFS path is appended to the
raw string, so `"https://h/ "` would request `/%20/ogc/...`); an absolute URL; an
`http:`/`https:` scheme; no `?query` or `#fragment` (they would swallow the WFS
path). A path prefix and userinfo are fine; a `%` in the userinfo must start a valid
escape (write a literal `%` as `%25`), since the engine percent-decodes it for the
`Authorization` header. A bad value is a configuration error,
so it throws `StrahlValidationError` (`Invalid baseUrl: Only "http:" and "https:"
base URLs are supported.`), never `StrahlNetworkError`, and the message never
repeats the URL. The CLI's `--base-url` calls the same rule.

`userAgent` must be a usable header value: not blank, no control character other
than tab, nothing above U+00FF. Anything else throws a `StrahlValidationError`
(`Invalid userAgent: Value contains control characters.`) when the client is built,
so a CR/LF never reaches a custom transport; only an omitted `userAgent` selects the
default `strahlenschutz-cli`. The CLI's `--user-agent` applies the same rule
(`headerValueProblem`). Should the default transport still be handed a header value
Node refuses, it rejects with `StrahlNetworkError` (`Invalid request: …`) rather
than a raw `TypeError`.

### Methods

`client.getFeature(kind, query)` (generic), `client.latest(query)`,
`client.station(kenn)`, `client.timeseries(kenn, resolution, query)`.
The `FeatureKindValues` enum, its time-series subset `TimeseriesResolutionValues`
and the `TYPE_NAMES` map are exported for reference. `getFeature()` rejects a
`kind` outside `FeatureKindValues`, and `timeseries()` a `resolution` outside
`TimeseriesResolutionValues` (so `"latest"` too), with a `StrahlValidationError`
(`Invalid resolution: Expected one of: ts-1h, ts-24h (got "latest").`) before any
request. The check is a membership test on the value list, so inherited names such
as `__proto__` or `constructor` are rejected as well.

`maxFeatures` (sent as `count`) and `startIndex` must be non-negative safe
integers; anything else (`NaN`, `-5`, `1.5`) is a `StrahlError`
(`Invalid maxFeatures: expected a non-negative integer, got NaN.`) before any
request.

Every query is sent with a `sortBy`: the caller's, or `DEFAULT_SORT_BY[kind]`
(`kenn` for `latest`, `kenn,end_measure` for the time series). The BfS layers have
no primary key, and GeoServer refuses any `startIndex` on an unsorted query with
HTTP 400 ("Cannot do natural order without a primary key"). A blank `sortBy` (`""`
or whitespace) is a `StrahlValidationError` (`Invalid sortBy: Expected a non-empty
value.`) before any request, rather than an empty `sortBy=` that would replace the
default sort; only an omitted `sortBy` selects the default.

## Architecture

```
src/
  client/
    enums.ts     # FeatureKind value set + TYPE_NAMES (friendly -> WFS typeName)
    types.ts     # GeoJSON Feature / FeatureCollection + query object
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects (with cross-origin credential strip), JSON decoding, error mapping
    errors.ts    # StrahlError / StrahlApiError / StrahlNetworkError / StrahlParseError / StrahlValidationError
    validate.ts  # input rules (Problem functions) + assertValid, shared by library and CLI
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
or a 2xx OGC `ExceptionReport` where GeoJSON was expected; carries
`status`/`detail`/`isRetryable`), `StrahlNetworkError` (transport
failure/timeout, a redirect the engine refuses, or a non-http(s) URL at a hop of the
default transport), `StrahlParseError` (bad JSON, or a 2xx body that is not a FeatureCollection
whose every feature is a JSON object with a `properties` object) and `StrahlNotFoundError`
(raised by `station()` for an unknown id) and `StrahlValidationError` (an input rejected
before any request) — all extending `StrahlError`. Whatever an injected transport
throws becomes a `StrahlNetworkError` (`GET <url> failed: <reason>`, the original as
`cause`); so does a redirect whose `Location` doesn't parse. No error and no client
shows the base URL's password: the engine keeps the base URL in a real `#private`
field (so `console.log(client)`, `util.inspect` and `JSON.stringify` don't reveal it),
every URL in a message goes through `redactUrl`, and the base URL's userinfo (raw and
percent-decoded) is scrubbed from error bodies and details, transport error text and
the `cause` chain. The CLI maps
`StrahlNotFoundError` to exit code `4`; all other errors map to `1`, an HTTP 404
included: every command requests the one fixed WFS path, so a 404 means that
path is missing (a wrong `--base-url`, or the API moved), never an unknown
station, and the CLI appends a note saying so.

**Input validation.** [`validate.ts`](src/client/validate.ts) holds the
library's input rules as pure `<thing>Problem(value)` functions, which return the
reason a value is invalid or `undefined`. The client enforces them with
`assertValid(name, value, problem)` before any request, so a rejected input sends
nothing: it throws (from a constructor) or rejects (from a method) with
`StrahlValidationError` and the message `Invalid <name>: <reason>`. The CLI's
commander parsers call the same functions, so a rule exists once; `run.ts` maps a
`StrahlValidationError` raised during an action to the usage exit code 1 (the code
commander's own parse errors use), printed as `Error: <message>`.

**Error detail.** GeoServer reports a bad request as an OGC `ows:ExceptionReport`
(XML). The engine's exported `owsExceptionText` pulls its `ExceptionText` (any
namespace prefix, entities decoded) out with a regex — no XML dependency — and uses
it as the `detail`, for a non-2xx status and for a 2xx body that is not JSON.
Every detail is stripped of control characters, flattened to one line and cut at
`MAX_DETAIL_LENGTH` (500) characters; the full body stays on `StrahlApiError.body`.

**Userinfo redaction.** A base URL may carry `user:password@` (for a mirror behind a
login). The engine never puts it into the URL a transport sees: it sends it as an
`Authorization: Basic` header per hop (see below), so request URLs in error messages
and `StrahlApiError.url` carry no userinfo; `buildUrl()` and `redactUrl` show it as
`***@`. `redactUrl` also
redacts a value that doesn't parse as a URL, by text: the exported `credentialsIn`
finds the exact userinfo of any URL-like value (a port typo, a password with `#`,
`?`, `/` or a space, a scheme-less `user:pw@host`), and `redactCredentials` replaces
those strings with `***`. The CLI's `run()` wraps its output in `withRedactedOutput`:
it collects the credentials of every argument (and of the value part of
`--opt=value`) and redacts them, raw and JSON-escaped, from every line printed —
commander's usage errors, which echo a rejected `--base-url` whole, included.
`test/conformance-p1-cli-redaction.test.ts` checks ten passwords in seven URL shapes
at every argv position.

**Cross-origin credential strip.** On a redirect to a different origin (scheme, host
or port), the engine drops credential-bearing headers
(`Authorization`/`X-API-Key`/`Cookie`), and a `401`/`403` from the target then says so
("the server redirected http→https, which dropped the base URL's credentials; use an
https base URL"); an `https`→`http` downgrade redirect is refused outright. A redirect
to the same origin, with a relative or an absolute `Location`, keeps them. Userinfo in
a `Location` is never used. Transports are told `redirect: "manual"`
(`HttpRequest.redirect`): the engine follows redirects itself, and a response whose
`HttpResponse.url` lies on another origin (a fetch transport that followed one) is
rejected as a `StrahlNetworkError`. `test/conformance-p3-redirect-credentials.test.ts`
checks this with a two-port mock pair.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically, up to `--max-retries` / `maxRetries` (`0`–`MAX_RETRIES`, 10;
the library rejects a value outside that range). Each retry waits
`retryDelayMs * attempt` (200 ms, 400 ms, …), or longer if the response's
`Retry-After` asks — delay-seconds or an IMF-fixdate HTTP-date, parsed strictly by the
exported `parseRetryAfter`. A `Retry-After` can only lengthen a wait: `0` or a date in
the past waits the backoff, so a server that just answered 429 never gets a burst. A
`Retry-After` above `MAX_RETRY_AFTER_MS` (30 s) is not retried: the `StrahlApiError`
surfaces at once, and its message names the requested wait and says retrying sooner
won't help. `retryDelayMs` is bounded to `0`–`MAX_RETRY_AFTER_MS`.
`test/conformance-p6-retry-policy.test.ts` checks both.
`StrahlApiError.isRetryable` is `true` for those two statuses. A reset connection
(`ECONNRESET`/`EPIPE`/`ECONNABORTED`, or undici's `UND_ERR_SOCKET`, anywhere in the
error's `cause` chain — the exported `isTransientNetworkError`) is retried with the
linear backoff too, whichever transport reported it. Only `GET` and `HEAD` are
retried; a timeout is not.

**Transport contract.** The engine enforces its limits for every transport, not only
the built-in one: each call runs under the `timeoutMs` deadline (the request carries
an `AbortSignal` in `HttpRequest.signal`, which the built-in transport honours, and the
engine rejects at the deadline whether the transport stops or not), and the body it
gets back is checked against `maxResponseBytes`. It accepts any `ArrayBuffer` view
(`Buffer`, a fetch `Uint8Array`, a `DataView`) or `ArrayBuffer` as the body, from any
realm, and reads headers from a plain object in any case, a `Headers` object or a
`Map`. A malformed response (no or a non-numeric status, no headers, a string body)
and anything a transport throws become a `StrahlNetworkError`. A redirect to a scheme
other than `http:`/`https:` (`file:`, `data:`, `javascript:`) is refused before the
transport is called. `test/conformance-p5-transport-contract.test.ts` checks this
with a never-answering transport, fetch against a silent server, a 2 MiB body, five
body types and four header shapes.

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses — applied by the built-in
transport while reading and by the engine to the body any transport returns. The
message names the option and the CLI flag: `Response exceeded the size limit of <n>
bytes (maxResponseBytes; --max-response-bytes on the CLI)`.

**`kenn` validation.** The client validates the station id (digits only,
non-empty) before splicing it into the WFS `CQL_FILTER` (`kenn='<id>'`) and
rejects anything else with a clear error — defence in depth on top of the
percent-encoding the value already receives.

**Empty result vs. not-found.** The WFS returns an empty FeatureCollection with
HTTP **200** for an unknown `kenn`, never a 404. For a single-station lookup
(`station <kenn>`) the client's `station()` treats "no features" as not-found and
rejects with `StrahlNotFoundError` (exported), which the CLI maps to exit code
**4**; `latest({ station })` and `timeseries()` resolve with the empty collection. `timeseries <kenn>` and
`latest --station <kenn>` do not: a real station can also return an empty
series (a `defekt` station, or `ts-24h`), so they print the empty collection
and exit `0`. Telling the two apart would take a second `station` request on
an empty result.

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
- **`validate.test.ts`** — the input rules and `assertValid`.
- **Parity tests** use `parity()` from `test/helpers.ts`: one input through `run()` and through
  the library call on one recording mock transport; both must reject without a request, or both
  send the same request.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/strahlenschutz-cli/> in English
and <https://maschinenlesbar-org.github.io/strahlenschutz-cli/de/> in German — is built from
`site/` with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web
components and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the
TypeDoc API reference under `/api/`. Its content comes from this repository: the README intro
and quick start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`),
`Usage.md`, `GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill
examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are
`site/_config.yml` and `site/_data/project.yml` (the German intro and the access requirements);
the rest of `site/` is identical in every maschinenlesbar.org CLI, so change it in all of them
together. When the README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/strahlenschutz-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
