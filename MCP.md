# strahlenschutz-mcp

An [MCP](https://modelcontextprotocol.io/) server for the ambient gamma dose rate (ODL) of the
Federal Office for Radiation Protection (Bundesamt für Strahlenschutz, BfS): the live readings of
about 1,670 [ODL-Info](https://odlinfo.bfs.de/) monitoring stations across Germany, hourly, with
about a week of history per station, as tools for AI agents. Read-only, no API key. The data is
under the Datenlizenz Deutschland – Namensnennung 2.0 (see Licence).

It is the MCP side of [strahlenschutz-cli](https://github.com/maschinenlesbar-org/strahlenschutz-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/strahlenschutz-mcp
```

This installs the **`strahlenschutz-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/strahlenschutz-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add strahlenschutz -- strahlenschutz-mcp
# or with the image:
claude mcp add strahlenschutz -- docker run -i --rm ghcr.io/maschinenlesbar-org/strahlenschutz-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "strahlenschutz": { "command": "strahlenschutz-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "strahlenschutz": { "type": "stdio", "command": "strahlenschutz-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
strahlenschutz-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http strahlenschutz http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/strahlenschutz-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/strahlenschutz-cli/releases) instead of
`latest`: `…/strahlenschutz-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/strahlenschutz-mcp:<version> --repo maschinenlesbar-org/strahlenschutz-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `getDoseSnapshot` | The network's latest readings ranked and judged against normal background, for all of Germany, a Land, around a place or a point, or in a box: the verdict, the highest (or lowest) stations with their cosmic and terrestrial parts, the stations without a value counted apart, the hour most readings are for and the older ones. |
| `getStationTrend` | One station's hourly dose rate over the newest hours (up to a week), by kenn or name: the latest value, min, max, mean, day means and a verdict (steady, rising, falling, spike) against the station's own baseline. |
| `getStationsMap` | The stations as map-ready GeoJSON points with the dose rate promoted for colour scaling and a popup text; dead sensors dropped (or kept, value null), points outside Germany left off and named; paged. |
| `findStations` | Stations with their latest reading, by a part of the name, a postal code, a kenn, a Land, a status, or nearest to a point. |
| `getTimeseries` | One station's series as published: hourly (about a week) or daily (Flensburg only), newest or oldest first, paged. |

About 120 of the stations (defekt, Testbetrieb) report no value; the server's own sort puts them
first, so the tools rank the readings themselves and say how many were skipped. Each station's
latest reading is its own newest hour, not one common hour: the snapshot says which hour most
readings are for and marks the older ones. Normal background is about 0.05–0.25 µSv/h: the
highest readings are high-altitude and granite sites, dose from the ground, normal for them; a
reading above 0.3 µSv/h is named, with what to check. A trend is judged against the station's own
baseline: a few hundredths is noise, and rain raises the dose rate for a few hours. An empty series
says whether the station id is unknown or the station has no readings (defekt). Times are UTC.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API host (default https://www.imis.bfs.de; the client adds /ogc/opendata/ows)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as, a regular file (a FIFO is
  refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 >
  mcp-token)` makes one); anything else is answered 401. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates or at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline (a tool that has read part of its answer by then may answer with that
  part, and says so). A request those limits would hold longer than it or its call may wait is not
  sent: the call fails at once, naming the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/strahlenschutz-cli/blob/main/LICENSING.md)).
Data: the Bundesamt für Strahlenschutz's, under the
[Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0)
(dl-de/by-2-0): commercial and non-commercial use, copying, distribution and modification are
allowed, provided the source is credited with the provider, the licence and its link
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/strahlenschutz-cli/blob/main/DATA_LICENSE.md)).
Every result carries that attribution ("Datenquelle: Bundesamt für Strahlenschutz (BfS), ODL-Info")
in its `licence` field, with "eigene Bearbeitung": the tools rank, summarise and judge the data.
The BfS asks that dose-rate data be presented factually; readings are hourly and partly not yet
validated. We provide the tool, not the data.
