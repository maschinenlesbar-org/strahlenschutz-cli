# Examples

Real examples for the Claude Code skills of the `strahlenschutz` plugin, one per skill: a request,
the `strahlenschutz` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 (around 00:00 UTC) with `strahlenschutz`
0.3.0. The data changes, so your results will differ; the ids and keys shown work for trying the
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
German ODL network: 1677 stations, 1589 reporting (78 defekt + 10 Testbetrieb with no value, skipped)
Verdict: all readings at normal background (max 0.237 µSv/h). Nothing elevated.
Readings: 1501 stations for the hour ending 2026-10-05T23:00Z, 78 for 22:00Z,
          10 older (back to 2026-10-04T01:00Z: Rheinmünster OT Greffern, 082160630).

Highest current dose rate (µSv/h), all for the hour ending 23:00Z:
  0.237  Herrischried OT Großherrischwand  (083370490)  850 m  terrestrial 0.183 + cosmic 0.054
  0.218  Haidmühle                         (092721221)  833 m  terrestrial 0.164 + cosmic 0.054
  0.217  Niedermurach - OT Pertolzhofen    (093761481)  405 m  terrestrial 0.169 + cosmic 0.048
  0.209  Bernhardswald                     (093751192)  454 m  terrestrial 0.161 + cosmic 0.048
  0.207  Alpirsbach                        (082370020)  440 m  terrestrial 0.159 + cosmic 0.048
  … 1584 more
Lowest: 0.045 FINO 1 - Forschungsplattform (010020003), 0.054 FINO 2 - Forschungsplattform (010020004).
The top stations are high because of dose from the ground (terrestrial): the cosmic
share is about 0.05 µSv/h at all of them. This is local geology and altitude, not
contamination.
```

Next steps offered: the hourly trend for a station (e.g. `timeseries 083370490`) or a GeoJSON map.

## strahlenschutz-map

> Put the current dose-rate readings on a map. I want a GeoJSON file I can drop into geojson.io.

```bash
strahlenschutz --compact latest | jq '{type: "FeatureCollection", features: [ .features[] | select(.properties.value != null) | select(.geometry.coordinates | …inside lon 5.5–15.5, lat 47–55.5) | {…kenn, name, plz, value, unit, site_status_text, end_measure, height_above_sea, popup} ]}' > odl.geojson
strahlenschutz --compact latest | jq -r '.features[] | select(…outside the box) | [kenn, name, site_status_text, coordinates] | @tsv'
```

No `odl.geojson` existed yet, so the skill wrote the default name without asking. The skill
built a heatmap layer, so stations without a value were dropped. It kept the coordinates as
delivered but did not vouch for them: the box check found one station outside Germany.

```
Wrote odl.geojson (783 KB): one FeatureCollection with 1589 points.
  Dropped: 88 stations with value null (78 defekt, 10 Testbetrieb).
  Coordinates: 1 station lies outside Germany's box — Trollenhagen (130711451, defekt) at
               [589.28, 3007.11], a broken position in the BfS data. It has no value, so the
               heatmap had dropped it already; a coverage map must leave it out too.
  Colour on: value (µSv/h); range in this file 0.045–0.237. Clamp the ramp to about
             0.05–0.25, or every point looks the same.
  Properties: kenn, name, plz, value, unit, site_status_text, end_measure,
              height_above_sea, popup ("Schmalfeld: 0.076 µSv/h")
  Checks: parses as a FeatureCollection; all coordinates and values numeric;
          lon 6.02–15.03, lat 47.40–55.02 (EPSG:4326). The API rounds coordinates to 0.01°.
```

Next steps offered: open it at https://geojson.io, or a coverage variant that keeps the 88 dead stations greyed out (without Trollenhagen).

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
  latest: 0.237 µSv/h at 2026-10-05T23:00Z   (validated)
  48 h:   0.232 – 0.241   mean 0.237
  week:   2026-09-29T00:00Z → 2026-10-05T23:00Z, daily means 0.233 – 0.243
          one short bump: 0.265 at 2026-10-01T20:00Z (0.256 at 19:00Z, 0.257 at 21:00Z),
          back to 0.239 by 23:00Z
  Verdict: flat, no rising trend. The daily means were a little lower at the end of the
           week (0.236–0.238) than at the start (0.242–0.243), and the value varies by about
           0.01 µSv/h from hour to hour. It sits at the top of the network's usual
           0.05–0.25 band all week. That is this station's normal level (850 m, mostly
           terrestrial dose), not a change. The 1 Oct bump lasted about three hours, the
           kind of short rise rain can cause.
```

Next steps offered: a CSV of `end_measure,value` for charting (ascending by time).
