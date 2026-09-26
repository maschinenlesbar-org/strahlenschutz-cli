# Usage

Real, use-case-driven examples for the `strahlenschutz` CLI — a command-line
client for the open **BfS ODL-Info** radiation API (`imis.bfs.de`), Germany's
ambient gamma dose-rate (ODL) measurement network. Every response is a GeoJSON
`FeatureCollection`; dose-rate values are in **µSv/h** and stations are
identified by their numeric **`kenn`** id.

## Install

```bash
npm i -g @maschinenlesbar.org/strahlenschutz-cli
```

This installs the **`strahlenschutz`** bin. Without a global install you can run
the same commands via `node dist/src/cli/index.js …` after `npm run build`.

Verify:

```bash
strahlenschutz --version
strahlenschutz --help
```

The CLI has three commands: `latest`, `station`, and `timeseries`. The examples
below pipe through [`jq`](https://jqlang.github.io/jq/) where it helps — `jq` is
optional and not required by the CLI.

## Use cases

### 1. Latest dose rate across all stations

Get a snapshot of the whole network's most recent readings.

```bash
strahlenschutz latest
```

Prints a pretty-printed GeoJSON `FeatureCollection`, one feature per station. Add
`--compact` (a global option, before the command) for single-line JSON suitable
for piping:

```bash
strahlenschutz --compact latest
```

### 2. Sample just the first few readings

Avoid pulling the entire network when you only want a quick look.

```bash
strahlenschutz latest --max 5
```

`--max` caps the number of features returned (the WFS `count` parameter).

### 3. Latest reading for one station by its kenn

Check a single station you care about.

```bash
strahlenschutz station 091811461
```

If the `kenn` does not exist the WFS returns an empty collection; the CLI
surfaces that as a not-found error and exits with code **4**. A non-numeric
`kenn` is rejected before any request is made.

Only `station` does this check. `latest --station <kenn>` and
`timeseries <kenn>` print the empty collection and exit `0` for an unknown id,
the same as for a real station without readings (e.g. a `defekt` one). If they
come back empty, run `station <kenn>` to find out which it is.

You can also restrict the `latest` command to one station instead of using the
dedicated `station` command:

```bash
strahlenschutz latest --station 091811461
```

### 4. Pull the dose-rate value out for scripting

Extract just the µSv/h value and station id rather than the full GeoJSON.

```bash
strahlenschutz --compact station 091811461 \
  | jq '.features[0].properties | {kenn, value}'
```

The `value` field carries the ambient gamma dose rate in µSv/h; `kenn` is the
station id. Combine with `latest` to build a flat table of all stations:

```bash
strahlenschutz --compact latest \
  | jq -r '.features[] | [.properties.kenn, .properties.value] | @tsv'
```

### 5. Find the stations with the highest current dose rate

Sort the network by reading to spot the busiest sites.

```bash
strahlenschutz --compact latest \
  | jq -r '.features
           | sort_by(.properties.value) | reverse
           | .[:10][]
           | [.properties.kenn, .properties.value] | @tsv'
```

You can also ask the WFS to sort server-side and page through results:

```bash
# Page through the network in a stable order (by station id), 10 at a time
strahlenschutz latest --sort kenn --max 10
strahlenschutz latest --sort kenn --max 10 --start 10
```

Page on a unique key such as `kenn`. Many stations share the same `end_measure`
(the same hour), so a sort on it alone leaves the order within that hour open,
and a station can move between pages; add `kenn` as a tie-breaker
(`--sort "end_measure D,kenn"`). A **descending** sort also lists the stations
without a reading first: the WFS sorts `null` highest, so `"end_measure D"` and
`"value D"` start with the roughly 90 `defekt` / `Testbetrieb` stations whose
`end_measure` and `value` are `null`. For a ranking, sort client-side as above.

`--sort <prop>` sorts by a feature property; append a space and `D` (i.e.
`"<prop> D"`, quoted) for descending, and separate several keys with commas
(`"end_measure D,kenn"`). `--start` is the paging offset; without `--max` you
get everything from that offset on. The service can only
page a sorted result, so without `--sort` the CLI sorts by `kenn` (`latest`) or
`kenn,end_measure` (`timeseries`, oldest first).

### 6. Hourly time series for a station (last hours of ODL)

Inspect short-term trend for one station — the default resolution is hourly.

```bash
strahlenschutz timeseries 091811461
```

This is equivalent to `--resolution ts-1h`. The series covers about a week and
comes back **oldest first**, so `--max` alone gives the *oldest* hours. For the
latest 24 hours, sort newest first and cap the window with `--max`:

```bash
strahlenschutz timeseries 091811461 --sort "end_measure D" --max 24
```

### 7. Daily (24h-averaged) time series

Look at the longer-term daily-averaged trend instead of hourly noise.

```bash
strahlenschutz timeseries 010010001 --resolution ts-24h --sort "end_measure D" --max 30
```

The daily layer currently holds a series for **one station only**, Flensburg
(`010010001`: 364 daily values, checked 26 Sep 2026). Every other station returns
an empty collection with `ts-24h`; for them, average the hourly series per day.

Only `ts-1h` and `ts-24h` are accepted for `--resolution`; anything else is
rejected with a clear error.

### 8. Plot-ready time series extract

Reduce the hourly series to a time/value list a chart tool can read.

```bash
strahlenschutz --compact timeseries 091811461 --resolution ts-1h --sort "end_measure D" --max 48 \
  | jq -r '.features | reverse[] | [.properties.end_measure, .properties.value] | @csv'
```

`end_measure` is the timestamp of each reading; `value` is the µSv/h dose rate.
`--sort "end_measure D" --max 48` picks the latest 48 hours, and `reverse` puts
them back in time order for the chart.

### 9. Run against a custom endpoint or with a longer timeout

Useful behind a mirror/proxy, or on a slow connection.

```bash
strahlenschutz --base-url https://www.imis.bfs.de \
               --timeout 60000 \
               --user-agent "my-monitor/1.0" \
               latest --max 5
```

`--base-url` overrides the API host (an `http(s)` URL, optionally with a path
prefix; a `?query` or `#fragment` is refused, since the WFS path is appended to
it), `--timeout` sets the time limit per request in
milliseconds (reading the whole response included), and `--user-agent` sets the request `User-Agent`.

### 10. Robust automation: retries and a response-size cap

Harden an unattended/cron run against transient API hiccups and runaway bodies.

```bash
strahlenschutz --max-retries 4 --max-response-bytes 52428800 --compact latest
```

Transient `429`/`503` responses are retried up to `--max-retries` times (`0`–`10`),
each after the server's `Retry-After` (up to 30 s; a longer one is reported at
once), or else after 200 ms, 400 ms, …;
`--max-response-bytes` aborts responses larger than the given size (`0` =
unlimited). Exit codes: `0` success, `4` on a not-found station (`station`
only), `1` for any other error, and a non-zero code for usage errors.

## Global options recap

Global options go **before** the command (e.g. `strahlenschutz --compact latest --max 5`):

| Option | Description |
| --- | --- |
| `-V, --version` | print the version |
| `--base-url <url>` | API base URL (default `https://www.imis.bfs.de`) |
| `--timeout <ms>` | time limit per request in milliseconds, whole response included (at most `2147483647`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | retries for transient `429`/`503` responses (`0`–`10`, default `2`; each waits the server's `Retry-After`, up to 30 s) |
| `--max-response-bytes <n>` | cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line instead of pretty-printed |
| `-h, --help` | display help (works on any command) |

Per-command options:

- `latest` — `--station <kenn>`, `--max <n>`, `--start <n>`, `--sort <prop>`
- `station <kenn>` — (no options)
- `timeseries <kenn>` — `--resolution ts-1h|ts-24h` (default `ts-1h`), `--max <n>`, `--start <n>`, `--sort <prop>`
