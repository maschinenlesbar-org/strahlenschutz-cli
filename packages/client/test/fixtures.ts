// Live-shaped answers of the BfS ODL-Info WFS for the use cases' tests (operations.ts) and the MCP
// server's: 24 stations of the network as `latest` answered on 2026-11-19 (19:00Z), verbatim
// properties, chosen for the skills' traps (the five highest and the three offshore platforms
// lowest, defekt and Testbetrieb stations without a value, a reading not marked validated,
// readings hours old, four Munich stations and two towns named "Bergen"); Trollenhagen carries
// the broken coordinates the BfS published on 5 Oct 2026. Herrischried's hourly series (167 hours
// to 2026-11-19T19:00Z) and Flensburg's daily one (the 40 newest days; the only station with a
// daily series) as recorded the same evening. `odlApi()` answers like the GeoServer: the layer by
// typeName, CQL_FILTER kenn='…', sortBy (kenn, end_measure, " D"), count and startIndex.

import type { HttpRequest, HttpResponse } from "../src/http.js";
import { TYPE_NAMES } from "../src/enums.js";
import type { Feature, JsonObject } from "../src/types.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";

/** [coordinates, properties] of each station in the latest layer. */
export const STATIONS: readonly [unknown, JsonObject][] = [
  [[9.38,54.78], {"id":"DEZ0001","kenn":"010010001","plz":"24941","name":"Flensburg","site_status":1,"site_status_text":"in Betrieb","kid":6,"height_above_sea":39,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.092,"value_cosmic":0.043,"value_terrestrial":0.049,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[10.27,54.5], {"id":"DEZ3261","kenn":"010020001","plz":"24159","name":"Leuchtturm Kiel","site_status":2,"site_status_text":"defekt","kid":6,"height_above_sea":30,"start_measure":null,"end_measure":null,"value":null,"value_cosmic":null,"value_terrestrial":null,"unit":"µSv/h","validated":null,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[7.15,55.02], {"id":"DEZ3399","kenn":"010020002","plz":"24106","name":"FINO 3 - Forschungsplattform","site_status":1,"site_status_text":"in Betrieb","kid":6,"height_above_sea":24,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.05,"value_cosmic":0.042,"value_terrestrial":0.008,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[6.17,54.01], {"id":"DEZ3409","kenn":"010020003","plz":"24106","name":"FINO 1 - Forschungsplattform","site_status":1,"site_status_text":"in Betrieb","kid":6,"height_above_sea":21,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.055,"value_cosmic":0.042,"value_terrestrial":0.013,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[13.16,55.01], {"id":"DEZ3415","kenn":"010020004","plz":"24106","name":"FINO 2 - Forschungsplattform","site_status":1,"site_status_text":"in Betrieb","kid":6,"height_above_sea":10,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.059,"value_cosmic":0.042,"value_terrestrial":0.017,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[9.76,51.5], {"id":"DEZ0180","kenn":"031520061","plz":"37127","name":"Dransfeld","site_status":3,"site_status_text":"Testbetrieb","kid":5,"height_above_sea":310,"start_measure":null,"end_measure":null,"value":null,"value_cosmic":null,"value_terrestrial":null,"unit":"µSv/h","validated":null,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[9.66,51.62], {"id":"DEZ0212","kenn":"031550121","plz":"37170","name":"Uslar OT Schoningen","site_status":1,"site_status_text":"in Betrieb","kid":5,"height_above_sea":135,"start_measure":"2026-11-19T04:00:00Z","end_measure":"2026-11-19T05:00:00Z","value":0.114,"value_cosmic":0.044,"value_terrestrial":0.07,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[9.96,52.82], {"id":"DEZ0303","kenn":"033510041","plz":"29303","name":"Bergen","site_status":1,"site_status_text":"in Betrieb","kid":5,"height_above_sea":8,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.099,"value_cosmic":0.042,"value_terrestrial":0.056,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[8.66,49.96], {"id":"DEZ0821","kenn":"064380031","plz":"63329","name":"Egelsbach","site_status":1,"site_status_text":"in Betrieb","kid":1,"height_above_sea":120,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.114,"value_cosmic":0.044,"value_terrestrial":0.07,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[8.4,48.35], {"id":"DEZ1206","kenn":"082370020","plz":"72275","name":"Alpirsbach","site_status":1,"site_status_text":"in Betrieb","kid":1,"height_above_sea":440,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.202,"value_cosmic":0.048,"value_terrestrial":0.154,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[8.01,47.68], {"id":"DEZ2270","kenn":"083370490","plz":"79737","name":"Herrischried OT Großherrischwand","site_status":1,"site_status_text":"in Betrieb","kid":1,"height_above_sea":850,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.239,"value_cosmic":0.054,"value_terrestrial":0.185,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[11.54,48.16], {"id":"DEZ3476","kenn":"091620001","plz":"80637","name":"München-Neuhausen","site_status":1,"site_status_text":"in Betrieb","kid":3,"height_above_sea":515,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.099,"value_cosmic":0.049,"value_terrestrial":0.05,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[11.45,48.15], {"id":"DEZ1360","kenn":"091620002","plz":"81241","name":"München-Pasing","site_status":1,"site_status_text":"in Betrieb","kid":3,"height_above_sea":526,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.102,"value_cosmic":0.049,"value_terrestrial":0.053,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[11.66,48.09], {"id":"DEZ1361","kenn":"091620003","plz":"81739","name":"München-Neuperlach","site_status":1,"site_status_text":"in Betrieb","kid":3,"height_above_sea":541,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.098,"value_cosmic":0.05,"value_terrestrial":0.048,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[11.52,48.1], {"id":"DEZ1984","kenn":"091620004","plz":"81479","name":"München-Obersendling","site_status":1,"site_status_text":"in Betrieb","kid":3,"height_above_sea":547,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.11,"value_cosmic":0.05,"value_terrestrial":0.06,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[11.66,48.26], {"id":"DEZ3408","kenn":"091841192","plz":"85748","name":"Garching b. München","site_status":1,"site_status_text":"in Betrieb","kid":3,"height_above_sea":478,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.09,"value_cosmic":0.049,"value_terrestrial":0.042,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[13.78,48.83], {"id":"DEZ1919","kenn":"092721221","plz":"94145","name":"Haidmühle","site_status":1,"site_status_text":"in Betrieb","kid":3,"height_above_sea":833,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.201,"value_cosmic":0.054,"value_terrestrial":0.147,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[12.68,49.39], {"id":"DEZ3504","kenn":"093721713","plz":"93449","name":"Waldmünchen OT Hocha","site_status":1,"site_status_text":"in Betrieb","kid":3,"height_above_sea":495,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.16,"value_cosmic":0.049,"value_terrestrial":0.112,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[10.95,48.43], {"id":"DEZ2898","kenn":"097711121","plz":"86444","name":"Bergen","site_status":1,"site_status_text":"in Betrieb","kid":3,"height_above_sea":461,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.095,"value_cosmic":0.048,"value_terrestrial":0.047,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[13.5,52.63], {"id":"DEZ2860","kenn":"110000004","plz":"13125","name":"Berlin-Buch","site_status":1,"site_status_text":"in Betrieb","kid":2,"height_above_sea":61,"start_measure":"2026-11-19T17:00:00Z","end_measure":"2026-11-19T18:00:00Z","value":0.091,"value_cosmic":0.043,"value_terrestrial":0.048,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[13.94,52.85], {"id":"DEZ2382","kenn":"120601721","plz":"16248","name":"Niederfinow","site_status":1,"site_status_text":"in Betrieb","kid":2,"height_above_sea":4,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.094,"value_cosmic":0.042,"value_terrestrial":0.052,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[13.94,53.88], {"id":"DEZ3167","kenn":"130590972","plz":"17406","name":"Usedom","site_status":1,"site_status_text":"in Betrieb","kid":6,"height_above_sea":5,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.097,"value_cosmic":0.042,"value_terrestrial":0.055,"unit":"µSv/h","validated":2,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[589.28,3007.11], {"id":"DEZ3583","kenn":"130711451","plz":"17039","name":"Trollenhagen","site_status":2,"site_status_text":"defekt","kid":6,"height_above_sea":0,"start_measure":null,"end_measure":null,"value":null,"value_cosmic":null,"value_terrestrial":null,"unit":"µSv/h","validated":null,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
  [[10.77,50.65], {"id":"DEZ2593","kenn":"160700171","plz":"98559","name":"Gehlberg","site_status":1,"site_status_text":"in Betrieb","kid":3,"height_above_sea":943,"start_measure":"2026-11-19T18:00:00Z","end_measure":"2026-11-19T19:00:00Z","value":0.199,"value_cosmic":0.056,"value_terrestrial":0.143,"unit":"µSv/h","validated":1,"nuclide":"Gamma-ODL-Brutto","duration":"1h"}],
];

/** Herrischried (083370490): the hourly values, oldest first, the last one ending 2026-11-19T19:00Z. */
export const HERRISCHRIED_HOURLY: readonly number[] = [
  0.226, 0.222, 0.22, 0.224, 0.224, 0.222, 0.221, 0.223, 0.222, 0.22, 0.221, 0.222, 0.219, 0.218, 0.22, 0.218, 0.216, 0.221, 0.218, 0.22, 0.222, 0.219, 0.222, 0.225,
  0.222, 0.221, 0.224, 0.222, 0.222, 0.225, 0.219, 0.221, 0.222, 0.22, 0.222, 0.218, 0.218, 0.217, 0.218, 0.221, 0.22, 0.226, 0.219, 0.224, 0.223, 0.221, 0.226, 0.223,
  0.222, 0.226, 0.225, 0.227, 0.227, 0.227, 0.226, 0.225, 0.233, 0.233, 0.232, 0.239, 0.235, 0.233, 0.229, 0.226, 0.219, 0.224, 0.223, 0.218, 0.225, 0.223, 0.222, 0.223,
  0.234, 0.243, 0.232, 0.234, 0.226, 0.223, 0.224, 0.22, 0.217, 0.221, 0.223, 0.22, 0.229, 0.226, 0.231, 0.224, 0.22, 0.216, 0.216, 0.223, 0.224, 0.227, 0.228, 0.224,
  0.227, 0.223, 0.225, 0.223, 0.22, 0.214, 0.223, 0.233, 0.235, 0.235, 0.23, 0.227, 0.232, 0.228, 0.233, 0.231, 0.235, 0.224, 0.218, 0.224, 0.22, 0.216, 0.218, 0.22,
  0.22, 0.223, 0.224, 0.229, 0.23, 0.228, 0.226, 0.223, 0.221, 0.219, 0.216, 0.223, 0.222, 0.221, 0.216, 0.225, 0.228, 0.227, 0.228, 0.228, 0.23, 0.225, 0.22, 0.226,
  0.224, 0.219, 0.217, 0.219, 0.218, 0.219, 0.218, 0.22, 0.228, 0.227, 0.228, 0.23, 0.223, 0.228, 0.236, 0.233, 0.23, 0.226, 0.223, 0.227, 0.227, 0.235, 0.239,
];

/** Flensburg (010010001): the daily values, newest first, the first one ending 2026-11-19T00:00Z. */
export const FLENSBURG_DAILY: readonly number[] = [
  0.098, 0.099, 0.098, 0.095, 0.091, 0.092, 0.094, 0.095, 0.094, 0.094, 0.094, 0.09, 0.089, 0.09, 0.089, 0.09, 0.09, 0.088, 0.087, 0.087, 0.088, 0.088, 0.092, 0.089, 0.097, 0.097, 0.093, 0.093, 0.101, 0.091, 0.087, 0.088, 0.088, 0.089, 0.088, 0.086, 0.093, 0.089, 0.091, 0.092,
];

/** One latest-layer feature from a row of {@link STATIONS}. */
export function latestFeature([coordinates, properties]: readonly [unknown, JsonObject], index = 0): Feature {
  return { type: "Feature", id: `odlinfo_odl_1h_latest.fid-${index}`, geometry: { type: "Point", coordinates: coordinates as never }, geometry_name: "geom", properties };
}

/** A station's properties with some of them replaced, for a case the live answer hasn't got. */
export function stationRow(kenn: string, changes: JsonObject = {}): [unknown, JsonObject] {
  const row = STATIONS.find(([, p]) => p["kenn"] === kenn);
  if (row === undefined) throw new Error(`no fixture station ${kenn}`);
  const coordinates = "coordinates" in changes ? changes["coordinates"] : row[0];
  const { coordinates: _, ...rest } = changes;
  return [coordinates, { ...row[1], ...rest }];
}

/** One step of a time series: its end, value and validation flag. */
export interface SeriesStep {
  end: string;
  value: number | null;
  validated?: number | null;
}

/** Hourly steps ending at `last` (an ISO instant), oldest first. */
export function hourly(values: readonly (number | null)[], last = "2026-11-19T19:00:00Z", validated: (i: number) => number | null = () => 1): SeriesStep[] {
  const end = Date.parse(last);
  return values.map((value, i) => ({ end: new Date(end - (values.length - 1 - i) * 3_600_000).toISOString().replace(".000Z", "Z"), value, validated: value === null ? null : validated(i) }));
}

/** Daily steps, newest first, the first ending at `first` (midnight UTC). */
export function daily(values: readonly number[], first = "2026-11-19T00:00:00Z"): SeriesStep[] {
  const end = Date.parse(first);
  return values.map((value, i) => ({ end: new Date(end - i * 86_400_000).toISOString().replace(".000Z", "Z"), value, validated: 1 }));
}

/** The series the mock serves per station: hourly (`ts-1h`) and daily (`ts-24h`). */
export interface SeriesFixture {
  hourly?: SeriesStep[];
  daily?: SeriesStep[];
}

export const SERIES: Record<string, SeriesFixture> = {
  "083370490": { hourly: hourly(HERRISCHRIED_HOURLY) },
  "010010001": { hourly: hourly(Array.from({ length: 48 }, (_, i) => [0.092, 0.091, 0.093, 0.09][i % 4] as number)), daily: daily(FLENSBURG_DAILY) },
};

/** A series feature as the WFS gives it (fewer fields than latest). */
function seriesFeature(station: JsonObject, coordinates: unknown, step: SeriesStep, kind: "ts-1h" | "ts-24h", index: number): Feature {
  const ms = kind === "ts-1h" ? 3_600_000 : 86_400_000;
  const start = new Date(Date.parse(step.end) - ms).toISOString().replace(".000Z", "Z");
  return {
    type: "Feature",
    id: `odlinfo_timeseries_odl_${kind === "ts-1h" ? "1h" : "24h"}.fid-${index}`,
    geometry: { type: "Point", coordinates: coordinates as never },
    geometry_name: "geom",
    properties: {
      id: station["id"] ?? null,
      kenn: station["kenn"] ?? null,
      name: station["name"] ?? null,
      start_measure: start,
      end_measure: step.end,
      value: step.value,
      unit: "µSv/h",
      validated: step.validated ?? 1,
      nuclide: "Gamma-ODL-Brutto",
      duration: kind === "ts-1h" ? "1h" : "1d",
    },
  };
}

/** GeoServer's order for `sortBy` ("kenn", "kenn,end_measure", "end_measure D"; nulls first). */
function sortFeatures(features: Feature[], sortBy: string): Feature[] {
  const keys = sortBy.split(",").map((part) => {
    const [key = "", dir] = part.trim().split(/\s+/);
    return { key, desc: dir === "D" || dir === "DESC" };
  });
  return [...features].sort((a, b) => {
    for (const { key, desc } of keys) {
      const x = a.properties[key] ?? null;
      const y = b.properties[key] ?? null;
      if (x === y) continue;
      // GeoServer (PostGIS) sorts nulls as the largest: first in a descending sort.
      const order = x === null ? 1 : y === null ? -1 : x < y ? -1 : 1;
      return desc ? -order : order;
    }
    return 0;
  });
}

/** The WFS's answer to `request`, over `stations` and `series`. */
export function odlAnswer(request: HttpRequest, stations: readonly [unknown, JsonObject][] = STATIONS, series: Record<string, SeriesFixture> = SERIES): HttpResponse {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/ogc/opendata/ows")) return jsonResponse({ error: "not found" }, 404);
  const params = url.searchParams;
  const typeName = params.get("typeName");
  const kenn = /^kenn='(\d+)'$/.exec(params.get("CQL_FILTER") ?? "")?.[1];
  let features: Feature[];
  if (typeName === TYPE_NAMES.latest) {
    features = stations.map((row, i) => latestFeature(row, i));
  } else if (typeName === TYPE_NAMES["ts-1h"] || typeName === TYPE_NAMES["ts-24h"]) {
    const kind = typeName === TYPE_NAMES["ts-1h"] ? "ts-1h" : "ts-24h";
    features = [];
    for (const [coordinates, station] of stations) {
      const steps = series[String(station["kenn"])]?.[kind === "ts-1h" ? "hourly" : "daily"] ?? [];
      steps.forEach((step, i) => features.push(seriesFeature(station, coordinates, step, kind, i)));
    }
  } else {
    return jsonResponse({ error: `unknown typeName ${typeName}` }, 400);
  }
  if (kenn !== undefined) features = features.filter((f) => f.properties["kenn"] === kenn);
  const sortBy = params.get("sortBy");
  if (sortBy !== null) features = sortFeatures(features, sortBy);
  const matched = features.length;
  const start = Number(params.get("startIndex") ?? 0);
  const count = params.get("count");
  features = features.slice(start, count === null ? undefined : start + Number(count));
  return jsonResponse({ type: "FeatureCollection", features, totalFeatures: matched, numberMatched: matched, numberReturned: features.length, timeStamp: "2026-11-19T19:15:00.000Z", crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } } });
}

/** A mock of the WFS over `stations` and `series` (default: the recorded ones). */
export function odlApi(stations: readonly [unknown, JsonObject][] = STATIONS, series: Record<string, SeriesFixture> = SERIES): MockTransport {
  return makeMockTransport((request) => odlAnswer(request, stations, series));
}
