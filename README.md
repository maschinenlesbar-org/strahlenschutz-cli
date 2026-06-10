# strahlenschutz-cli

[![CI](https://github.com/maschinenlesbar-org/strahlenschutz-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/strahlenschutz-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/strahlenschutz-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/strahlenschutz-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/strahlenschutz-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/strahlenschutz-cli)

Query Germany's **ambient gamma dose-rate (ODL) monitoring network** from your
terminal. `strahlenschutz` is a command-line tool over the open
[BfS ODL-Info](https://odlinfo.bfs.de/) WFS (`imis.bfs.de`): fetch the latest
readings across all ~1 700 stations, look up a single station by its `kenn` id,
or pull hourly/daily time series — all as clean GeoJSON you can pipe straight
into [`jq`](https://jqlang.github.io/jq/).

- **Works out of the box** — no account, no API key, no configuration. Install and query.
- **Clean GeoJSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Three commands** — `latest`, `station`, and `timeseries`.
- **Real open data** — backed by the Bundesamt für Strahlenschutz's public IMIS network.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/strahlenschutz-cli
```

This installs the **`strahlenschutz`** command. Requires **Node.js 20+**.

Check it works:

```bash
strahlenschutz --help
```

## Quickstart

No setup needed — the ODL-Info service is open data and requires no key. Your
first command:

```bash
strahlenschutz latest --max 5
```

That prints a GeoJSON `FeatureCollection` with the five most recent station
readings. Dose-rate values are in **µSv/h** and live in each feature's
`properties`. Pull out a station's id and value with `jq`:

```bash
strahlenschutz --compact latest --max 5 \
  | jq -r '.features[] | [.properties.kenn, .properties.value] | @tsv'
```

Look up a single station you already know:

```bash
strahlenschutz station 091811461
```

## Commands

```text
latest                 latest ODL reading per station (GeoJSON FeatureCollection)
station <kenn>         latest reading for one station
timeseries <kenn>      hourly or daily time series for a station
```

### `latest` options

| Flag | Meaning |
| --- | --- |
| `--station <kenn>` | restrict to one station by its numeric `kenn` id |
| `--max <n>` | max features to return (WFS `count`) |
| `--start <n>` | paging offset (use together with `--max`) |
| `--sort <prop>` | sort by a feature property; append ` D` for descending, e.g. `"end_measure D"` |

### `station` arguments

| Argument | Meaning |
| --- | --- |
| `<kenn>` | numeric station id — must be digits only, non-empty |

No per-command options. An unknown `kenn` exits with code **4**.

### `timeseries` options

| Flag | Meaning |
| --- | --- |
| `--resolution ts-1h\|ts-24h` | hourly (default) or daily-averaged series |
| `--max <n>` | max features to return |
| `--start <n>` | paging offset |
| `--sort <prop>` | sort by a feature property |

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Latest reading for every station (the full network)
strahlenschutz latest

# Sample 5 readings for a quick look
strahlenschutz latest --max 5

# One station you care about
strahlenschutz station 091811461

# Hourly time series — last 24 hours of readings
strahlenschutz timeseries 091811461 --max 24

# Daily time series for a longer-term view
strahlenschutz timeseries 091811461 --resolution ts-24h

# Page through the network (most-recent first, 10 at a time)
strahlenschutz latest --sort "end_measure D" --max 10 --start 0
strahlenschutz latest --sort "end_measure D" --max 10 --start 10
```

## Output & scripting

Every command prints **pretty GeoJSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

```bash
# Extract dose rate and station id from a single-station lookup
strahlenschutz --compact station 091811461 \
  | jq '.features[0].properties | {kenn, value}'

# Flat TSV table of all stations — kenn and µSv/h value
strahlenschutz --compact latest \
  | jq -r '.features[] | [.properties.kenn, .properties.value] | @tsv'

# Plot-ready CSV: timestamp + value for the hourly series
strahlenschutz --compact timeseries 091811461 --max 48 \
  | jq -r '.features[] | [.properties.end_measure, .properties.value] | @csv'
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
strahlenschutz --compact latest --max 5
```

`--compact` (and every global option) works **before or after** the command —
both `strahlenschutz --compact latest …` and `strahlenschutz latest … --compact`
do the same thing.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `1` | error — API error, network failure, parse error, or any other problem |
| `4` | station not found — the `kenn` returned no features (WFS always returns 200 with an empty collection for unknown ids) |
| non-zero | usage / argument-validation error (bad flag or argument) |

## Troubleshooting

- **`command not found: strahlenschutz`** — the global npm bin directory isn't on
  your `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/strahlenschutz-cli …`.
- **Exit `4` / "No station found for kenn …"** — the `kenn` doesn't exist in the
  network. Re-check the id from a fresh `latest` result; the WFS always returns
  HTTP 200 with an empty collection for an unknown station rather than a 404.
- **Non-numeric `kenn` rejected immediately** — `kenn` must be digits only. The
  client validates this before making any request; no request is sent.
- **Exit `1` / network error** — connectivity, DNS, or a timeout. Try again, or
  raise the limit with `--timeout 60000`.
- **Unexpectedly large response** — raise or remove the cap with
  `--max-response-bytes 0` (unlimited).

## Global options

These apply to every command and may be given **before or after** the command:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://www.imis.bfs.de`) |
| `--timeout <ms>` | Per-request timeout in milliseconds (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — domain terms, station identifiers, WFS concepts, exit codes.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.
- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills bundled with this repo (dose-rate
  snapshot, station trend, GeoJSON export), installable as a plugin.

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
