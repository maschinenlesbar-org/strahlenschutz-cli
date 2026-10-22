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
npm run build        # compiles every workspace (tsc -b) to its dist/
```

Run the locally built CLI without a global install:

```bash
node apps/cli/dist/src/cli/index.js --help    # or: npm start -- --help
# or, after `npm link --workspace apps/cli`:
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
  bigIntegerKeys: new Set(["_version_"]), // members whose numbers may pass 2^53: delivered as strings
  onWarning: (message) => console.warn(message), // an answer delivered changed (U+FFFD), see Charset
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

Every optional field of `EngineOptions` and `FeatureQuery` is typed `?: T | undefined`:
`undefined` means the default, as an omitted field does, so a consumer compiled with
`exactOptionalPropertyTypes` can write `{ baseUrl: process.env.X }`.

`transport` and `sleep` must be functions; anything else is a `StrahlValidationError`
(`Invalid transport: Expected a function, got string.`) when the client is built,
not a raw `TypeError` at request time. `new StrahlenschutzClient(null)` is the same as
no options. Every input the library rejects is a `StrahlValidationError`, and every
failure a `StrahlError` subclass; server text in a message is cut at 500 characters, and
any other value an own message quotes from a server answer or the caller's input (a
rejected resolution) at `MAX_QUOTED_LENGTH` (200, `cutForMessage`; a station id, a query
key or a sort key at 60), never inside a surrogate pair, so `err.message` stays bounded
and well-formed. A rejected value of the caller's is quoted visibly (`quoteValue`,
exported): DEL, C1, U+2028/2029 and every format character (a zero-width space, a soft
hyphen, a bidi control) are escaped (`Invalid station id "\u200b091811461". …`), and a cut
value ends in `"…"…`, so a copied id with an invisible character never reads as a valid one.
The CLI escapes the same characters in commander's echo of a rejected option value
(`escapeCommanderError` in `run.ts`). A request URL in a message (`urlForMessage`: redacted, then cut) keeps
at most `MAX_QUOTED_URL_LENGTH` (500) characters: after a redirect it is the server's
choice, up to Node's 16 KiB header limit. `StrahlApiError.url` keeps it whole.
`apps/cli/test/conformance-p8-p9-p13-responses-and-errors.test.ts` checks the declared charset
(P8), 2xx bodies that are no FeatureCollection (P9) and twenty wrong-typed calls (P13).

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
integers; anything else (`NaN`, `-5`, `1.5`, an array) is a `StrahlValidationError`
(`Invalid maxFeatures: expected a non-negative integer, got NaN.`) before any
request. The station id must be a string of digits (an array, an object or a number,
which loses the leading zero, is rejected the same way).

A query object may hold only its documented keys — `station`, `sortBy`,
`maxFeatures`, `startIndex` for `getFeature()`/`latest()`, the same without `station`
for `timeseries()` (whose station is its own argument). GeoServer ignores a parameter
it doesn't know, so a misspelled key (`{ statoin: "083370490" }`, `{ maxfeatures: 2 }`)
used to return the whole network; now it is a `StrahlValidationError` (`Invalid query:
Unknown key "statoin"; expected one of: …`) before any request, an own `__proto__`
key included (rule: `queryKeysProblem`). On the CLI every single-value option given twice
(`--station A --station B`, `--sort kenn --sort "value D"`, and the global ones such as
`--timeout`, `--base-url` and `--log-format`, before or after the command) is a usage error
(`once()`, exit 1, no request) instead of "last one wins"; a flag such as `--compact` may
repeat. `apps/cli/test/conformance-p10-strict-filters.test.ts` checks both.

Every query is sent with a `sortBy`: the caller's, or `DEFAULT_SORT_BY[kind]`
(`kenn` for `latest`, `kenn,end_measure` for the time series). The BfS layers have
no primary key, and GeoServer refuses any `startIndex` on an unsorted query with
HTTP 400 ("Cannot do natural order without a primary key"). A blank `sortBy` (`""`
or whitespace) is a `StrahlValidationError` (`Invalid sortBy: Expected a non-empty
value.`) before any request, rather than an empty `sortBy=` that would replace the
default sort; only an omitted `sortBy` selects the default. A direction must be
`A`/`ASC` or `D`/`DESC` (any case), and no key may be empty (rule: `sortByProblem`):
GeoServer reads any other token as ascending with HTTP 200, so `"end_measure DSC"`
returned the oldest hours of the week. The value goes out normalised
(`normalizeSortBy`): keys trimmed, inner whitespace collapsed to one space (two spaces
before `D` were also read as ascending), the direction as `A` or `D`, the property name in
NFC. A property name must be an XML name (`[\p{L}_][\p{L}\p{N}_.-]*`, with an optional
`prefix:`): `kenn+D`, `..` or `a/b` is a `StrahlValidationError`; an existing name that is
wrong is an HTTP 400 with GeoServer's reason. The value is checked like a token (below): a
control, format or bidi character (a zero-width space), a lone surrogate or only invisible
characters are refused and named; only a TAB may stand where a space does. The CLI's
`--sort` calls the same rule at parse time.

## Architecture

The repository is an **npm workspace** with two folders: `apps/` holds the programs it
publishes, `packages/` the libraries they are built from.

```
package.json         # private workspace manifest: no version, never packed
apps/cli/            # @maschinenlesbar.org/strahlenschutz-cli — the published package
  package.json       # its version, bin, files (no workspace package in dependencies)
  src/index.ts       # library entry: re-exports @maschinenlesbar.org/strahlenschutz-client
  src/cli/           # the CLI (below)
  test/              # CLI tests and every conformance-*.test.ts
packages/client/     # @maschinenlesbar.org/strahlenschutz-client — private, shipped inside the CLI's tarball
  src/               # the API client (below)
  test/              # tests that only touch the client, + the transport helpers
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag (npm run bump)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
```

- **The client is its own package** so a later MCP app can share it with the CLI. It is
  never published on its own: `apps/cli`'s `prepack` copies it into
  `apps/cli/dist/node_modules/`, where the CLI's imports find it, and the tarball ships it
  as plain files — so npm lists only commander (bundled) as a dependency, never the
  private client. `apps/cli/package.json` therefore doesn't name the client; prepack finds
  it through `apps/cli/tsconfig.json`'s project references. The library
  entry re-exports the client's `"."`, so `import { StrahlenschutzClient } from
  "@maschinenlesbar.org/strahlenschutz-cli"` is unchanged.
- **The client's exports:** `"."` is the public library surface (`src/index.ts`);
  `"./internal/*"` maps to any module (`…/strahlenschutz-client/internal/engine`) for what
  the CLI needs beyond that; `"./test/*"` reaches the client's test helpers from the CLI's
  tests (not bundled). Only `"."` is part of the library.
- **Dependencies point one way:** the app depends on the client, the client on nothing
  in the workspace.
- **The version lives in `apps/cli/package.json`.** The root has none; a plain
  `npm version` at the root is refused. Release with `npm run bump -- <patch|minor|major>`,
  which bumps the app, commits (the bare version as the message) and tags `vX.Y.Z`.
- **TypeScript:** `tsconfig.base.json` holds the compiler options; every workspace has a
  `tsconfig.json` (`src/`) and a `tsconfig.test.json` (`test/`), and the root
  `tsconfig.json`/`tsconfig.test.json` reference them, built with `tsc -b`.

The client (`packages/client/src/`) and the CLI (`apps/cli/src/`):

```
packages/client/src/
    enums.ts     # FeatureKind value set + TYPE_NAMES (friendly -> WFS typeName)
    types.ts     # GeoJSON Feature / FeatureCollection + query object
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects (with cross-origin credential strip), JSON decoding, error mapping
    errors.ts    # StrahlError / StrahlApiError / StrahlNetworkError / StrahlParseError / StrahlValidationError
    validate.ts  # input rules (Problem functions) + assertValid, shared by library and CLI
    client.ts    # StrahlenschutzClient — WFS GetFeature over the engine
    index.ts     # the client's public surface (the library entry re-exports it)
apps/cli/src/cli/
    io.ts        # injectable I/O seam (stdout/stderr/file), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
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
- Output goes through `process.stdout.write`/`process.stderr.write` (`defaultIO`); stdout
  redirected to a regular file is written with `writeAll` instead (`stdoutWriter`), so a write
  cut short is an error, never a truncated file with exit 0. The bin shim
  installs `handleOutputErrors()` (`io.ts`) before `run()`: an EPIPE on stdout (a reader such as
  `head` stopping early) exits 0 quietly instead of an unhandled stack trace and exit 1; an EPIPE
  on stderr is ignored, so a failed run keeps its exit code. ENOTCONN counts the same (stdout is a
  socket when a Node parent spawns the CLI with piped stdio on macOS; `output-errors.test.ts`).
  `apps/cli/test/conformance-p7-pipes-exit-codes.test.ts` runs the built bin to check both.
- The JSON on stdout escapes what `JSON.stringify` leaves raw although a terminal acts on it:
  DEL, the C1 range U+0080–U+009F and the bidi controls (`isBidiControl`, exported by the
  client: U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), as `\uXXXX`
  (`escapeControlChars` in `shared.ts`); the output parses to the same value. Each such
  character becomes six, so the escaped length is counted first: past V8's longest string the
  answer is an `OutputError` ("The answer is too large to print (N characters once its control
  characters are escaped)."), never a heap crash; otherwise the text is built in 64 Ki chunks and
  joined once.
- The WFS boilerplate (`service=WFS`, `request=GetFeature`, `outputFormat=application/json`) is hidden
  behind friendly feature-kind methods; GeoJSON is returned faithfully.

## Technical terms

**API client.** [`StrahlenschutzClient`](packages/client/src/client.ts) — the typed
wrapper over the WFS that hides the boilerplate and exposes the feature kinds as
methods. Usable as a library independently of the CLI.

**Methods.** `getFeature(kind, query)` (generic), `latest(query)`,
`station(kenn)` and `timeseries(kenn, resolution, query)`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](packages/client/src/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](packages/client/src/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, handles redirects, decodes JSON and
maps errors. Sits between the client's methods and the transport.

**Query-string builder.** [`query.ts`](packages/client/src/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, stringifies
booleans, ISO-formats `Date`, and encodes spaces as `%20`.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](apps/cli/src/cli/io.ts)): a client factory plus an I/O object. Lets the whole
CLI run in tests with a mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](packages/client/src/errors.ts): `StrahlApiError` (non-2xx,
or a 2xx OGC `ExceptionReport` where GeoJSON was expected; carries
`status`/`detail`/`isRetryable`), `StrahlNetworkError` (transport
failure/timeout, a redirect the engine refuses, or a non-http(s) URL at a hop of the
default transport), `StrahlParseError` (bad JSON, a 2xx body that is not a FeatureCollection
whose every feature is a JSON object with a `properties` object, or a number JSON.parse
can't carry exactly — see below) and `StrahlNotFoundError`
(raised by `station()` for an unknown id) and `StrahlValidationError` (an input rejected
before any request) — all extending `StrahlError`. Whatever an injected transport
throws becomes a `StrahlNetworkError` (`GET <url> failed: <reason>`, the original as
`cause`); so does a redirect whose `Location` doesn't parse. No error and no client
shows the base URL's password: the engine keeps the base URL in a real `#private`
field (so `console.log(client)`, `util.inspect` and `JSON.stringify` don't reveal it),
every URL in a message goes through `redactUrl`, and the base URL's userinfo (raw and
percent-decoded) is scrubbed from error bodies and details, transport error text and
the `cause` chain — and with it the forms a server echoes it back in
(`echoedCredentialForms`, exported): the `Authorization: Basic` value, the decoded
`user:password`, and the password alone from 4 characters on (`redactSecrets`,
exported). The CLI replaces the Basic value and the pair on stdout and stderr, the bare
password on stderr only (on stdout a short password may well occur in the data). The CLI maps
`StrahlNotFoundError` to exit code `4`; all other errors map to `1`, an HTTP 404
included: every command requests the one fixed WFS path, so a 404 means that
path is missing (a wrong `--base-url`, or the API moved), never an unknown
station, and the CLI appends a note saying so.

**Input validation.** [`validate.ts`](packages/client/src/validate.ts) holds the
library's input rules as pure `<thing>Problem(value)` functions, which return the
reason a value is invalid or `undefined`. The client enforces them with
`assertValid(name, value, problem)` before any request, so a rejected input sends
nothing: it throws (from a constructor) or rejects (from a method) with
`StrahlValidationError` and the message `Invalid <name>: <reason>`. The CLI's
commander parsers call the same functions, so a rule exists once; `run.ts` maps a
`StrahlValidationError` raised during an action to the usage exit code 1 (the code
commander's own parse errors use), logged as an `ERROR` record of `strahlenschutz.cli`.

**Charset.** A response body is decoded by the charset its `Content-Type` declares
(`TextDecoder`; UTF-8 when none is given, as JSON requires), with a leading byte-order
mark dropped. An unknown charset label is a `StrahlParseError` naming it. Text is never
changed silently: bytes that aren't valid in the answer's charset and lone surrogates written
as JSON escapes (`\ud800`) become U+FFFD (the result is well-formed, so `jq` reads the CLI's
output), and the engine option `onWarning` gets one message naming the count and the request
(`GET <url>: 2 characters of the answer were not valid text (invalid bytes or a lone surrogate)
and replaced with U+FFFD.`); the CLI's `action()` logs it as a `WARN` record of
`strahlenschutz.api`. One bad character never sinks a whole answer. A body too large to become
one string (512 MB and more, possible only with `maxResponseBytes: 0` or
`--max-response-bytes 0`) is a `StrahlParseError`, `GET <url>: the answer is too large to read
as text (N bytes; the longest string is 536870888 characters).`, not a plain `Error`
("Unexpected error" in the CLI); an error status with such a body keeps its `StrahlApiError`,
without the body.
Every error about an answer (an unknown charset, an empty body, bad JSON — naming the
Content-Type when it isn't a JSON type —, a number that can't be represented exactly, a body
that is no FeatureCollection, a feature for another station) names the request it answers:
`GET <url>: …`, the URL absolute and without the base URL's userinfo, as the network errors
show it (`RequestEngine#describeUrl`). The BfS
server sends UTF-8; this matters behind a mirror or proxy that re-encodes, where
`µSv/h` and umlauts in station names would otherwise turn into `�`.

**Numbers.** `JSON.parse` rounds a number past 2^53 to the nearest double, turns one out of
a double's range (`1e400`) into `Infinity` (printed as `null`) and a non-zero one too small
for a double (`1e-400`) into `0`, and a subnormal one (below 2.2250738585072014e-308, where a
double has fewer significant digits) into another number (`3e-324` into `5e-324`), without a
word. `getJson` scans the body once after the parse (strings skipped) and refuses such an
answer with a `StrahlParseError` (`GET https://www.imis.bfs.de/ogc/opendata/ows?…: the number
12345678901234567890 cannot be represented exactly.`, CLI exit 1), never a changed value. Past
2^53 and in the subnormal range a number passes when it prints as written (`1E23`,
`1.7976931348623157E308`, `5e-324`, `1e-310`: a double in its shortest form); between them a
decimal fraction keeps a double's precision, as JSON means it. A member named in the engine
option `bigIntegerKeys` (a set or list of non-empty member names, copied; default none, and this
client declares none) is the one exception: its number value is delivered as its exact literal,
as written, as a JSON string (`"1858054135406919680"`, `"5"`), whatever its size, so its type is
stable. The engine does both in one linear scan of the text before `JSON.parse` (`scanNumbers`,
which quotes the declared values in place; no reviver). A value of `bigIntegerKeys` that is not a
set or list of non-empty strings is a `StrahlValidationError` when the client is built. The BfS answer carries
dose rates and coordinates as decimals and small counts, which all pass; the station id
`kenn` is a string.

**Error detail.** GeoServer reports a bad request as an OGC `ows:ExceptionReport`
(XML). The engine's exported `owsExceptionText` pulls its `ExceptionText` (any
namespace prefix, entities and CDATA decoded) out with a small scanner — no XML
dependency — in time linear in the body (a regex rescanned to the end from every unclosed
tag: a hostile 1.2 MB report cost 13.5 s of CPU after it had arrived), and uses
it as the `detail`, for a non-2xx status and for a 2xx body that is not JSON.
Every detail is stripped of control characters, flattened to one line and cut at
`MAX_DETAIL_LENGTH` (500) characters, never inside a surrogate pair (the exported
`cutText`), so the message stays well-formed; the full body stays on `StrahlApiError.body`.

**Userinfo redaction.** A base URL may carry `user:password@` (for a mirror behind a
login). The engine never puts it into the URL a transport sees: it sends it as an
`Authorization: Basic` header per hop (see below), so request URLs in error messages
and `StrahlApiError.url` carry no userinfo; `buildUrl()` and `redactUrl` show it as
`***@`. `redactUrl` also
redacts a value that doesn't parse as a URL, by text: the exported `credentialsIn`
finds the exact userinfo of a URL that starts with a scheme, parsed or not (a port
typo, a password with `#`, `?`, `/` or a space), and `redactCredentials` replaces
those strings with `***`. A bare `a:b@c` without a scheme is no URL (it is a station
id, a User-Agent or a sort key as often as a credential). The CLI's `run()` wraps its
output in `withRedactedOutput`: it collects the credentials of every argument that is
a URL (and of the value part of `--opt=value`), plus the `--base-url` value read as a
URL even when typed without its scheme, and redacts them, raw and JSON-escaped, from every line printed —
commander's usage errors, which echo a rejected `--base-url` whole, included. The log
replaces them in each record's *message* (`redactionFor`), before the record is cut and
escaped, and writes the record to the raw stderr: the frame (time, level, topic) is never
touched, and a password with DEL, C1 or bidi characters is matched in its raw form.
`apps/cli/test/conformance-p1-cli-redaction.test.ts` checks ten passwords in seven URL shapes
at every argv position.

**Plain `http:` warning.** `cleartextProblem(baseUrl, secrets?)` (`engine.ts`, exported)
returns one sentence when requests to `baseUrl` would travel unencrypted — `requests to
<host> are sent unencrypted (http:, not https:)`, or `the base URL's credentials are sent
unencrypted to <host> (http:, not https:)` with userinfo — and `undefined` for `https:`, an
unparseable URL and loopback hosts. `<host>` is `url.host`, never the userinfo. The CLI's
`action()` wrapper logs it as a `WARN` record of `strahlenschutz.http` on stderr once per run,
before the client is built; help, version and usage errors never warn, stdout and the exit code are unchanged,
and the library never warns. `apps/cli/test/conformance-p20-cleartext-warning.test.ts` checks it.

**Cross-origin credential strip.** On a redirect to a different origin (scheme, host
or port), the engine drops credential-bearing headers
(`Authorization`/`X-API-Key`/`Cookie`), and a `401`/`403` from the target then says so
("the server redirected http→https, which dropped the base URL's credentials; use an
https base URL"); an `https`→`http` downgrade redirect is refused outright. A redirect
to the same origin, with a relative or an absolute `Location`, keeps them. Userinfo in
a `Location` is never used. Transports are told `redirect: "manual"`
(`HttpRequest.redirect`): the engine follows redirects itself, and a response whose
`HttpResponse.url` lies on another origin (a fetch transport that followed one) is
rejected as a `StrahlNetworkError`. `apps/cli/test/conformance-p3-redirect-credentials.test.ts`
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
`apps/cli/test/conformance-p6-retry-policy.test.ts` checks both.
`StrahlApiError.isRetryable` is `true` for those two statuses. A reset connection
(`ECONNRESET`/`EPIPE`/`ECONNABORTED`, or undici's `UND_ERR_SOCKET`, anywhere in the
error's `cause` chain — the exported `isTransientNetworkError`) is retried with the
linear backoff too, whichever transport reported it. Only `GET` and `HEAD` are
retried; a timeout is not.

Each retry is announced: the engine option `onRetry(event: RetryEvent)` (exported type:
`{ retry` (1-based), `maxRetries`, `delayMs`, `status?` (absent for a reset), `url` (userinfo
redacted) `}`) is called once per retry right before the sleep, never when there is none, and
a throw in it is swallowed. The CLI's `action()` sets it to log one `WARN` record of
`strahlenschutz.http`, `HTTP 503 from <host>: retry 1 of 3 in 2 s` (`retryMessage`; host only, whole
seconds, ms under 1 s). Tests: `apps/cli/test/retry-log.test.ts`.

**Transport contract.** The engine enforces its limits for every transport, not only
the built-in one: each call runs under the `timeoutMs` deadline (the request carries
an `AbortSignal` in `HttpRequest.signal`, which the built-in transport honours, and the
engine rejects at the deadline whether the transport stops or not), and the body it
gets back is checked against `maxResponseBytes`. It accepts any `ArrayBuffer` view
(`Buffer`, a fetch `Uint8Array`, a `DataView`) or `ArrayBuffer` as the body, from any
realm, and reads headers from a plain object in any case, a `Headers` object or a
`Map` (into a record without a prototype, so a header named `__proto__` is an ordinary one). A malformed response (no or a non-numeric status, no headers, a string body)
and anything a transport throws become a `StrahlNetworkError`. A redirect to a scheme
other than `http:`/`https:` (`file:`, `data:`, `javascript:`) is refused before the
transport is called. `apps/cli/test/conformance-p5-transport-contract.test.ts` checks this
with a never-answering transport, fetch against a silent server, a 2 MiB body, five
body types and four header shapes.

**maxResponseBytes.** A cap on the response body size in bytes (`0` = unlimited;
default 100 MiB), guarding against unbounded responses — applied by the built-in
transport while reading and by the engine to the body any transport returns. The
message names the option and the CLI flag: `Response exceeded the size limit of <n>
bytes (maxResponseBytes; --max-response-bytes on the CLI)`.

**Tokens.** Every value the WFS compares exactly — the station id `kenn`, a sort key, the
feature kind and the resolution — is a token (D8 of the 2026-10-21 fix plan): `tokenProblem`
(exported) refuses a value that is blank or holds only invisible characters and combining
marks ("Expected a non-empty value."), a lone surrogate, and any control or format character
(`"\u200b091811461" contains an invisible or control character (U+200B).`, quoted visibly);
`normalizeToken` (exported) sends it trimmed and in NFC. The closed sets (`kind`,
`resolution`) are looked up after that, so `" ts-24h"` is `ts-24h`; case is not folded. The
kit's `textProblem`/`normalizeText` (free text) and `splitList`/`listProblem` (comma lists) are
exported too; the WFS takes neither today. The CLI's integer parsers (`--max`, `--start`,
`--timeout`, …) check a token first, so `--max "1\u200b"` names the zero-width space.
`apps/cli/test/conformance-p24-input-corpus.test.ts` runs the corpus through every token.

**`kenn` validation.** The client checks the station id as a token, trims it and applies
Unicode NFC (the exported `normalizeInput`; `" 083370490\n"` means `083370490`), then validates it
(a string, digits only, non-empty) before splicing it into the WFS `CQL_FILTER`
(`kenn='<id>'`), and rejects anything else with a `StrahlValidationError` — defence in
depth on top of the percent-encoding the value already receives. No case-folding or
zero-padding: the filter compares strings.

**Empty result vs. not-found.** The WFS returns an empty FeatureCollection with
HTTP **200** for an unknown `kenn`, never a 404. For a single-station lookup
(`station <kenn>`) the client's `station()` treats "no features" as not-found and
rejects with `StrahlNotFoundError` (exported), which the CLI maps to exit code
**4**; `latest({ station })` and `timeseries()` resolve with the empty collection. `timeseries <kenn>` and
`latest --station <kenn>` do not: a real station can also return an empty
series (a `defekt` station, or `ts-24h`), so they print the empty collection
and exit `0`. Telling the two apart would take a second `station` request on
an empty result.

**Station identity check.** An answer to a query with a station (`station()`,
`latest({ station })`, `timeseries()`) must carry that station's `kenn` in every
feature. The live WFS applies the `CQL_FILTER`, but a mirror or proxy that drops it
answers with the whole network and HTTP 200; that answer is a `StrahlParseError`
naming the first foreign `kenn` (CLI exit 1), never another station's reading. The
foreign `kenn` is server text, so the message quotes it through the exported
`serverTextForMessage` (`engine.ts`): whitespace and line breaks folded to one space,
control characters (C0, DEL, C1) and bidi controls dropped, cut at 20 characters,
never inside a surrogate pair.

**`FeatureKindValues` / `TYPE_NAMES`.** The const array of valid feature kinds
(`latest`, `ts-1h`, `ts-24h`) and the map that translates each to its WFS
`typeName` (e.g. `opendata:odlinfo_odl_1h_latest`).

## The log on stderr

Every diagnostic line on stderr is a log record (`apps/cli/src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `strahlenschutz.<area>`. `--log-format text` (the
default) writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, unexpected errors, the
library's validation errors), `api` (the API's answers: an HTTP error status or WFS
ExceptionReport, a station the collection doesn't hold, text replaced with U+FFFD (a `WARN`), and a malformed answer — a
`StrahlParseError`: bad JSON, an unknown charset, a 2xx body that is no FeatureCollection,
a number that can't be represented exactly, an answer for another station than the one asked for) and `http` (the connection, the
cleartext warning) and `output` (a failed write to stdout, an answer too deeply nested, or too large, to print — an
`OutputError`; the CLI writes no files, so there is no `-o`). Code logs through
`logOf(deps)` and never writes diagnostics with `io.err` directly. `run()` builds the logger
from argv before commander parses it (`logFormatFromArgv`, which skips the value of the
program's value options such as `--user-agent` and takes the first `--log-format`, as
`once()` does; used only for the records of a parse error; a `preAction` hook then sets
the format commander parsed, so an option's value that looks like `--log-format` never
switches it), so commander's own usage errors are records too: its
`error: …` an ERROR of `cli` (a `(Did you mean …?)` line joined to it), the help it shows
after one an INFO record per line, and `help` for an unknown command or global options
with no command (`strahlenschutz --compact`) an ERROR "missing command: `strahlenschutz
<subcommand>`" before that help, so every failed run has an ERROR record
(`writeCommanderErr`). The log is built with the run's redaction (`withRedactedOutput`), which replaces a secret in the message
only, before it is escaped: the frame is never touched, and a secret is kept out of the log
in either format.
`CliDeps.now` makes the timestamps testable. stdout carries data only, and a record waits
for it: the default `io.err` (`stderrAfterStdout`) holds a record while stdout still has
data queued and writes it, in order, once that is out, so with `2>&1 |` and a slow reader
a record never lands inside the JSON. A failed write to stdout other than a closed pipe (`handleOutputErrors`, in the bin shim, outside `run()`)
is an ERROR record of `strahlenschutz.output` (`Could not write to stdout: …`) with exit 1 — also
a write cut short when stdout is a regular file (`> out.json` under a file-size limit or on a full
disk: EFBIG, ENOSPC), which `stdoutWriter` (`io.ts`) writes with `writeAll` and reports as
stdout's `error`, where Node's stream ignored the short count and exited 0 —, in the
format argv asks for and redacted like the run's log (`processLogger`). So are Node's own
process warnings (`installWarningLog`, also installed by the shim): a WARN record of
`strahlenschutz.cli`, `(node) <name>: <message>`, instead of Node's plain `(node:PID)
Warning: …` line (e.g. with `NODE_TLS_REJECT_UNAUTHORIZED=0`). Conformance test P23 checks all of this, and its body is shared across the
*-cli repos.

## Testing

```bash
npm test          # builds, then runs `node --test` over each workspace's dist/test
npm run coverage  # the same tests in one run, with a coverage report
node --test apps/cli/dist/test/cli.test.js   # one file, after a build
```

The client's tests are in `packages/client/test/` (`query`, `http`, `engine`, `client`, `types`),
everything that drives the CLI is in `apps/cli/test/`.

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding (and the number check), error mapping (a timeout, the size cap, a refused connection and a DNS failure read `GET <url> failed: <reason>`), 429/503 retry, and redirect handling (same-origin follow, cross-origin credential strip, https→http downgrade refusal, missing-Location, too-many-redirects) — mocked transport.
- **`client.test.ts`** — the fixed WFS params, typeName selection, `CQL_FILTER` mapping and encoding, `sortBy`/`startIndex` propagation, and `kenn` validation — mocked transport.
- **`types.test.ts`** — a consumer compiled by `tsc` with `exactOptionalPropertyTypes` may pass
  `undefined` for every optional field of `EngineOptions` and `FeatureQuery` (`?: T | undefined`),
  and at run time such an option means its default, as an omitted one does.
- **`cli.test.ts`** — end-to-end command parsing, validation and exit codes — mocked client.
- **`validate.test.ts`** — the input rules and `assertValid`.
- **`output.test.ts`** — `renderJson`: an answer nested too deeply, or too large, to print is an
  ERROR of `strahlenschutz.output` that names the cause (exit 1) and suggests `--compact` only
  where `--compact` prints that answer (probed, not assumed: whether the compact printer survives
  deep nesting depends on the Node version); `--compact` takes V8's fast
  path unless the answer holds a string or key of 64 Mi characters or more (`holdsHugeString`:
  on Node 26 the fast path aborts on a ~250 MB string, the gap path prints it), pinned with a
  mocked `JSON.stringify`.
- **`log.test.ts`** — the record helpers of `apps/cli/src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`, `installWarningLog`); the CLI-level checks are
  P23's.
- **`output-errors.test.ts`** — `handleOutputErrors`: EPIPE and ENOTCONN on stdout exit 0, on
  stderr they are ignored; any other stdout write error is an ERROR record of
  `strahlenschutz.output`; `stderrAfterStdout` holds a record behind stdout's backlog;
  `stdoutWriter` writes every byte to a redirected file or reports the error.
- **`conformance-p*.test.ts`** — the checks shared across the `*-cli` repos (fix plan
  `.reviews/2026-10-05-exploratory/fix-plan.md` in the workspace), one file per pattern, the same
  code in every repo apart from an adapter block at the top: P1 credential redaction in CLI output,
  P2 in library objects and errors, P3 credentials across redirects, P4/P19 base-URL validation
  (P19 skipped: no environment variable), P5 the transport contract (timeout, size cap, body
  types, header shapes, resets), P6 the retry floor, P7 pipes and exit codes (spawns the built
  bin), P8/P9/P13 charset, 2xx body shapes and error classes, P10 strict query keys and repeated
  options, P20 the stderr warning for a plain-`http:` base URL, P21 README links only to files
  the npm package ships (others by their GitHub URL), P23 the log on stderr (its body takes the
  usage-error exit code from the adapter's `USAGE_EXIT`, `1` here), P24 the input corpus (no
  text filter and no list here; the tokens are the station id, read from the `CQL_FILTER`, the
  `--sort` of `latest` and `timeseries` and the `--resolution`; a blank, invisible, control or
  half character is refused on both sides and shown escaped), P25 the response corpus (a number a double
  can't carry, and an empty answer, are exit 1 and the parse error; on `latest`). P26 output
  integrity (stdout redirected to a file and cut short is an `ERROR` record, exit 1; its `-o`
  tests are skipped, `HAS_OUTPUT_OPTION = false`: the CLI writes no files). P27 big and odd answers (spawns the built bin under a small
  heap): a large flat answer prints with `--compact`; 20 M DEL characters print escaped under a
  512 MB heap, 90 M are an ERROR record of `strahlenschutz.output`, not a crash; a lone surrogate
  or invalid bytes become U+FFFD with a `WARN` record of `strahlenschutz.api`.
- **Parity tests** use `parity()` from `apps/cli/test/helpers.ts`: one input through `run()` and through
  the library call on one recording mock transport; both must reject without a request, or both
  send the same request.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24/26 for every push and PR; then pack the
  real tarball, check the pack left nothing behind, install it globally with the registry out
  of reach and run the bin.
- **release.yml** — on a `v*` tag (made by `npm run bump`): verify the tag matches
  `apps/cli/package.json`, test, write the SBOMs (scoped to the `apps/cli` workspace), then
  `npm pack --workspace apps/cli`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): `npm publish --workspace apps/cli` via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar.org/strahlenschutz-cli/> in English
and <https://maschinenlesbar.org/strahlenschutz-cli/de/> in German — is built from
`site/` with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web
components and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the
TypeDoc API reference under `/api/`. Its content comes from this repository: the README intro
and quick start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`),
`Usage.md`, `GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill
examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are
`site/_config.yml` (which also says where the published manifest and the built program are:
`manifest: apps/cli/package.json`, `program: apps/cli/dist/src/cli/program.js`) and
`site/_data/project.yml` (the German intro and the access requirements);
the rest of `site/` is identical in every maschinenlesbar.org CLI, so change it in all of them
together. When the README intro changes, update the German intro in `site/_data/project.yml`.

The build also writes `sitemap.xml`: every page in both languages, and `/api/`. Crawlers
find it through `robots.txt` at the root of maschinenlesbar.org, which only the
organisation website can serve; its `site/_data/sites.yml` lists every site's sitemap, so a
new CLI gets a line there.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/strahlenschutz-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
