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
import { StrahlenschutzClient, StrahlApiError, StrahlNotFoundError, getDoseSnapshot, getStationTrend } from "@maschinenlesbar.org/strahlenschutz-cli";

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

// The skills' use cases, with their traps built in (see "MCP server" below): stations without a
// value counted and never ranked, each station's own newest hour, a verdict against background;
// a station's hourly series read newest first and judged against its own baseline.
const snapshot = await getDoseSnapshot(client, { state: "Bayern", limit: 5 });
const trend = await getStationTrend(client, { station: "Herrischried", hours: 48 });
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
(`new URL()` would trim or strip them silently, so the URL requested would not be the one
typed); no backslash (`A base URL cannot contain a backslash (\); write "/" instead.`); an
absolute URL; an `http:`/`https:` scheme; no `?query` or `#fragment` (they would swallow
the WFS path); the scheme followed by exactly `//` and the host (`Expected an absolute
http(s) URL ("https://" and the host).`). A path prefix and userinfo are fine; a `%` in the
userinfo must start a valid escape (write a literal `%` as `%25`), since the engine
percent-decodes it for the `Authorization` header. WHATWG ends an http(s) host at a
backslash and repairs `http:host`, `http:/host` and `http:///host` into `http://host`
silently, where text-based code read on: `https://u:pw@127.0.0.1\@b.example` was loopback
to every check (no cleartext warning) while the request and `u:pw` went to b.example. So,
besides the refusals, the engine builds every request URL from the parsed base URL
(`new URL(...).href`, userinfo cleared, trailing slashes stripped): the host is lower-cased,
a default port dropped and the path percent-encoded as WHATWG does it, and that is the
spelling error messages, `buildUrl` and a custom transport see. `credentialsIn` ends a
special scheme's authority at a backslash too and skips the slashes and backslashes WHATWG
skips after it (`http:///u:pw@host` carries `u:pw`), and the engine scrubs the userinfo as
typed and as WHATWG spells it. A bad value is a configuration error,
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
  test/              # tests that only touch the client, + the transport helpers and fixtures (a mock of the WFS)
apps/mcp/            # @maschinenlesbar.org/strahlenschutz-mcp — the MCP server, released with the CLI
packages/log/        # the log records (text/jsonl), shared by both apps
tools/image/         # the container images of both apps (build, push, smoke, SBOM)
tools/interop/       # the built MCP server against the official MCP client (own lockfile)
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag of every published app (npm run bump)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
```

- **The client is its own package** so the MCP app shares it with the CLI. It is
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
- **The version lives in `apps/cli/package.json`** (and, the same, in `apps/mcp/package.json`).
  The root has none; a plain `npm version` at the root is refused. Release with
  `npm run bump -- <patch|minor|major>`, which bumps every published app together, commits (the
  bare version as the message) and tags `vX.Y.Z`.
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
    operations.ts # the skills' use cases: getDoseSnapshot / getStationsMap / getStationTrend / findStations / getTimeseries
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
percent-decoded) is scrubbed from error bodies and details, transport error text, the
Content-Type or charset label a parse error quotes, and the `cause` chain (JSON.parse's
syntax error quotes the start of the body) — and with it the forms a server echoes it back in
(`echoedCredentialForms`, exported): the `Authorization: Basic` value, the decoded
`user:password`, and the password alone from 4 characters on (`redactSecrets`,
exported), each also percent-encoded. A userinfo without a password (`https://TOKEN@host`,
`https://TOKEN:@host`) is a token: it is sent as `Basic base64("TOKEN:")`, and its forms are
that value, `TOKEN:` and the token alone, in place of the password. Server text is scrubbed **after it is decoded**, before
it is cleaned and cut, and again after: an escape (a JSON `\u0073`, an XML `&amp;` or
character reference, a CDATA section split inside the password) hid a credential from a scrub
of the body as sent, and decoding then gave the plain password to `.message` and `.detail`
(`owsExceptionText` takes the scrub as its second argument). `StrahlApiError.body` keeps its
spelling unless a credential hides behind an escape in it: a JSON body is then written again
decoded (`JSON.stringify`) with the credential scrubbed, an XML one is left out (`""`). The CLI replaces the Basic value and the pair on stdout and stderr, the bare
password (or token) on stderr only (on stdout a short password may well occur in the data). The CLI maps
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
Every detail is cleaned by `sanitizeServerText` (whole terminal escape sequences, the
remaining control characters and every format character — bidi controls, zero-width
characters — dropped, flattened to one line) and cut at `MAX_DETAIL_LENGTH` (500)
characters, never inside a surrogate pair (the exported `cutText`), so the message stays
well-formed; the full body stays on `StrahlApiError.body`. The cleaning reads only the first
16 384 characters of the server text and is one linear regex pass per step: one string append
per character over a detail of a few MB exhausted a small heap (a V8 abort, no typed error)
before the cut. The same goes for every text the engine puts together from many pieces of an
answer (the lone-surrogate repair, the quoted `bigIntegerKeys` values, the unwrapped CDATA
sections, `redactUrlUserinfo`): the pieces are joined in batches (`TextBuilder`, `errors.ts`),
so memory follows the length of the text, not the number of pieces; one `+=` per piece made a
rope node each, and millions of them exhausted a 128 MB heap.

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
output in `withRedactedOutput`: it collects the credentials of every URL inside any
argument — at its start, after padding or a dash, mid-phrase, and in its percent-decoded form
(and of the value part of `--opt=value`); each `://` found with indexOf, at most 64 URLs per
argument, so a long argument costs linear time —, plus the `--base-url` value read as a URL even when
typed without its scheme, and redacts them, raw, JSON-escaped, as commander's escaped echo shows
them and percent-encoded, from every line printed —
commander's usage errors, which echo a rejected `--base-url` whole, included. Behind the exact
strings, stdout and stderr also go through `redactUrlUserinfo` (`errors.ts`), which replaces
the userinfo of any URL in the text (`https://***@host`), in one linear pass however long the
answer, a URL glued onto the one before it (`https://host://u:p@h`) included. The log
replaces them in each record's *message* (`redactionFor`), before the record is cut and
escaped, and writes the record to the raw stderr: the frame (time, level, topic) is never
touched, and a password with DEL, C1 or bidi characters is matched in its raw form.
`apps/cli/test/conformance-p1-cli-redaction.test.ts` checks ten passwords in seven URL shapes
at every argv position.

A base URL (`--base-url`, and the environment variable where the CLI reads one) is read as
a URL however its scheme is typed (`typedUrlCredentials`): missing (`alice:pw@host`) or
mistyped (`http//alice:pw@host`, the colon left out, whose userinfo is everything between the
first slashes and the last `@`), so commander's echo of a refused one shows no password.

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
checks this with a two-port mock pair. A server can echo the credential in a `Location` (in
its path or query, raw or percent-encoded): every message about the request after a redirect
(a redirect loop, a refused downgrade, an error answer, a reset, the size cap, `onRetry`'s
`url`, `StrahlApiError.url`) names the URL as shown (`RawResponse.shownUrl`), the `Location`
scrubbed as sent before it is resolved (`redirectTarget`; resolving first would write `'` as
`%27`, a spelling no scrub matches), userinfo redacted. The request itself goes to the
`Location` as sent.

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
engine rejects at the deadline whether the transport stops or not; the built-in transport fails
with the signal's reason when that is the engine's own timeout error, and with `Request aborted by
its caller before it finished` when another signal aborted it (the MCP server's tool call: its
deadline or a cancellation), never with a request timeout that didn't happen), and the body it
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
bytes (maxResponseBytes; --max-response-bytes on the CLI)`. Below the cap, the built-in
transport's memory follows the bytes, not the number of chunks a server sends them in: small
chunks are joined as they arrive (at most 1 024 of them or 64 KiB unjoined); a Buffer kept
per chunk held about 210 bytes of heap per byte for one-byte chunks, so 2 MB on the wire
aborted the CLI under a 256 MB heap.

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
foreign `kenn` is server text, so the message quotes it through
`RequestEngine#quoteServerValue`: the base URL's credentials scrubbed (a mirror can echo them
there), cleaned as an error detail is (`sanitizeServerText`: escape sequences, control
characters and format characters, bidi controls among them, dropped; whitespace and line
breaks folded to one space; at most the first 16 384 characters read), scrubbed again (a
dropped control character no longer hides an echo), then cut at 20 characters, never inside a
surrogate pair. Unscrubbed, the cut kept the first 20 characters of an echoed password. API
code that quotes a value from an answer uses it; the exported `serverTextForMessage` cleans and
cuts but knows no credentials.

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
  or invalid bytes become U+FFFD with a `WARN` record of `strahlenschutz.api`; an answer in two
  million one-byte chunks prints under a 256 MB heap. P28–P31 come from the security audit of
  2026-10-27 (reference `create-cli-template`): P28 hostile error answers (a number with a long
  run of zeros refused in linear time; unterminated control-string introducers and a 16 MB error
  message cleaned in linear time and memory; millions of lone surrogates repaired under a small
  heap; the base URL's credentials scrubbed from JSON-escaped error text, from the foreign `kenn`
  the station-filter error quotes, `quotedBody` in the adapter, and from a redirect's `Location`,
  where strahlenschutz ends at `Too many redirects`), P29 base-URL credentials (a token userinfo
  scrubbed in every form, a backslash or a repaired scheme refused, requests to the parsed host,
  stdout redaction linear and covering glued URLs), P30 output links (all skipped,
  `HAS_OUTPUT_OPTION = false`), P31 the release pipeline (`release.yml` and `tools/sbom/` read as
  text).
- **Parity tests** use `parity()` from `apps/cli/test/helpers.ts`: one input through `run()` and through
  the library call on one recording mock transport; both must reject without a request, or both
  send the same request.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24/26 for every push and PR; then pack each
  published app (the CLI and the MCP server), check the pack left nothing behind, install it
  globally with the registry out of reach and run its bins; its `interop` job runs the MCP
  server against the official client.
- **images.yml** — build, smoke-test and scan both container images on every push and weekly
  (see [Container image](#container-image)).
- **release.yml** — on a `v*` tag (made by `npm run bump`), three jobs: `pack` (read-only:
  verify the tag matches `apps/cli/package.json`, the release notes, test,
  `npm pack --workspace apps/cli`, the tarball's and the notes' sha256 as job outputs), `sbom`
  (read-only: the CycloneDX SBOMs, scoped to the `apps/cli` workspace, made with the tool locked
  in `tools/sbom/` and installed with `npm ci --ignore-scripts --prefix tools/sbom`) and
  `release`, the only job with `contents: write`: no checkout and no npm, it checks the
  downloaded tarball and notes against the pack job's digests and runs only `gh release create`
  (tarball, both SBOMs, notes). To update the SBOM tool, change its version in
  `tools/sbom/package.json` and run `npm install --package-lock-only --ignore-scripts` there;
  like `tools/docs/`, its install is never chained into an npm script. The release also carries
  both image archives, their SBOMs, `SHA256SUMS` and signed provenance (see
  [Container image](#container-image)).
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): publishes the release's own files, both tarballs to npm via OIDC **Trusted
  Publishing** (no stored `NPM_TOKEN`) with provenance and both images to ghcr.io, each checked
  first against the immutable release and the provenance `release.yml` signed.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## MCP server (apps/mcp)

`apps/mcp` is the second published app, `@maschinenlesbar.org/strahlenschutz-mcp` (bin
`strahlenschutz-mcp`), released in lockstep with the CLI: `npm run bump` bumps every
published app under `apps/` together, one version, one tag. Its npm README is the root
`MCP.md` (prepack packs `<APP>.md` for an app that has one).

| Module | Role |
|---|---|
| `packages/client/src/operations.ts` | The skills' use cases as library functions (getDoseSnapshot, getStationsMap, getStationTrend, findStations, getTimeseries), with their traps built in. The network is one `latest` request (about 1,670 stations, 0.9 MB), filtered and ranked here: the WFS has no name or area search, and its own sort puts the ~120 stations without a value (defekt, Testbetrieb) first, so those are counted by status and never ranked. A station's Land is the first two digits of its kenn (the Gemeindeschlüssel's Land code; the FINO platforms are filed under Schleswig-Holstein). A place is the circle (`radiusKm`, default 25) around the stations whose name it starts a word of (München, not Waldmünchen; umlauts, case and ae/oe/ue folded by `fold`); stations of one name more than 40 km apart (Bergen) are `ambiguous`. Coordinates outside Germany's box (lon 5.5–15.5, lat 47–55.5; one station had [589.28, 3007.11]) are never placed: the map names them in `leftOff`. The snapshot says the hour most readings are for and marks the older ones; its verdict is normal up to 0.3 µSv/h (`NOTABLE_DOSE_RATE`; background is about 0.05–0.25). The trend reads the hourly series newest first (`end_measure D` with `count`: the series comes oldest first), then judges the newest 6 hours against the median before them: rising or falling at 0.03 µSv/h (`TREND_STEP`), a spike at 0.05 above (`SPIKE_STEP`), else steady; day means are per UTC day. An empty series is told apart with a look into the network: an unknown kenn, a station without readings, or the daily series, which has values for Flensburg (010010001) only. An offset past the end of the map, the station search or a series is `empty`, saying how many there are. Public API of both packages. |
| `packages/log` | The log records (text/jsonl), shared by both apps; `createLogger({ program })`. |
| `src/mcp/tools.ts` | This repo's: the five tools (flat input schemas with limits, no root combinators; one object output schema each; descriptions under 2000 characters), the instructions, the licence (the BfS's dl-de/by-2-0 attribution with "eigene Bearbeitung" and its ask for a factual presentation), the hints the server's messages give; an outage's error (HTTP 502, a 503 after the client's retries, 504, a request timeout or a reset connection) adds that the BfS service is sometimes slow or down for a while, to try again shortly, unchanged. |
| `src/mcp/api.ts` | This repo's: how the kit reaches the client (`StrahlenschutzClient` as `Client`, `StrahlError` as `ClientError`, `StrahlNetworkError` as `NetworkError`, `apiBase`). `apiBase` is the base URL plus `/ogc/opendata`, so a result's `source` is the WFS request (`ows?service=WFS&request=GetFeature&typeName=…`); a trend by name names the request of the station it resolved to. This client is built without credentials, so it exports no `CHECK_CLIENT_OPTIONS`: `config.ts` builds one at start to check `--base-url` and `--user-agent`, so a value the client's constructor refuses is a usage error (exit 2), never a crash. |
| `src/mcp/server.ts` | The McpServer factory, the tool types, `callTool`: deadline (`--call-timeout`, after which a tool has a moment to answer with the part it has read) plus the client's cancellation, cleaned (a text over 2000 characters cut with a mark and `truncated`; a tool that passes long text on purpose allows more with `maxFieldLength`) and fitted answers, `source` naming another origin a redirect fetched the answer from (the limiter notes each hop of this client, which follows redirects), failures as `isError` results. |
| `src/mcp/result.ts` | `cleanStrings` (control, bidi, zero-width, tag and other invisible characters dropped in values and keys, an emoji's joiners kept), `fitResult` (answers fitted under `--max-result-chars`: the page's entries dropped first, then long texts cut further, then other lists' entries, which `reason` names; `nextOffset` only for a page that lost entries; a list keeps its first entry, `notes` stay whole; a tool error when that is not enough). |
| `src/mcp/limiter.ts` | One per process around the upstream transport: 2 in flight, 120 a minute, a pause of at most 30 s on 429 for the origin that sent it, a bounded queue; a request they would hold past its deadline refused at once. |
| `src/mcp/http.ts` | node:http adapter for the SDK's `createMcpHandler`: POST /mcp, /healthz, Host and Origin checks (the SDK does neither) and CORS for an allowed origin, 1 MiB body, 8 requests at once, timeouts. |
| `src/mcp/stdio.ts` | stdio that answers the requests it has read when stdin ends, and a line that isn't JSON-RPC with an error (-32700, -32600) and a WARN record. |
| `src/mcp/config.ts`, `run.ts`, `index.ts` | Options (`node:util` parseArgs), argv -> exit code, the bin (console into log records, SIGINT/SIGTERM, stdin's end). |
| `src/mcp/credentials.ts`, `auth.ts` | The credentials hook (api.ts's `findCredentials`; this API needs none) and the secrets redacted from results and records (`Secrets`: a value under 16 characters only as a whole occurrence, not inside a run of letters and digits of any script; a longer one, a token, wherever it stands); the HTTP bearer token of `--auth-token-file` (read once at start: no link, owned by the server's user, mode 600, one token of at least 32 characters, a regular file opened non-blocking, so a FIFO is refused at once instead of blocking the start). |

The protocol is the SDK's: `@modelcontextprotocol/server` 2.4.0, bundled with its core and zod
(prepack). It serves the 2026-07-28 revision and the 2025 handshake (2025-11-25, 2025-06-18)
statelessly, on stdio (`serveStdio`) and HTTP. The SDK bundles AJV 8.18 into its own code to
validate tool arguments against the input schemas; an SBOM doesn't list that copy.

Accepted SDK behaviour on stdio: a client that sends `notifications/initialized` and a request
before the answer to its `initialize` (the MCP lifecycle says it must wait) gets its answers
late, at the next event on the connection, because `serveStdio` decides the protocol era from
the opening exchange. Real clients wait, so nothing is worked around here.

**The kit.** Everything in `apps/mcp` but `tools.ts`, `api.ts`, `test/helpers.ts`,
`test/tools.test.ts` and the conformance tests' adapter blocks, plus `packages/log`,
`apps/cli/src/cli/limits.ts`, `tools/image/` (but `smoke.json`), `tools/interop/` (but
`interop.json`), `tools/bump.mjs`, `tools/pack/` and the workflows `ci.yml`, `images.yml`,
`release.yml` and `publish.yml`, is the kit of `create-cli-template` (in the api-cli workspace),
the same in every repository with an MCP server: a fix lands there first and comes here with
`npm run sync-kit -- ../strahlenschutz-cli` (run in create-cli-template; `--check` lists the
drift).

Tests (`apps/mcp/test`) run in-process over the SDK's InMemoryTransport with raw JSON-RPC (the kit's
`harness.ts`). The rules every server follows are the shared conformance tests `conformance-m1-…` to
`conformance-m12-…` (protocol and tool rules, HTTP, Host and Origin, stdio with the built bin,
config, limiter, result shaping, drain, call errors, MCP.md, credentials, the HTTP bearer token of
`--auth-token-file`: `auth.ts`, required where `api.ts` exports `HTTP_NEEDS_AUTH_TOKEN = true`, for
an API called with a personal account), each with an adapter block naming this repo's calls and mock
answers (this API needs no credentials, so the credentials tests are skipped); `tools.test.ts` holds
this server's own (the five tools, the traps). The mock WFS is the client's `test/fixtures.ts`
(`odlApi`, `odlAnswer`): it answers like the GeoServer (the layer by `typeName`, `CQL_FILTER
kenn='…'`, `sortBy` with nulls first, `count`, `startIndex`) over 24 stations of the live `latest`
layer of 2026-11-19 (the five highest, the three offshore platforms, defekt and Testbetrieb
stations, a reading not validated, readings hours old, four Munich stations, two towns named Bergen;
Trollenhagen with the broken coordinates of 5 Oct 2026), Herrischried's hourly series (167 hours)
and Flensburg's daily one (40 days). The stdio tests start the built bin (30 s each).
`tools/interop/` checks the built server against the official client 2.4.0 (stdio and HTTP; legacy,
auto and pinned 2026-07-28) in ci.yml's `interop` job; it has its own lockfile and is never
installed by the workspace, release or publish runs; the calls it makes and the mock's answer (one
per path: the WFS's `latest` layer) are in `tools/interop/interop.json`.

## Container image

`tools/image/` builds both apps' images (Dockerfile targets `cli` and `mcp`) from their release
tarballs (`npm pack` output), never from source: `ADD` unpacks it onto distroless Node 24 (Debian 13, `nonroot`, uid 65532), so the image
holds exactly the files npm users get. The base, BuildKit, the test registry, skopeo (local runs
only), syft and grype are pinned in `pins.json`; bump them in the deps round. A Node or Debian
security fix reaches the image only through a new base digest, so it means a patch release.

| Script | What it does |
|---|---|
| `build.mjs` | Multi-arch OCI archive (amd64, arm64), reproducible: no provenance or SBOM attestation, timestamps from `SOURCE_DATE_EPOCH` (default: the HEAD commit's time). Two builds give the same index digest; compare index digests, not files. |
| `push.mjs` | Copies the archive to a registry with skopeo (`--all --preserve-digests`) and checks the digest the registry serves. Used for the local test registry and for ghcr.io. |
| `smoke.mjs` | Runs the image read-only, without capabilities, as an arbitrary uid: `--version`, `--help`, a network error, one request to a mock upstream (`smoke.json`: `latest --max 2` against two recorded stations), and `docker stop`, which must end a waiting call with 143 in under 5 s. |
| `sbom.mjs` | One CycloneDX SBOM per platform with syft, and with `--gate true` grype over them: a fixable high or critical finding fails. Accepted findings go into `.grype.yaml` with a reason. CI only. |

Locally (colima; the scripts never read your docker config, so no credential helper is asked;
on macOS port 5000 is often taken by the AirPlay receiver, hence 5055):

```bash
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
npm pack --workspace apps/cli --pack-destination dist-artifacts
node tools/image/build.mjs --app cli --tarball dist-artifacts/<tarball>.tgz --out dist-artifacts/cli.oci.tar
docker run -d -p 127.0.0.1:5055:5000 <registry pin from pins.json>
node tools/image/push.mjs --archive dist-artifacts/cli.oci.tar --to 127.0.0.1:5055/strahlenschutz-cli:dev
node tools/image/smoke.mjs --app cli --image 127.0.0.1:5055/strahlenschutz-cli@<index digest>
```

In CI: `images.yml` does all of it on every push and weekly, with the arm64 image smoke-tested on
an arm64 runner and the vulnerability gate. In `release.yml` the job `image` builds from the
checked tarball and records the archive's digest, `image-sbom` makes the SBOMs (no gate: the
scanner's database changes daily), `attest` signs build provenance for the tarball, the archive
and the image index, and the release attaches the archive, the image SBOMs and `SHA256SUMS`.
`publish.yml` publishes the release's own files: both tarballs to npm and both archives to
`ghcr.io/maschinenlesbar-org/strahlenschutz-cli` and `…/strahlenschutz-mcp` (with the run's `GITHUB_TOKEN`), each checked
first against the immutable release (`gh release verify-asset`) and the provenance `release.yml`
signed for that tag (`gh attestation verify`).
`apps/cli/test/conformance-p32-image-pipeline.test.ts` (shared) pins these rules.

As PID 1 the bin shim listens for SIGINT, SIGTERM and SIGHUP (`exitOnSignalsAsPid1`): without
a listener the kernel drops them, and `docker stop` would wait 10 s and kill. In a container
the CLI reads the cgroup limits (`limits.ts`): under a memory limit the default
`--max-response-bytes` is an eighth of it, under a pids limit below 12 it refuses before any
request, and a leading program name (`docker run <image> strahlenschutz latest`) is dropped.

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

Every page carries a description and Open Graph tags for link previews, and the home
pages schema.org JSON-LD (`SoftwareApplication`); the preview image and the icons are the
organisation website's. `site/404.html` is this site's not-found page, in both languages.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/strahlenschutz-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
