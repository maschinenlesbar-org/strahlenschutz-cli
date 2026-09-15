# Examples

Real examples for the Claude Code skills of the `strahlenschutz` plugin, one per skill: a request,
the `strahlenschutz` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `strahlenschutz` 0.0.6.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [strahlenschutz-dose-snapshot](#strahlenschutz-dose-snapshot) · [strahlenschutz-map](#strahlenschutz-map) · [strahlenschutz-station-trend](#strahlenschutz-station-trend)

## strahlenschutz-dose-snapshot

> What's the radiation like in Germany right now? Is any station above background?

```bash
strahlenschutz --compact latest
strahlenschutz --compact latest --sort "value D" --max 3     # server sort: 3 defekt stations with value null come first
```

The skill ranked the stations itself and did not use the server sort. The server sort puts
dead sensors first. Not every station's "latest" reading is from the same hour, so the
snapshot says which hours the readings come from.

```
German ODL network: 1676 stations, 1580 reporting (83 defekt + 13 Testbetrieb with no value, skipped)
Verdict: all readings at normal background (max 0.231 µSv/h). Nothing elevated.
Readings: 1492 stations for the hour ending 2026-09-15T15:00Z, 77 for 14:00Z,
          11 older (back to 03:00Z).

Highest current dose rate (µSv/h):
  0.231  Herrischried OT Großherrischwand  (083370490)  850 m  terrestrial 0.177 + cosmic 0.054
  0.204  Alpirsbach                        (082370020)  440 m  terrestrial 0.156 + cosmic 0.048
  0.203  Haidmühle                         (092721221)  833 m  terrestrial 0.149 + cosmic 0.054
  0.197  Gehlberg                          (160700171)  943 m  terrestrial 0.141 + cosmic 0.056
  0.196  Niedermurach - OT Pertolzhofen    (093761481)  405 m  (hour ending 14:00Z)
  … 1575 more
Lowest: 0.044 FINO 1 - Forschungsplattform (010020003), 0.05 FINO 2 - Forschungsplattform (010020004).
The top stations are high because of dose from the ground (terrestrial): the cosmic
share is about 0.05 µSv/h at all of them. This is local geology and altitude, not
contamination.
```

Next steps offered: the hourly trend for a station (e.g. `timeseries 083370490`) or a GeoJSON map.

## strahlenschutz-map

> Put the current dose-rate readings on a map. I want a GeoJSON file I can drop into geojson.io.

```bash
strahlenschutz --compact latest | jq '{type: "FeatureCollection", features: [ .features[] | select(.properties.value != null) | {…kenn, name, plz, value, unit, site_status_text, end_measure, height_above_sea, popup} ]}' > odl.geojson
```

No `odl.geojson` existed yet, so the skill wrote the default name without asking. The skill
built a heatmap layer, so stations without a value were dropped. The coordinates were
already `[lon, lat]` and were left unchanged.

```
Wrote odl.geojson (779 KB): one FeatureCollection with 1580 points.
  Dropped: 96 stations with value null (83 defekt, 13 Testbetrieb).
  Colour on: value (µSv/h); range in this file 0.044–0.231. Clamp the ramp to about
             0.05–0.20, or every point looks the same.
  Properties: kenn, name, plz, value, unit, site_status_text, end_measure,
              height_above_sea, popup ("Diemelsee OT Adorf: 0.123 µSv/h")
  Checks: parses as a FeatureCollection; all coordinates and values numeric;
          lon 6.02–15.03, lat 47.40–55.02 (EPSG:4326). The API rounds coordinates to 0.01°.
```

Next steps offered: open it at https://geojson.io, or a coverage variant that keeps the 96 dead stations greyed out.

## strahlenschutz-station-trend

> Herrischried has the highest reading in Germany today. Has it been rising this week?

```bash
strahlenschutz --compact latest | jq -r '.features[] | [.properties.kenn, .properties.name, .properties.plz] | @tsv' | grep -i "herrischried"
strahlenschutz --compact timeseries 083370490 --sort "end_measure D" --max 48
strahlenschutz --compact timeseries 083370490                              # whole week: 168 h, oldest first
strahlenschutz --compact timeseries 083370490 --resolution ts-24h         # native daily series: 0 features
```

"Herrischried" matched one station, kenn `083370490` (PLZ 79737). The native daily series was
empty, so the skill computed daily means from the hourly steps. None of the 168 steps was
null.

```
Herrischried OT Großherrischwand (kenn 083370490), hourly ODL snapshots
  latest: 0.231 µSv/h at 2026-09-15T15:00Z   (validated)
  48 h:   0.227 – 0.237   mean 0.231
  week:   2026-09-08T16:00Z → 2026-09-15T15:00Z, daily means 0.227 – 0.232
          one short bump: 0.264 at 2026-09-08T21:00Z, back to 0.235 by 23:00Z
  Verdict: flat, no rising trend. The value varies by about 0.01 µSv/h from hour to hour.
           It stays slightly above the usual 0.05–0.20 band all week. That is this
           station's normal level (850 m, mostly terrestrial dose), not a change. The
           8 Sep bump lasted two hours, the kind of short rise rain can cause.
```

Next steps offered: a CSV of `end_measure,value` for charting (ascending by time).
