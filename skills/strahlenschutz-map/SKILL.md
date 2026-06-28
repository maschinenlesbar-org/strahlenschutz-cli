---
name: strahlenschutz-map
description: >
  Export Germany's ambient gamma dose-rate (ODL) readings as GeoJSON for mapping,
  using the strahlenschutz-cli. Trigger when the user asks to "map the radiation
  stations", "show dose rate on a map", "export ODL as GeoJSON", "plot the
  monitoring network", "heatmap of µSv/h", or wants the BfS network as geodata for
  Leaflet / geojson.io / QGIS / Kibana. Emits a clean, styling-ready
  FeatureCollection with the dose value promoted for color scaling.
version: 1.0.0
userInvocable: true
---

# Strahlenschutz → GeoJSON Map Export

Turn the live ODL network into a **map-ready GeoJSON `FeatureCollection`** — every
station as a point carrying its dose rate, ready to color-scale in geojson.io,
Leaflet, QGIS, or Kibana.

## Tooling

This skill drives the `strahlenschutz` command. **Before anything else, validate it is available** — run `command -v strahlenschutz` (or `strahlenschutz --version`). If it is not on your PATH, STOP and inform the user that the `strahlenschutz` CLI (`@maschinenlesbar.org/strahlenschutz-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The CLI is read-only, **no API key**. Always `--compact`.

## Step 1 — Fetch

The CLI **already emits GeoJSON** — that is the good news. For the whole network:

```bash
strahlenschutz --compact latest > stations.geojson
```

For one station or a sample, use `latest --station <kenn>` or `--max <n>`.
`geometry.coordinates` is already `[lon, lat]` (RFC 7946 order) and `crs` is
EPSG:4326 — so unlike many APIs there is **no coordinate flipping to do**.

## Step 2 — Clean and promote the dose value for styling

The raw output is valid GeoJSON, but for a usable map layer do two things:

1. **Decide what to do with dead stations.** ~90 of ~1700 features have
   `value: null` (`defekt` / `Testbetrieb`). For a dose heatmap, drop them (a null
   value breaks color ramps); for a network-coverage map, keep them but style them
   grey. State which you did.
2. **Surface the value at the top of `properties`** so tools can color by it. Many
   map UIs scale on a numeric property — keep `value` (µSv/h) prominent and add a
   readable `popup`.

```bash
strahlenschutz --compact latest \
  | jq '{
      type: "FeatureCollection",
      features: [ .features[]
        | select(.properties.value != null)        # drop dead sensors for a heatmap
        | {
            type: "Feature",
            geometry: .geometry,                    # already [lon, lat], EPSG:4326
            properties: {
              kenn: .properties.kenn,
              name: .properties.name,
              plz: .properties.plz,
              value: .properties.value,             # µSv/h — color-scale on this
              unit: .properties.unit,
              site_status_text: .properties.site_status_text,
              end_measure: .properties.end_measure,
              height_above_sea: .properties.height_above_sea,
              popup: "\(.properties.name): \(.properties.value) µSv/h"
            }
          } ]
    }' > odl.geojson
```

Notes:
- Keep `geometry` as-is — don't rebuild coordinates; they're correct already.
- `value` is the field to color on; the meaningful range is ~0.05–0.20 µSv/h, so a
  color ramp clamped to roughly that span reads best (a 0–1 default ramp makes every
  station look identical).
- A `timeseries` export is single-point (one station, many timesteps at the same
  coordinate) — not useful as a map; steer those to the **strahlenschutz-station-trend**
  skill instead.

## Step 3 — Output

Write the FeatureCollection to a file the user can open (default `./odl.geojson`) and
report **the path you wrote**, the feature count, and how many null/defekt stations were
dropped or greyed. If a name the user supplied already exists, confirm before overwriting it
(re-running with the default name to refresh is fine). Offer to:
- open it at https://geojson.io (drag the file in), or
- pretty-print vs compact — the full network is ~1600 features, fine for a layer but
  large to paste inline.

Validity checklist before handing it over:
- it parses as a single `FeatureCollection`;
- coordinates are `[lon, lat]` numbers (the API already gives this — don't flip them);
- the dose value is a numeric `value` property in µSv/h, and you said whether dead
  sensors were dropped or kept.

## Known data gap

- The `ts-24h` (daily) feature type is empty upstream, so daily map snapshots aren't
  available; map the hourly `latest` instead.
