---
name: strahlenschutz-station-trend
description: >
  Analyse the dose-rate trend for one BfS monitoring station over time using the
  strahlenschutz-cli. Trigger when the user asks "how has radiation changed at
  station X?", "is the dose rate rising near a place?", "plot the ODL for the last
  day/week", "trend for a kenn id", "any spike at this station?", or wants a time
  series rather than a single reading. Pulls the hourly series newest-first,
  summarises min/max/mean, and flags any departure from the station's baseline.
version: 1.0.0
userInvocable: true
---

# Strahlenschutz Station Trend

Turn a station's raw time series into a **trend read**: recent values, min / max /
mean, and whether the dose rate is steady, rising, or spiking versus its own
baseline — not the unordered JSON the CLI returns.

## Tooling

This skill drives the `strahlenschutz` command. **Before anything else, validate it is available** — run `command -v strahlenschutz` (or `strahlenschutz --version`). If it is not on your PATH, STOP and inform the user that the `strahlenschutz` CLI (`@maschinenlesbar.org/strahlenschutz-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The CLI is read-only, **no API key**. Always `--compact`. Output is a GeoJSON `FeatureCollection`, one feature per timestep.

## Step 1 — Resolve the station id (`kenn`)

`timeseries` needs a numeric **`kenn`**. If the user gave a place name, not an id,
first find the station via the network snapshot and pick by `name` / proximity:

```bash
strahlenschutz --compact latest \
  | jq -r '.features[] | [.properties.kenn, .properties.name, .properties.plz] | @tsv' \
  | grep -i "<place>"
```

`kenn` must be **digits only**; a non-numeric id is rejected before any request
(exit `1`). An id that doesn't exist returns exit `4` ("No station found") — re-check
it from a fresh `latest`.

## Step 2 — Pull the series, NEWEST FIRST (the ordering trap)

The hourly series is the default and the only one with data (see the ts-24h note
below). **It comes back oldest-first**, so a bare `--max 24` gives you the *oldest*
24 hours, not the latest. To get the most recent window, sort descending on
`end_measure`:

```bash
strahlenschutz --compact timeseries <kenn> --sort "end_measure D" --max 48
```

- Default resolution is `ts-1h` (hourly). The full series is ~1 week (~167 points).
- `--max` caps the window; `--start` pages. For a longer pull, raise `--max`.
- **`--resolution ts-24h` currently returns an empty collection for every station
  tested** — the daily-averaged series is dormant upstream. If a user asks for a
  daily view, fetch `ts-1h` and average it yourself per day, and say the native
  daily series is empty rather than reporting "no data".

Each feature's `properties`:

| Field | Meaning |
|---|---|
| `kenn` / `name` | station id and site |
| `value` | ambient gamma dose rate, **µSv/h** — the series value |
| `unit` | `µSv/h` |
| `start_measure` / `end_measure` | ISO (UTC `Z`) window of each hourly step |
| `validated` | `1` if validated |
| `duration` | `1h` |

(The hourly series carries fewer fields than `latest` — no `value_cosmic` /
`value_terrestrial` / `site_status` split.)

## Step 3 — Summarise and judge the trend

Compute over the window:

```bash
strahlenschutz --compact timeseries <kenn> --sort "end_measure D" --max 48 \
  | jq -r '[.features[].properties.value] as $v
           | "n=\($v|length) min=\($v|min) max=\($v|max) mean=\(($v|add)/($v|length))"'
```

Then read it:

- **Steady** if max−min is small (hourly ODL normally wobbles only a few hundredths
  of a µSv/h around a flat baseline of ~0.05–0.20 µSv/h).
- **Rising / spike** only if the most recent values sit clearly above the prior
  baseline (e.g. a sustained jump well beyond the window's normal scatter). Rain can
  cause small, transient bumps in terrestrial dose — note that as a benign cause.
- Drop or flag any `value: null` step (gaps happen) so they don't skew min/mean.
- A few hundredths of a µSv/h is **noise, not a trend**. Don't manufacture alarm; this
  is a public-reassurance network and most "spikes" are weather or sensor noise.

## Step 4 — Report

```
Egelsbach (kenn 064380031) — hourly ODL, last 48 h
  latest: 0.108 µSv/h at 2026-06-10T21:00Z   (validated)
  range:  0.106 – 0.110   mean 0.108
  Verdict: ✓ flat at normal background, no rising trend.
```

Rules:
- Lead with the **latest** value + its timestamp, then the range/mean, then a verdict.
- Always give units and timestamps (UTC); say the cadence is hourly snapshots.
- For a chart, offer a CSV extract:
  `… | jq -r '.features[] | [.properties.end_measure, .properties.value] | @csv'`
  (sort ascending by time for plotting — drop the `D` or reverse).
- Put any "high" reading in context against ~0.05–0.20 µSv/h background; explain
  benign causes (elevation, rain) before suggesting anything unusual.
