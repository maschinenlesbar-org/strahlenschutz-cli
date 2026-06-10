---
name: strahlenschutz-dose-snapshot
description: >
  Produce a ranked snapshot of Germany's live ambient gamma dose rate (ODL) from
  the strahlenschutz-cli. Trigger when the user asks "what's the radiation right
  now in Germany?", "highest dose-rate stations", "is radiation elevated near
  <place>?", "current ODL readings", "any stations above background?", or wants
  the network ranked / filtered to a region. Pulls all ~1700 stations, drops
  dead/null sensors, ranks by µSv/h, can geo-filter to an area, and judges each
  value against normal background.
version: 1.0.0
userInvocable: true
---

# Strahlenschutz Dose-Rate Snapshot

Turn the raw network dump into a **ranked, judged snapshot** of the current ambient
gamma dose rate across Germany — highest/lowest stations, optionally limited to a
region, with each value put in context against normal background. The whole point of
this skill is the filtering, ranking, and judgement the CLI deliberately doesn't do.

## Tooling

This skill drives the `strahlenschutz` command. **Before anything else, validate it is available** — run `command -v strahlenschutz` (or `strahlenschutz --version`). If it is not on your PATH, STOP and inform the user that the `strahlenschutz` CLI (`@maschinenlesbar.org/strahlenschutz-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The CLI is read-only, **no API key**, backed by the BfS ODL-Info WFS. Always pass `--compact` so the output is one line you can pipe into `jq` / a script. Every command prints a GeoJSON `FeatureCollection` to **stdout**; errors go to stderr.

## Step 1 — Pull the network

The whole network in one call (≈1700 features, large but fine):

```bash
strahlenschutz --compact latest
```

For a quick look, cap with `--max 5`. To restrict to one station you already know,
use `latest --station <kenn>` (or the dedicated `station <kenn>`).

Each feature has `geometry.coordinates` = `[lon, lat]` and a `properties` object:

| Field | Meaning |
|---|---|
| `kenn` | numeric station id (e.g. `064380031`) — the key for follow-up lookups |
| `id` | BfS station code (e.g. `DEZ0821`) |
| `name` | town / site name (e.g. `Egelsbach`) |
| `plz` | postal code |
| `value` | **ambient gamma dose rate in µSv/h** — the headline number. Can be `null` |
| `value_cosmic` / `value_terrestrial` | the cosmic vs ground contributions (sum ≈ `value`) |
| `unit` | always `µSv/h` |
| `site_status` / `site_status_text` | `1`/`in Betrieb`, `2`/`defekt`, `3`/`Testbetrieb` |
| `validated` | `1` if the reading is validated, else `null` |
| `start_measure` / `end_measure` | ISO window of the reading (UTC, `Z`) |
| `height_above_sea` | metres — elevation drives terrestrial dose, useful context |
| `nuclide` | `Gamma-ODL-Brutto` (gross gamma) |

## Step 2 — Drop the dead sensors FIRST (the big trap)

About **90 of the ~1700 stations report `value: null`** — they are `defekt` or in
`Testbetrieb`. **Server-side `--sort "value D"` sorts these nulls to the TOP**, so a
naive "top by value" is wrong and lists broken stations. Never trust the server sort
for a max/min ranking. Filter client-side instead:

```bash
strahlenschutz --compact latest \
  | jq -r '.features
           | map(.properties | select(.value != null))
           | sort_by(.value) | reverse
           | .[:10][]
           | [.kenn, .name, .value, .site_status_text] | @tsv'
```

Only keep `value != null` (equivalently `site_status == 1` / `in Betrieb`). For a
"lowest" ranking drop the `reverse`.

## Step 3 — (Optional) geo-filter to a region

The CLI has **no bbox / radius parameter** — geo filtering is on you, using
`geometry.coordinates` (`[lon, lat]`). If the user named a place ("near Munich",
"in Bavaria", "around 48.1,11.5"):

- Build a rough bounding box (or radius) from the place's lat/lon and keep only
  features whose `coordinates` fall inside it. Example with jq for a box:

  ```bash
  strahlenschutz --compact latest \
    | jq --argjson w 11.3 --argjson e 11.7 --argjson s 48.0 --argjson n 48.3 '
        .features
        | map(select(.geometry.coordinates[0] >= $w and .geometry.coordinates[0] <= $e
                 and .geometry.coordinates[1] >= $s and .geometry.coordinates[1] <= $n))
        | map(.properties | select(.value != null))
        | sort_by(.value) | reverse'
  ```

- If you don't have coordinates for the place and can't get them cheaply, say you're
  reporting the **whole country** rather than silently guessing a region.

## Step 4 — Judge the numbers (don't just list them)

Put each value in context — this is a radiation-protection tool, the headline is
"is anything wrong?", not a bare table.

- **Normal background is roughly 0.05–0.20 µSv/h.** Across the network the highest
  *real* readings are typically ~0.2 µSv/h, at high-elevation / granite sites
  (more terrestrial + cosmic dose) — that is **normal**, not an alarm.
- A genuinely elevated reading would be well above ~0.3 µSv/h and stand out sharply
  from neighbours. If everything is ≤0.25, say plainly: **all stations at normal
  background, nothing elevated.**
- Use `value_cosmic` / `value_terrestrial` and `height_above_sea` to explain why a
  "high" station is high (it's almost always altitude/geology, not contamination).
- Don't invent alarm the data doesn't support. ODL-Info is a public-reassurance
  network; over-stating a 0.2 µSv/h mountain station as dangerous is a real harm.

## Step 5 — Report

Lead with a verdict, then a short ranked table, then context:

```
German ODL network — 1682 stations, 1589 reporting (93 defekt / Testbetrieb, skipped)
Verdict: ✓ all readings at normal background (max 0.215 µSv/h). Nothing elevated.

Highest current dose rate (µSv/h):
  0.215  Herrischried OT Großherrischwand  (083370490)  in Betrieb
  0.203  Haidmühle                         (092721221)  in Betrieb
  0.199  Gehlberg                          (160700171)  in Betrieb
  … high values are high-elevation / granite sites — normal terrestrial+cosmic dose.
```

Rules:
- Always state how many stations were **skipped as null/defekt** — silently dropping
  ~90 stations is misleading.
- Show `kenn` next to each station so the user can drill in with the
  **strahlenschutz-station-trend** skill (`timeseries <kenn>`).
- Give units (`µSv/h`) and the measurement time window (`end_measure`); these readings
  are hourly snapshots, not live-streaming.
- Offer a map (`strahlenschutz-map` skill) or a per-station trend as the next step.
