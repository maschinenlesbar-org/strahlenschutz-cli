# strahlenschutz-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for live
German radiation monitoring, all powered by the **[strahlenschutz](README.md)** CLI over
the open [BfS ODL-Info](https://odlinfo.bfs.de/) WFS (`imis.bfs.de`) — the Bundesamt für
Strahlenschutz's national ambient gamma dose-rate (ODL) network of ~1700 stations.

Each skill teaches Claude how to drive the `strahlenschutz` CLI to answer a specific,
real-world question — "is radiation elevated anywhere right now?", "how has the dose rate
trended at this station?", "give me the network as GeoJSON" — and to report the answer with
evidence and proper context rather than guesswork. They encode the parts that are easy to
get wrong (null/defekt sensors poisoning a ranking, the oldest-first time series, the empty
daily series) and the judgement a bare CLI can't add (what counts as *normal background*).

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **strahlenschutz-dose-snapshot** | Pulls all ~1700 stations, drops dead/null sensors, ranks by µSv/h, can geo-filter to a region, and judges each value against normal background. | "what's the radiation in Germany now?", "highest dose-rate stations", "is it elevated near Munich?" |
| **strahlenschutz-station-trend** | Pulls one station's hourly series newest-first, summarises min/max/mean, and flags any real departure from baseline. | "trend for kenn 064380031", "is the dose rate rising at Egelsbach?", "plot the last day" |
| **strahlenschutz-map** | Exports the network as a valid GeoJSON `FeatureCollection` with the dose value promoted for color scaling — for Leaflet / geojson.io / QGIS. | "map the radiation stations", "export ODL as GeoJSON", "heatmap of µSv/h" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `strahlenschutz` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/strahlenschutz-cli   # installs the `strahlenschutz` bin
  ```
  No API key is required — the BfS ODL-Info WFS is free, open, and read-only.
- **[`jq`](https://jqlang.github.io/jq/)** is recommended; the skills use it to filter and
  rank the GeoJSON, but it is not required by the CLI itself.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/strahlenschutz-cli
/plugin install strahlenschutz@strahlenschutz-skills
```

The first command registers the marketplace; the second installs the `strahlenschutz`
plugin, which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/strahlenschutz-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/strahlenschutz-dose-snapshot/SKILL.md`. Start a new Claude Code session and the
skills are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Is the ambient radiation elevated anywhere in Germany right now?

> Show me the trend for the Egelsbach station over the last day.

> Export the whole ODL network as GeoJSON so I can open it in geojson.io.

You can also invoke a skill explicitly with its slash command, e.g.
`/strahlenschutz-dose-snapshot`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`strahlenschutz` subcommands to call, in what order, and how to interpret the GeoJSON. The
skills encode the non-obvious parts of this API, for example:

- about **90 of the ~1700 stations report `value: null`** (`defekt` / `Testbetrieb`), and
  server-side `--sort "value D"` sorts those nulls to the **top** — so any "highest dose"
  ranking must filter `value != null` client-side first (see
  **strahlenschutz-dose-snapshot**);
- the hourly time series comes back **oldest-first**, so a bare `--max 24` returns the
  *oldest* 24 hours; use `--sort "end_measure D"` to get the latest window (see
  **strahlenschutz-station-trend**);
- the **`ts-24h` daily series is empty upstream** on every station tested — derive a daily
  view by averaging the hourly series rather than reporting "no data";
- the CLI has **no bbox/radius parameter**, so geo-filtering to a region is done
  client-side on `geometry.coordinates` (already `[lon, lat]`, EPSG:4326 — no flipping);
- a lookup for an unknown `kenn` exits **4** ("No station found"); a non-numeric `kenn`
  is rejected before any request with exit **1**;
- "high" stations (~0.2 µSv/h) are almost always high-elevation / granite sites — that is
  **normal background**, not an alarm; the skills judge values against ~0.05–0.20 µSv/h and
  avoid over-stating a public-reassurance network's readings.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
