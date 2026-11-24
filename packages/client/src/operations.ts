// The use cases of the skills as library functions, built on the client: each carries the traps
// the skills document, so no caller (the CLI, the MCP server's tools, a library user) has to know
// them.
// - getDoseSnapshot: the network's latest readings ranked and judged against normal background,
//   for all of Germany, a Land, around a place or a point, or in a box (strahlenschutz-dose-snapshot);
// - getStationsMap: the readings as map-ready GeoJSON points, dead sensors dropped (or kept and
//   marked) and broken coordinates left off and named (strahlenschutz-map);
// - getStationTrend: one station's hourly series newest first, summarised and judged against the
//   station's own baseline (strahlenschutz-station-trend);
// - findStations and getTimeseries: the stations by name, postal code, Land or distance, and one
//   station's raw series, for what the use cases don't reach.
//
// Traps that hold for all of them: about 120 of the ~1670 stations (defekt, Testbetrieb) report
// no value, and the server's own sort puts those nulls first, so rankings are made here, never by
// the WFS. `latest` is each station's newest reading, not one common hour. The coordinates are
// passed through unchecked by the BfS (one station had [589.28, 3007.11]). The WFS answers an
// unknown station with an empty collection, exactly like a real station without readings, so an
// empty series is told apart with a second look into the network. The daily series holds one
// station only (Flensburg). Ambiguity (a place several stations or regions fit) is reported, never
// guessed.

import type { StrahlenschutzClient } from "./client.js";
import { StrahlParseError, StrahlValidationError, quoteValue } from "./errors.js";
import type { Feature, JsonValue } from "./types.js";
import { assertValid, intRangeProblem, normalizeText, textProblem } from "./validate.js";

// --- Shared: Länder, readings, places ------------------------------------------------------------

/**
 * The 16 Länder: the two-digit code a station's `kenn` starts with (the Gemeindeschlüssel's Land
 * code: 083370490 is in Baden-Württemberg), the abbreviation, the German and the English name.
 * The offshore platforms (FINO 1–3) are filed under Schleswig-Holstein.
 */
export const LANDS = [
  ["01", "SH", "Schleswig-Holstein", "Schleswig-Holstein"],
  ["02", "HH", "Hamburg", "Hamburg"],
  ["03", "NI", "Niedersachsen", "Lower Saxony"],
  ["04", "HB", "Bremen", "Bremen"],
  ["05", "NW", "Nordrhein-Westfalen", "North Rhine-Westphalia"],
  ["06", "HE", "Hessen", "Hesse"],
  ["07", "RP", "Rheinland-Pfalz", "Rhineland-Palatinate"],
  ["08", "BW", "Baden-Württemberg", "Baden-Württemberg"],
  ["09", "BY", "Bayern", "Bavaria"],
  ["10", "SL", "Saarland", "Saarland"],
  ["11", "BE", "Berlin", "Berlin"],
  ["12", "BB", "Brandenburg", "Brandenburg"],
  ["13", "MV", "Mecklenburg-Vorpommern", "Mecklenburg-Western Pomerania"],
  ["14", "SN", "Sachsen", "Saxony"],
  ["15", "ST", "Sachsen-Anhalt", "Saxony-Anhalt"],
  ["16", "TH", "Thüringen", "Thuringia"],
] as const;

type Land = (typeof LANDS)[number];

/** The Land a station is in, by the first two digits of its kenn. */
export function landOf(kenn: string): string | undefined {
  return LANDS.find((land) => land[0] === kenn.slice(0, 2))?.[2];
}

/** A Land by its code ("09"), abbreviation ("BY", "NRW"), German or English name; else a validation error naming them. */
export function resolveLand(value: string): Land {
  const wanted = fold(normalizeText(assertValid("state", value, textProblem)));
  const found = LANDS.find((land) => land.some((name) => fold(name) === wanted) || (wanted === "nrw" && land[1] === "NW"));
  if (found === undefined) {
    throw new StrahlValidationError(`Invalid state: ${quoteValue(value, 60)} is no German Land. Use a name (Bayern, Bavaria), an abbreviation (BY, NRW) or a code (09).`);
  }
  return found;
}

/**
 * Text as names are compared: lower case, without accents (ä → a, ß → ss), and ae/oe/ue read as
 * ä/ö/ü, so "Muenchen", "münchen" and "MÜNCHEN" all match "München".
 */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/ae/g, "a")
    .replace(/oe/g, "o")
    .replace(/ue/g, "u");
}

/** The words of a name, folded ("Garching b. München" → garching, b, munchen). */
function wordsOf(name: string): string[] {
  return fold(name).split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
}

/** The usual background: about 0.05–0.25 µSv/h across the network (most stations 0.07–0.15). */
export const NORMAL_BACKGROUND = { min: 0.05, max: 0.25, unit: "µSv/h" } as const;

/**
 * A reading above this (µSv/h) is above anything the network shows as background: worth naming
 * and checking against the station's own trend and its neighbours. The highest real readings,
 * at high-altitude and granite sites, sit at 0.20–0.25 all the time.
 */
export const NOTABLE_DOSE_RATE = 0.3;

/** Every real station lies in Germany or at its offshore platforms: lon 5.5–15.5, lat 47–55.5. */
export const GERMANY_BOX = { west: 5.5, south: 47, east: 15.5, north: 55.5 } as const;

/** One station's latest reading, decoded. */
export interface StationReading {
  /** The station id every other call takes (9 digits). */
  kenn: string;
  /** The BfS station code (DEZ0001). */
  id?: string;
  name: string;
  plz?: string;
  /** The Land, from the kenn. */
  land?: string;
  /** in Betrieb, defekt or Testbetrieb. */
  status: string;
  /** Metres above sea level: altitude adds cosmic dose. */
  height?: number;
  /** [lon, lat] as the BfS stores it (rounded to 0.01°), when it is a pair of numbers. */
  coordinates?: [number, number];
  /** The ambient gamma dose rate in µSv/h; null: no reading (a dead sensor, or a unit that is no dose rate in µSv/h). */
  value: number | null;
  /** The cosmic and terrestrial (ground) parts of the value. */
  valueCosmic?: number | null;
  valueTerrestrial?: number | null;
  /** Always µSv/h: a reading in another unit is converted, or has no value. */
  unit: string;
  /** The unit the BfS sent, when it wasn't µSv/h: converted (nSv/h, mSv/h), or why value is null. */
  unitSent?: string;
  /** true: validated; false: not marked validated (yet); null: no reading. */
  validated: boolean | null;
  /** The end of the reading's hour (UTC). */
  hourEnding?: string;
}

const str = (value: JsonValue | undefined): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const numOrNull = (value: JsonValue | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Factors from the units a reading may come in to µSv/h (the micro sign, the Greek mu, a plain u). */
const TO_MICROSIEVERT_PER_HOUR: Readonly<Record<string, number>> = { "µsv/h": 1, "μsv/h": 1, "usv/h": 1, "nsv/h": 0.001, "msv/h": 1000 };

/** The factor to µSv/h for `unit` (absent: µSv/h, as the BfS sends it), or undefined for another unit. */
export function microsievertFactor(unit: string | undefined): number | undefined {
  return unit === undefined ? 1 : TO_MICROSIEVERT_PER_HOUR[unit.trim().toLowerCase()];
}

/** `value` times `factor`, without a binary fraction's noise (239 nSv/h is 0.239, not 0.23900000000000002). */
const scaled = (value: number | null, factor: number): number | null => (value === null ? null : Number((value * factor).toPrecision(12)));

/** The unit as sent, when it is not µSv/h (for `unitSent`). */
function unitSentOf(unit: string | undefined): string | undefined {
  return unit === undefined || microsievertFactor(unit) === 1 ? undefined : unit;
}

/** Why a station has no value: its status, or a unit that is no dose rate in µSv/h. */
function noValueReason(s: StationReading): string {
  return s.unitSent !== undefined && microsievertFactor(s.unitSent) === undefined ? `unit ${s.unitSent}` : s.status;
}

/** The [lon, lat] of a feature, when its geometry is a pair of finite numbers. */
function coordinatesOf(feature: Feature): [number, number] | undefined {
  const c = feature.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2) return undefined;
  const [lon, lat] = c;
  return typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : undefined;
}

/** True when [lon, lat] lies in {@link GERMANY_BOX}. */
export function inGermany(coordinates: readonly [number, number] | undefined): boolean {
  if (coordinates === undefined) return false;
  const [lon, lat] = coordinates;
  return lon >= GERMANY_BOX.west && lon <= GERMANY_BOX.east && lat >= GERMANY_BOX.south && lat <= GERMANY_BOX.north;
}

/** A latest-layer feature as a {@link StationReading}. */
export function readingOf(feature: Feature): StationReading {
  const p = feature.properties;
  const kenn = str(p["kenn"]) ?? "";
  // In µSv/h whatever unit it came in; a unit that can't be converted leaves no value.
  const unit = str(p["unit"]);
  const factor = microsievertFactor(unit);
  const unitSent = unitSentOf(unit);
  const value = factor === undefined ? null : scaled(numOrNull(p["value"]), factor);
  const validated = p["validated"] === 1 ? true : p["validated"] === 2 ? false : null;
  const coordinates = coordinatesOf(feature);
  const land = landOf(kenn);
  const height = numOrNull(p["height_above_sea"]);
  const id = str(p["id"]);
  const plz = str(p["plz"]);
  const hourEnding = str(p["end_measure"]);
  return {
    kenn,
    ...(id === undefined ? {} : { id }),
    name: str(p["name"]) ?? kenn,
    ...(plz === undefined ? {} : { plz }),
    ...(land === undefined ? {} : { land }),
    status: str(p["site_status_text"]) ?? "unknown",
    ...(height === null ? {} : { height }),
    ...(coordinates === undefined ? {} : { coordinates }),
    value,
    valueCosmic: factor === undefined ? null : scaled(numOrNull(p["value_cosmic"]), factor),
    valueTerrestrial: factor === undefined ? null : scaled(numOrNull(p["value_terrestrial"]), factor),
    unit: "µSv/h",
    ...(unitSent === undefined ? {} : { unitSent }),
    validated: value === null ? null : validated,
    ...(hourEnding === undefined ? {} : { hourEnding }),
  };
}

/**
 * The whole network's latest readings (one request, about 1670 stations). An answer that can't be
 * the network (no stations; most without a 9-digit kenn or coordinates in Germany; most stations
 * in Betrieb without a value in µSv/h; most readings without their hour) is a StrahlParseError: a
 * changed or broken answer read as data would give empty answers that send the caller elsewhere
 * ("no station lies in Bayern") or a verdict without an hour.
 */
export async function loadNetwork(client: StrahlenschutzClient): Promise<StationReading[]> {
  const network = (await client.latest()).features.map(readingOf);
  const problem = networkProblem(network);
  if (problem !== undefined) {
    throw new StrahlParseError(
      `The BfS's network answer (the latest layer) has an unexpected shape: ${problem}. The network has about 1,670 stations, each with a 9-digit kenn and coordinates in Germany, and those in Betrieb with a value in µSv/h for an hour (end_measure). Try again later; if it stays so, the service changed.`,
    );
  }
  return network;
}

/** What makes `network` no network answer, or undefined: half of the stations must hold each part. */
function networkProblem(network: readonly StationReading[]): string | undefined {
  const most = (part: number, all: number): boolean => part * 2 >= all;
  if (network.length === 0) return "it holds no stations at all";
  const withKenn = network.filter((s) => KENN.test(s.kenn)).length;
  if (!most(withKenn, network.length)) return `${network.length - withKenn} of ${network.length} stations have no 9-digit kenn`;
  const placed = network.filter((s) => inGermany(s.coordinates)).length;
  if (!most(placed, network.length)) return `${network.length - placed} of ${network.length} stations have no coordinates in Germany (none, or lon and lat swapped)`;
  const working = network.filter((s) => s.status === "in Betrieb");
  const valuedWorking = working.filter((s) => s.value !== null).length;
  const units = [...new Set(working.filter((s) => s.value === null && s.unitSent !== undefined).map((s) => s.unitSent))];
  if (!most(valuedWorking, working.length)) {
    return `${working.length - valuedWorking} of ${working.length} stations in Betrieb have no value in µSv/h (missing, not a number${units.length === 0 ? "" : `, or in ${units.join(", ")}`})`;
  }
  const valued = network.filter((s) => s.value !== null);
  if (valued.length === 0) return `none of the ${network.length} stations has a value in µSv/h`;
  const timed = valued.filter((s) => s.hourEnding !== undefined).length;
  if (!most(timed, valued.length)) return `${valued.length - timed} of ${valued.length} readings carry no end_measure (the hour they are for)`;
  return undefined;
}

/** The great-circle distance in km between two [lon, lat] points. */
export function distanceKm(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/** The stations whose name is `place` (folded), else those with a word starting with it. */
function stationsNamed(network: readonly StationReading[], place: string): StationReading[] {
  const wanted = fold(place);
  const exact = network.filter((s) => fold(s.name) === wanted);
  if (exact.length > 0) return exact;
  const words = wordsOf(place);
  return network.filter((s) => {
    const name = wordsOf(s.name);
    // Every word of the place starts a word of the name, in order ("Garching b", "Berlin Buch").
    let at = 0;
    for (const word of words) {
      const found = name.findIndex((w, i) => i >= at && w.startsWith(word));
      if (found < 0) return false;
      at = found + 1;
    }
    return words.length > 0;
  });
}

/** A short summary of a station, for candidates and lists. */
export interface StationSummary {
  kenn: string;
  name: string;
  plz?: string;
  land?: string;
  status: string;
}

function summaryOf(s: StationReading): StationSummary {
  return { kenn: s.kenn, name: s.name, ...(s.plz === undefined ? {} : { plz: s.plz }), ...(s.land === undefined ? {} : { land: s.land }), status: s.status };
}

// --- Areas: a Land, a place, a point, a box -------------------------------------------------------

/** Where to look: at most one of state, place, lat/lon or bbox; none is all of Germany. */
export interface AreaInput {
  /** A Land: name, abbreviation or code. */
  state?: string | undefined;
  /** A town or district as the BfS names its stations ("München", "Berlin", "Herrischried"). */
  place?: string | undefined;
  /** A point (both lat and lon), with radiusKm. */
  lat?: number | undefined;
  lon?: number | undefined;
  /** The circle around place or the point, in km (1–200, default 25). */
  radiusKm?: number | undefined;
  /** [west, south, east, north] in decimal degrees. */
  bbox?: readonly number[] | undefined;
}

/** The area as resolved, in the answer's `searched`. */
export interface AreaSearched {
  state?: string;
  place?: string;
  lat?: number;
  lon?: number;
  radiusKm?: number;
  bbox?: number[];
}

type AreaFilter = { test: (s: StationReading) => boolean; distance?: (s: StationReading) => number | undefined; label: string; geographic: boolean };

type AreaResolution =
  | { status: "ok"; searched: AreaSearched; filter: AreaFilter; notes: string[] }
  | { status: "ambiguous"; searched: AreaSearched; total: number; candidates: StationSummary[]; reason: string }
  | { status: "empty"; searched: AreaSearched; reason: string };

/** Default and bounds of {@link AreaInput.radiusKm}. */
export const DEFAULT_RADIUS_KM = 25;
const radiusProblem = intRangeProblem(1, 200);

/** How far apart (km) the stations a place names may be and still be one place. */
const PLACE_SPREAD_KM = 40;

function bboxOf(box: readonly number[]): [number, number, number, number] {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new StrahlValidationError("Invalid bbox: expected [west, south, east, north] in decimal degrees.");
  }
  const [w, s, e, n] = box as [number, number, number, number];
  if (w < -180 || e > 180 || s < -90 || n > 90 || w > e || s > n) {
    throw new StrahlValidationError("Invalid bbox: expected [west, south, east, north] with west ≤ east and south ≤ north (longitude −180..180, latitude −90..90).");
  }
  return [w, s, e, n];
}

function pointOf(lat: number | undefined, lon: number | undefined): [number, number] | undefined {
  if (lat === undefined && lon === undefined) return undefined;
  if (lat === undefined || lon === undefined) throw new StrahlValidationError("Invalid point: give lat and lon together, or neither.");
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new StrahlValidationError("Invalid point: lat is −90..90 and lon −180..180, in decimal degrees.");
  }
  return [lon, lat];
}

/** Check an area's input before any request. */
function checkArea(input: AreaInput): void {
  const kinds = [input.state !== undefined, input.place !== undefined, input.lat !== undefined || input.lon !== undefined, input.bbox !== undefined].filter(Boolean).length;
  if (kinds > 1) throw new StrahlValidationError("Invalid area: give one of state, place, lat/lon or bbox, not several.");
  if (input.radiusKm !== undefined) {
    assertValid("radiusKm", input.radiusKm, radiusProblem);
    if (input.place === undefined && input.lat === undefined && input.lon === undefined) throw new StrahlValidationError("Invalid radiusKm: it goes with place or lat/lon.");
  }
  if (input.state !== undefined) resolveLand(input.state);
  if (input.place !== undefined) assertValid("place", input.place, textProblem);
  pointOf(input.lat, input.lon);
  if (input.bbox !== undefined) bboxOf(input.bbox);
}

function resolveArea(network: readonly StationReading[], input: AreaInput): AreaResolution {
  const radiusKm = input.radiusKm ?? DEFAULT_RADIUS_KM;
  if (input.state !== undefined) {
    const land = resolveLand(input.state);
    return { status: "ok", searched: { state: land[2] }, filter: { test: (s) => s.kenn.startsWith(land[0]), label: `in ${land[2]}`, geographic: false }, notes: [] };
  }
  const circle = (centre: [number, number]): AreaFilter => ({
    test: (s) => inGermany(s.coordinates) && distanceKm(centre, s.coordinates as [number, number]) <= radiusKm,
    distance: (s) => (inGermany(s.coordinates) ? round(distanceKm(centre, s.coordinates as [number, number]), 1) : undefined),
    label: `within ${radiusKm} km of ${centre[1]}, ${centre[0]}`,
    geographic: true,
  });
  const point = pointOf(input.lat, input.lon);
  if (point !== undefined) {
    return { status: "ok", searched: { lat: point[1], lon: point[0], radiusKm }, filter: circle(point), notes: [] };
  }
  if (input.place !== undefined) {
    const place = normalizeText(assertValid("place", input.place, textProblem));
    const searched = { place, radiusKm };
    const named = stationsNamed(network, place).filter((s) => inGermany(s.coordinates));
    if (named.length === 0) {
      return {
        status: "empty",
        searched,
        reason: `No station's name starts with ${quoteValue(place, 60)}: the BfS names its stations by town or district. Give lat and lon (with radiusKm), a Land (state) or a bbox instead, or look the place up with findStations.`,
      };
    }
    const centre: [number, number] = [
      round(named.reduce((sum, s) => sum + (s.coordinates as [number, number])[0], 0) / named.length, 3),
      round(named.reduce((sum, s) => sum + (s.coordinates as [number, number])[1], 0) / named.length, 3),
    ];
    if (named.some((s) => distanceKm(centre, s.coordinates as [number, number]) > PLACE_SPREAD_KM)) {
      return {
        status: "ambiguous",
        searched,
        total: named.length,
        candidates: named.slice(0, 25).map(summaryOf),
        reason: `${quoteValue(place, 60)} names stations in several regions: ask which one is meant, then give that station's town more fully, its Land (state), or lat/lon.`,
      };
    }
    return {
      status: "ok",
      searched,
      filter: circle(centre),
      notes: [`The area is ${radiusKm} km around the station${named.length === 1 ? "" : "s"} named ${named.map((s) => s.name).join(", ")} (centre ${centre[1]}, ${centre[0]}).`],
    };
  }
  if (input.bbox !== undefined) {
    const [w, s, e, n] = bboxOf(input.bbox);
    return {
      status: "ok",
      searched: { bbox: [w, s, e, n] },
      filter: {
        test: (st) => inGermany(st.coordinates) && (st.coordinates as [number, number])[0] >= w && (st.coordinates as [number, number])[0] <= e && (st.coordinates as [number, number])[1] >= s && (st.coordinates as [number, number])[1] <= n,
        label: `in [${w}, ${s}, ${e}, ${n}]`,
        geographic: true,
      },
      notes: [],
    };
  }
  return { status: "ok", searched: {}, filter: { test: () => true, label: "Germany", geographic: false }, notes: [] };
}

/** A note on stations a geographic area couldn't place (no usable coordinates). */
function unplacedNote(network: readonly StationReading[], filter: AreaFilter): string[] {
  if (!filter.geographic) return [];
  const unplaced = network.filter((s) => !inGermany(s.coordinates));
  return unplaced.length === 0 ? [] : [`${unplaced.length} station${unplaced.length === 1 ? " has" : "s have"} no usable coordinates and could not be placed in the area (${unplaced.map((s) => `${s.name}, ${s.kenn}`).slice(0, 5).join("; ")}).`];
}

/** Notes on readings that came in another unit: converted, or left out. */
function unitNotes(stations: readonly StationReading[]): string[] {
  const sent = stations.filter((s) => s.unitSent !== undefined);
  const converted = sent.filter((s) => s.value !== null);
  const unknown = sent.filter((s) => microsievertFactor(s.unitSent) === undefined);
  const units = (list: readonly StationReading[]): string => [...new Set(list.map((s) => s.unitSent))].join(", ");
  return [
    ...(converted.length === 0 ? [] : [`${converted.length} reading${converted.length === 1 ? "" : "s"} came in ${units(converted)} and ${converted.length === 1 ? "is" : "are"} converted to µSv/h.`]),
    ...(unknown.length === 0
      ? []
      : [`${unknown.length} station${unknown.length === 1 ? " reports" : "s report"} in a unit that is no dose rate in µSv/h (${units(unknown)}: ${unknown.slice(0, 5).map((s) => `${s.name}, ${s.kenn}`).join("; ")}) and ${unknown.length === 1 ? "is" : "are"} left out: say so.`]),
  ];
}

// --- getDoseSnapshot -------------------------------------------------------------------------------

/** The input of {@link getDoseSnapshot}. */
export interface DoseSnapshotInput extends AreaInput {
  /** highest (default) or lowest first. */
  order?: "highest" | "lowest" | undefined;
  /** How many stations to rank (1–100, default 10). */
  limit?: number | undefined;
}

/** A ranked station of a snapshot. */
export interface RankedReading {
  rank: number;
  kenn: string;
  name: string;
  land?: string;
  value: number;
  unit: string;
  valueCosmic?: number | null;
  valueTerrestrial?: number | null;
  height?: number;
  validated: boolean | null;
  hourEnding?: string;
  /** Its reading is older than the hour most stations report for: say so. */
  olderReading?: true;
  distanceKm?: number;
}

/** The answer of {@link getDoseSnapshot}. */
export type DoseSnapshot =
  | {
      status: "ok";
      searched: AreaSearched & { order: "highest" | "lowest" };
      area: string;
      /** Stations in the area, with and without a value. */
      stationCount: number;
      reporting: number;
      /** Stations without a value, by status: never drop them silently. */
      skipped: { total: number; byStatus: Record<string, number> };
      /** normal: every reading at or below NOTABLE_DOSE_RATE; notable: some above. */
      verdict: "normal" | "notable";
      verdictText: string;
      max: RankedReading;
      min: RankedReading;
      /** Readings above NOTABLE_DOSE_RATE, highest first. */
      notable: RankedReading[];
      /** The hours the readings end at, newest first, with how many stations each. */
      hours: { hourEnding: string; stations: number }[];
      /** The hour most readings are for. */
      mainHour: string;
      olderReadings: number;
      notValidated: number;
      normalBackground: typeof NORMAL_BACKGROUND;
      ranking: RankedReading[];
      notes: string[];
    }
  | { status: "ambiguous"; searched: AreaSearched; total: number; candidates: StationSummary[]; reason: string }
  | { status: "empty"; searched: AreaSearched; reason: string };

const limitProblem = (max: number) => intRangeProblem(1, max);
const ORDERS = ["highest", "lowest"] as const;

/**
 * The network's latest readings ranked and judged: the stations without a value (defekt,
 * Testbetrieb) counted apart and never ranked (the server's sort puts their nulls first), the
 * hours the readings are for (each station's newest, not one common hour), the highest and lowest,
 * and a verdict against the usual background (0.05–0.25 µSv/h; above 0.3 is named). One request.
 */
export async function getDoseSnapshot(client: StrahlenschutzClient, input: DoseSnapshotInput = {}): Promise<DoseSnapshot> {
  checkArea(input);
  const order = input.order ?? "highest";
  if (!(ORDERS as readonly string[]).includes(order)) throw new StrahlValidationError(`Invalid order: expected highest or lowest.`);
  const limit = assertValid("limit", input.limit ?? 10, limitProblem(100));
  const network = await loadNetwork(client);
  const area = resolveArea(network, input);
  if (area.status !== "ok") return area;
  const searched = { ...area.searched, order };
  const inArea = network.filter(area.filter.test);
  if (inArea.length === 0) {
    return { status: "empty", searched, reason: `No station of the BfS network lies ${area.filter.label === "Germany" ? "in Germany" : area.filter.label}. Widen the area (radiusKm, a larger bbox) or ask for a Land or all of Germany.` };
  }
  const reporting = inArea.filter((s): s is StationReading & { value: number } => s.value !== null);
  const byStatus: Record<string, number> = {};
  for (const s of inArea) if (s.value === null) byStatus[noValueReason(s)] = (byStatus[noValueReason(s)] ?? 0) + 1;
  const skippedTotal = inArea.length - reporting.length;
  if (reporting.length === 0) {
    return { status: "empty", searched, reason: `None of the ${inArea.length} stations ${area.filter.label === "Germany" ? "of the network" : area.filter.label} reports a value now (${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(", ")}).` };
  }
  const hourCounts = new Map<string, number>();
  for (const s of reporting) if (s.hourEnding !== undefined) hourCounts.set(s.hourEnding, (hourCounts.get(s.hourEnding) ?? 0) + 1);
  const hours = [...hourCounts].map(([hourEnding, stations]) => ({ hourEnding, stations })).sort((a, b) => (a.hourEnding < b.hourEnding ? 1 : -1));
  const mainHour = [...hours].sort((a, b) => b.stations - a.stations || (a.hourEnding < b.hourEnding ? 1 : -1))[0]?.hourEnding ?? "";
  const ranked = (s: StationReading & { value: number }, rank: number): RankedReading => {
    const distance = area.filter.distance?.(s);
    return {
      rank,
      kenn: s.kenn,
      name: s.name,
      ...(s.land === undefined ? {} : { land: s.land }),
      value: s.value,
      unit: s.unit,
      valueCosmic: s.valueCosmic ?? null,
      valueTerrestrial: s.valueTerrestrial ?? null,
      ...(s.height === undefined ? {} : { height: s.height }),
      validated: s.validated,
      ...(s.hourEnding === undefined ? {} : { hourEnding: s.hourEnding }),
      ...(s.hourEnding !== undefined && s.hourEnding < mainHour ? { olderReading: true as const } : {}),
      ...(distance === undefined ? {} : { distanceKm: distance }),
    };
  };
  const highFirst = [...reporting].sort((a, b) => b.value - a.value || a.kenn.localeCompare(b.kenn));
  const ordered = order === "highest" ? highFirst : [...highFirst].reverse();
  const top = highFirst[0] as StationReading & { value: number };
  const bottom = highFirst[highFirst.length - 1] as StationReading & { value: number };
  const notable = highFirst.filter((s) => s.value > NOTABLE_DOSE_RATE).map((s, i) => ranked(s, i + 1));
  const older = reporting.filter((s) => s.hourEnding !== undefined && s.hourEnding < mainHour);
  const oldest = older.reduce<StationReading | undefined>((o, s) => (o === undefined || (s.hourEnding ?? "") < (o.hourEnding ?? "") ? s : o), undefined);
  const notValidated = reporting.filter((s) => s.validated === false).length;
  const where = area.filter.label === "Germany" ? "" : ` ${area.filter.label}`;
  const verdictText =
    notable.length === 0
      ? `All ${reporting.length} readings${where} are at normal background (max ${top.value} µSv/h at ${top.name}, ${top.kenn}). Nothing elevated.`
      : `${notable.length} station${notable.length === 1 ? " reads" : "s read"} above ${NOTABLE_DOSE_RATE} µSv/h, more than the network's usual background (${notable.slice(0, 3).map((s) => `${s.name} ${s.value}`).join(", ")}): check the station's own trend (getStationTrend) and its neighbours before calling it a rise; heavy rain raises the dose rate for a few hours.`;
  const notes = [
    ...area.notes,
    ...unplacedNote(network, area.filter),
    `latest is each station's newest reading, not one common hour: ${hourCounts.get(mainHour) ?? 0} for the hour ending ${mainHour}${older.length === 0 ? "" : `, ${older.length} older (back to ${oldest?.hourEnding}, ${oldest?.name}); ranked ones with an older reading carry olderReading`}.`,
    ...(skippedTotal === 0 ? [] : [`${skippedTotal} station${skippedTotal === 1 ? " has" : "s have"} no value (${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(", ")}) and ${skippedTotal === 1 ? "is" : "are"} not ranked: say so.`]),
    ...(notValidated === 0 ? [] : [`${notValidated} reading${notValidated === 1 ? " is" : "s are"} not marked validated (validated false): say so for any you name.`]),
    ...unitNotes(inArea),
    `Normal background is about ${NORMAL_BACKGROUND.min}–${NORMAL_BACKGROUND.max} µSv/h (most stations 0.07–0.15). The highest readings are high-altitude or granite sites, dose from the ground (valueTerrestrial) and from altitude (valueCosmic), normal for that site; the offshore platforms read lowest. Never present a reading at the top of that range as an alarm.`,
  ];
  return {
    status: "ok",
    searched,
    area: area.filter.label,
    stationCount: inArea.length,
    reporting: reporting.length,
    skipped: { total: skippedTotal, byStatus },
    verdict: notable.length === 0 ? "normal" : "notable",
    verdictText,
    max: ranked(top, 1),
    min: ranked(bottom, reporting.length),
    notable,
    hours,
    mainHour,
    olderReadings: older.length,
    notValidated,
    normalBackground: NORMAL_BACKGROUND,
    ranking: ordered.slice(0, limit).map((s, i) => ranked(s, order === "highest" ? i + 1 : reporting.length - i)),
    notes,
  };
}

// --- getStationsMap --------------------------------------------------------------------------------

/** The input of {@link getStationsMap}. */
export interface StationsMapInput extends AreaInput {
  /** Keep the stations without a value (for a coverage map), value null; default false (a dose heatmap). */
  includeDead?: boolean | undefined;
  /** Where the page of features starts (default 0). */
  offset?: number | undefined;
  /** Features per page (1–500, default 60: about 20,000 characters of JSON). */
  limit?: number | undefined;
}

/** A map point: the dose value promoted for colour scaling, a popup text. */
export interface MapFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    kenn: string;
    name: string;
    plz?: string;
    value: number | null;
    unit: string;
    status: string;
    hourEnding?: string;
    height?: number;
    validated: boolean | null;
    popup: string;
  };
}

/** The answer of {@link getStationsMap}. */
export type StationsMap =
  | {
      status: "ok";
      type: "FeatureCollection";
      searched: AreaSearched & { includeDead: boolean };
      /** Points on the map in all (every page). */
      total: number;
      features: MapFeature[];
      nextOffset?: number;
      /** Stations without a value, dropped (includeDead false) or kept with value null. */
      withoutValue: { count: number; kept: boolean };
      /** Stations whose coordinates lie outside Germany (or aren't numbers): left off, named. */
      leftOff: { kenn: string; name: string; status: string; coordinates: JsonValue }[];
      /** The values' range: clamp a colour ramp to it. */
      valueRange?: { min: number; max: number };
      notes: string[];
    }
  | { status: "ambiguous"; searched: AreaSearched; total: number; candidates: StationSummary[]; reason: string }
  | { status: "empty"; searched: AreaSearched & { includeDead?: boolean }; reason: string };

/**
 * The network as map-ready GeoJSON points ([lon, lat], EPSG:4326, never flipped): the dose value
 * at the top of each point's properties with a popup text; stations without a value dropped for a
 * heatmap (or kept, value null, for a coverage map); a point outside Germany (the BfS passes
 * coordinates through unchecked) left off and named. Paged; one request per page.
 */
export async function getStationsMap(client: StrahlenschutzClient, input: StationsMapInput = {}): Promise<StationsMap> {
  checkArea(input);
  const includeDead = input.includeDead === true;
  const offset = assertValid("offset", input.offset ?? 0, intRangeProblem(0, 100_000));
  const limit = assertValid("limit", input.limit ?? 60, limitProblem(500));
  const network = await loadNetwork(client);
  const area = resolveArea(network, input);
  if (area.status === "ambiguous") return area;
  const searched = { ...area.searched, includeDead };
  if (area.status === "empty") return { ...area, searched };
  // Stations with broken coordinates are in no geographic area (a note names them); for all of
  // Germany or a Land they are what leftOff names.
  const leftOff: { kenn: string; name: string; status: string; coordinates: JsonValue }[] = [];
  const points: MapFeature[] = [];
  let withoutValue = 0;
  for (const s of network.filter(area.filter.test)) {
    if (s.value === null) {
      withoutValue++;
      if (!includeDead) continue;
    }
    if (!inGermany(s.coordinates)) {
      leftOff.push({ kenn: s.kenn, name: s.name, status: s.status, coordinates: (s.coordinates ?? null) as JsonValue });
      continue;
    }
    points.push({
      type: "Feature",
      id: s.kenn,
      geometry: { type: "Point", coordinates: s.coordinates as [number, number] },
      properties: {
        kenn: s.kenn,
        name: s.name,
        ...(s.plz === undefined ? {} : { plz: s.plz }),
        value: s.value,
        unit: s.unit,
        status: s.status,
        ...(s.hourEnding === undefined ? {} : { hourEnding: s.hourEnding }),
        ...(s.height === undefined ? {} : { height: s.height }),
        validated: s.validated,
        popup: s.value === null ? `${s.name}: no reading (${noValueReason(s)})` : `${s.name}: ${s.value} ${s.unit}`,
      },
    });
  }
  const unplaced = unplacedNote(network, area.filter);
  if (points.length === 0) {
    return { status: "empty", searched, reason: `No station ${area.filter.label === "Germany" ? "of the network" : area.filter.label} ${includeDead ? "has usable coordinates" : "reports a value (includeDead: true maps the dead sensors too)"}.` };
  }
  if (offset >= points.length) {
    return { status: "empty", searched, reason: `The map has ${points.length} feature${points.length === 1 ? "" : "s"}; offset ${offset} is past its end (offsets 0–${points.length - 1}).` };
  }
  const values = points.map((p) => p.properties.value).filter((v): v is number => v !== null);
  const page = points.slice(offset, offset + limit);
  const next = offset + page.length;
  const notes = [
    ...area.notes,
    ...unplaced,
    includeDead
      ? `${withoutValue} station${withoutValue === 1 ? "" : "s"} without a value ${withoutValue === 1 ? "is" : "are"} kept with value null (defekt, Testbetrieb): style them grey, never as a dose.`
      : `${withoutValue} station${withoutValue === 1 ? "" : "s"} without a value (defekt, Testbetrieb) ${withoutValue === 1 ? "is" : "are"} dropped for a dose map: say so.`,
    ...(leftOff.length === 0 ? [] : [`${leftOff.length} station${leftOff.length === 1 ? " lies" : "s lie"} outside Germany by the BfS's coordinates and ${leftOff.length === 1 ? "is" : "are"} left off (leftOff): name ${leftOff.length === 1 ? "it" : "them"} to the user.`]),
    ...unitNotes(network.filter(area.filter.test)),
    "Coordinates are [lon, lat] (EPSG:4326) as the BfS gives them, rounded to 0.01° (about 1 km): fine for a national layer, not for street level.",
    `Colour on value (µSv/h) with a ramp clamped to the values' range${values.length === 0 ? "" : ` (${Math.min(...values)}–${Math.max(...values)})`}, about 0.05–0.25: a 0–1 ramp makes every station look the same.`,
    // Not the page's own bounds: a page the MCP server's size cap cuts keeps its notes whole.
    `The map has ${points.length} feature${points.length === 1 ? "" : "s"} in all: for a file, join every page's features, following nextOffset while there is one.`,
  ];
  return {
    status: "ok",
    type: "FeatureCollection",
    searched,
    total: points.length,
    features: page,
    ...(next < points.length ? { nextOffset: next } : {}),
    withoutValue: { count: withoutValue, kept: includeDead },
    leftOff,
    ...(values.length === 0 ? {} : { valueRange: { min: Math.min(...values), max: Math.max(...values) } }),
    notes,
  };
}

// --- getStationTrend -------------------------------------------------------------------------------

/** The input of {@link getStationTrend}. */
export interface StationTrendInput {
  /** A station: its kenn (9 digits) or its name ("Herrischried", "Berlin-Buch"). */
  station: string;
  /** The newest hours to read (1–168, default 48; the series holds about a week). */
  hours?: number | undefined;
  /** Add every hour (oldest first) for a chart (default false). */
  points?: boolean | undefined;
}

/** A value at an hour. */
export interface HourValue {
  value: number;
  hourEnding: string;
  validated: boolean | null;
}

/** A day of the window (UTC), from the hourly values. */
export interface DayMean {
  day: string;
  hours: number;
  mean: number;
  min: number;
  max: number;
}

/** A rise this large (µSv/h) of the newest hours over the station's baseline is a trend, not noise. */
export const TREND_STEP = 0.03;
/** A single hour this far (µSv/h) above the baseline is a spike. */
export const SPIKE_STEP = 0.05;
/** How many of the newest hours make "recent". */
const RECENT_HOURS = 6;
/** How many hours before the recent ones a short window reads for the station's baseline. */
const BASELINE_HOURS = 24;

/**
 * The hours getStationTrend reads for a window of `hours`: the window itself, and for a short one
 * as many more as give its recent hours (up to 6) a baseline of 24 hours before them; a window
 * judged against itself could never show a rise.
 */
export function trendHoursRead(hours: number): number {
  return Math.max(hours, Math.min(RECENT_HOURS, hours) + BASELINE_HOURS);
}

/** A newest reading this much older (ms) than the BfS's answer: the station has stopped reporting. */
const STALE_MS = 3 * 3_600_000;

/** "N hours" or "N days" for a span in ms (whole units, rounded down). */
function ageOf(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

/** The answer of {@link getStationTrend}. */
export type StationTrend =
  | {
      status: "ok";
      searched: { station: string; hours: number };
      station: StationSummary;
      window: { from: string; to: string; hours: number; values: number; gaps: number };
      latest: HourValue;
      min: HourValue;
      max: HourValue;
      mean: number;
      /** The station's own level: the median before the newest hours. */
      baseline: number;
      /** The mean of the newest hours (up to 6). */
      recentMean: number;
      change: number;
      /** steady, rising, falling or spike (a short bump), judged against the baseline. */
      verdict: "steady" | "rising" | "falling" | "spike";
      verdictText: string;
      /** Some hour is above NOTABLE_DOSE_RATE. */
      aboveBackground: boolean;
      notValidated: number;
      unit: string;
      days: DayMean[];
      points?: HourValue[];
      notes: string[];
    }
  | { status: "ambiguous"; searched: { station: string }; total: number; candidates: StationSummary[] }
  | { status: "empty"; searched: { station: string; hours?: number }; reason: string };

/** One hourly or daily step of a series. */
export interface SeriesPoint {
  start?: string;
  end: string;
  /** In µSv/h; null: no reading, or a unit that is no dose rate in µSv/h (then `unit` names it). */
  value: number | null;
  validated: boolean | null;
  /** The unit the BfS sent, when it can't be converted to µSv/h. */
  unit?: string;
}

function pointOfFeature(feature: Feature): SeriesPoint {
  const p = feature.properties;
  const unit = str(p["unit"]);
  const factor = microsievertFactor(unit);
  const value = factor === undefined ? null : scaled(numOrNull(p["value"]), factor);
  const start = str(p["start_measure"]);
  return {
    ...(start === undefined ? {} : { start }),
    end: str(p["end_measure"]) ?? "",
    value,
    validated: value === null ? null : p["validated"] === 1 ? true : p["validated"] === 2 ? false : null,
    ...(factor === undefined && unit !== undefined ? { unit } : {}),
  };
}

/** A note on series steps in a unit that is no dose rate in µSv/h (left without a value). */
function seriesUnitNotes(points: readonly SeriesPoint[]): string[] {
  const odd = points.filter((p) => p.unit !== undefined);
  if (odd.length === 0) return [];
  return [`${odd.length} value${odd.length === 1 ? " comes" : "s come"} in a unit that is no dose rate in µSv/h (${[...new Set(odd.map((p) => p.unit))].join(", ")}) and ${odd.length === 1 ? "is" : "are"} left out (value null): say so.`];
}

/** A station by kenn or name: the kenn and what is known of it, or why not. */
type StationLookup =
  | { status: "ok"; kenn: string; station: StationReading }
  | { status: "ambiguous"; total: number; candidates: StationSummary[] }
  | { status: "empty"; reason: string };

const KENN = /^\d{9}$/;

async function lookupStation(client: StrahlenschutzClient, station: string): Promise<StationLookup> {
  if (/^\d+$/.test(station)) {
    if (!KENN.test(station)) return { status: "empty", reason: `${quoteValue(station, 20)} is no station id: a kenn has 9 digits (083370490). findStations finds it by name.` };
    // The station's own entry (its name, status and postal code: the series carries no status).
    const known = (await client.latest({ station })).features.map(readingOf)[0];
    if (known === undefined) return { status: "empty", reason: `No station with kenn ${station} in the BfS network. Check the id with findStations.` };
    return { status: "ok", kenn: station, station: known };
  }
  const network = await loadNetwork(client);
  const named = stationsNamed(network, station);
  if (named.length === 1) return { status: "ok", kenn: (named[0] as StationReading).kenn, station: named[0] as StationReading };
  if (named.length === 0) {
    return { status: "empty", reason: `No station's name starts with ${quoteValue(station, 60)}. The BfS names stations by town or district (Herrischried, Berlin-Buch, München-Pasing); findStations searches parts of names, postal codes and Länder.` };
  }
  return { status: "ambiguous", total: named.length, candidates: named.slice(0, 25).map(summaryOf) };
}

/** Why a station's series is empty: unknown, or a real station without readings. */
async function whyEmpty(client: StrahlenschutzClient, kenn: string, known: StationReading | undefined, what: string): Promise<string> {
  const station = known ?? (await client.latest({ station: kenn })).features.map(readingOf)[0];
  if (station === undefined) return `No station with kenn ${kenn} in the BfS network. Check the id with findStations.`;
  return `${station.name} (${kenn}, ${station.status}) has no ${what}${station.status === "in Betrieb" ? "" : `: the station is ${station.status}`}. Its latest reading: ${station.value === null ? "none" : `${station.value} µSv/h for the hour ending ${station.hourEnding}`}.`;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/**
 * One station's hourly dose rate over the newest hours (read newest first: the series comes
 * oldest first, so a bare limit gave the oldest hours), with the latest value, min, max, mean, the
 * day means, and a verdict against the station's own baseline (a flat 0.22 at a granite site is
 * its normal level, not a rise; a few hundredths is noise). The station is looked up first (one
 * more request: by name in the network, by kenn its own entry, for its name and status); several
 * matches are ambiguous. An empty series is told apart: an unknown kenn, or a real station without
 * readings (defekt).
 */
export async function getStationTrend(client: StrahlenschutzClient, input: StationTrendInput): Promise<StationTrend> {
  const station = normalizeText(assertValid("station", input.station, textProblem));
  const hours = assertValid("hours", input.hours ?? 48, intRangeProblem(1, 168));
  const searched = { station, hours };
  const lookup = await lookupStation(client, station);
  if (lookup.status === "ambiguous") return { status: "ambiguous", searched: { station }, total: lookup.total, candidates: lookup.candidates };
  if (lookup.status === "empty") return { status: "empty", searched, reason: lookup.reason };
  const series = await client.timeseries(lookup.kenn, "ts-1h", { sortBy: "end_measure D", maxFeatures: trendHoursRead(hours) });
  const readNewestFirst = series.features.map(pointOfFeature);
  if (readNewestFirst.length === 0) return { status: "empty", searched, reason: await whyEmpty(client, lookup.kenn, lookup.station, "hourly readings in the last week") };
  const summary = summaryOf(lookup.station);
  type Valued = SeriesPoint & { value: number };
  const isValued = (p: SeriesPoint): p is Valued => p.value !== null;
  // The window is the newest `hours`; the hours read before it serve the baseline only.
  const oldestFirst = readNewestFirst.slice(0, hours).reverse();
  const valued = oldestFirst.filter(isValued);
  if (valued.length === 0) return { status: "empty", searched, reason: `${summary.name} (${summary.kenn}) has only empty hours (value null) in the newest ${hours}: no reading to judge.` };
  const at = (p: Valued): HourValue => ({ value: p.value, hourEnding: p.end, validated: p.validated });
  const values = valued.map((p) => p.value);
  // The newest hours (up to 6, never more than the window) against the median of the hours read
  // before them; with fewer than 3 such hours (a series that short) the median of all it has.
  const readValued = [...readNewestFirst].reverse().filter(isValued);
  const recentCount = Math.min(RECENT_HOURS, valued.length);
  const recent = readValued.slice(-recentCount);
  const before = readValued.slice(0, -recentCount);
  const baseline = round(median(before.length >= 3 ? before.map((p) => p.value) : readValued.map((p) => p.value)), 3);
  const recentMean = round(recent.reduce((sum, p) => sum + p.value, 0) / recent.length, 3);
  const change = round(recentMean - baseline, 3);
  const maxPoint = valued.reduce((m, p) => (p.value > m.value ? p : m));
  const minPoint = valued.reduce((m, p) => (p.value < m.value ? p : m));
  const verdict = change >= TREND_STEP ? "rising" : -change >= TREND_STEP ? "falling" : maxPoint.value - baseline >= SPIKE_STEP ? "spike" : "steady";
  const latest = valued[valued.length - 1] as SeriesPoint & { value: number };
  const notValidated = valued.filter((p) => p.validated === false).length;
  // The answer's own time (the WFS's timeStamp) says whether the newest reading is current.
  const answeredAt = Date.parse(series.timeStamp ?? "");
  const behind = Number.isFinite(answeredAt) ? answeredAt - Date.parse(latest.end) : 0;
  const stale = behind > STALE_MS ? `As of the hour ending ${latest.end}, ${ageOf(behind)} before the BfS's answer (${series.timeStamp}): the station has not reported since. ` : "";
  const judged = {
    steady: `Steady at the station's own level (about ${baseline} µSv/h, ${round(minPoint.value, 3)}–${round(maxPoint.value, 3)} in the window): no rising trend.`,
    rising: `Rising: the newest ${recent.length} hours average ${recentMean} µSv/h, ${change} above the station's baseline of ${baseline}. Rain raises the dose rate for a few hours (radon progeny washed out); check whether it falls back before suggesting anything else.`,
    falling: `Falling: the newest ${recent.length} hours average ${recentMean} µSv/h, ${-change} below the station's baseline of ${baseline} (often the end of a rain bump, or snow cover shielding the ground).`,
    // A spike whose newest hour is still that high is not over: never "back".
    spike:
      latest.value - baseline >= SPIKE_STEP
        ? `The newest hour (ending ${latest.end}) reads ${latest.value} µSv/h${latest.validated === false ? " (not validated)" : ""}, ${round(latest.value - baseline, 3)} above the station's baseline of ${baseline}: a jump in the latest hour, not over yet. Rain raises the dose rate for a few hours; ask again in an hour or two to see whether it falls back before suggesting anything else.`
        : `A short spike to ${maxPoint.value} µSv/h (hour ending ${maxPoint.end}${maxPoint.validated === false ? ", not validated" : ""}) over a baseline of ${baseline}, back to ${latest.value} now: typically rain, a benign cause.`,
  }[verdict];
  const verdictText = `${stale}${judged}`;
  const days = new Map<string, number[]>();
  for (const p of valued) {
    const day = (p.start ?? new Date(Date.parse(p.end) - 3_600_000).toISOString()).slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), p.value]);
  }
  const gaps = oldestFirst.length - valued.length;
  const notes = [
    "Hourly readings, newest hours of the series (about one week is kept); times are UTC, each value for the hour ending at its time.",
    `Normal background is about ${NORMAL_BACKGROUND.min}–${NORMAL_BACKGROUND.max} µSv/h; each site has its own flat level (high-altitude and granite sites 0.20–0.26 all week). Judge against the station's baseline, and treat a few hundredths of a µSv/h as noise.`,
    ...(before.length < 3
      ? [`The series has only ${before.length} hour${before.length === 1 ? "" : "s"} with a value before the newest ${recent.length}: the baseline includes the newest hours, so a rise may not show.`]
      : readValued.length > valued.length
        ? [`The verdict compares the newest ${recent.length} hour${recent.length === 1 ? "" : "s"} with the station's median over the ${before.length} hours before them, read for the baseline beyond the window asked.`]
        : []),
    ...(maxPoint.value > NOTABLE_DOSE_RATE ? [`Some hour is above ${NOTABLE_DOSE_RATE} µSv/h: compare with the station's history and neighbours (getDoseSnapshot around it) before calling it more than weather.`] : []),
    ...(notValidated === 0 ? [] : [`${notValidated} hour${notValidated === 1 ? " is" : "s are"} not marked validated${maxPoint.validated === false ? ", the highest among them: a spike not validated is not a confirmed rise" : ""}.`]),
    ...(stale === "" ? [] : [`The newest reading is for the hour ending ${latest.end}, ${ageOf(behind)} before the BfS answered (${series.timeStamp}): the station has stopped reporting, so the window and verdict describe that time, not now. Say so, and check its status with findStations.`]),
    ...seriesUnitNotes(oldestFirst),
    ...(gaps === 0 ? [] : [`${gaps} hour${gaps === 1 ? " has" : "s have"} no value (a gap) and ${gaps === 1 ? "is" : "are"} left out of min, max and mean.`]),
    "days are means of the hourly values per UTC day (a day with fewer than 24 hours is partial). The BfS's own daily series holds Flensburg (010010001) only.",
  ];
  return {
    status: "ok",
    searched,
    station: summary,
    window: { from: (oldestFirst[0] as SeriesPoint).start ?? (oldestFirst[0] as SeriesPoint).end, to: latest.end, hours, values: valued.length, gaps },
    latest: at(latest),
    min: at(minPoint),
    max: at(maxPoint),
    mean: round(values.reduce((sum, v) => sum + v, 0) / values.length, 3),
    baseline,
    recentMean,
    change,
    verdict,
    verdictText,
    aboveBackground: maxPoint.value > NOTABLE_DOSE_RATE,
    notValidated,
    unit: "µSv/h",
    days: [...days].map(([day, v]) => ({ day, hours: v.length, mean: round(v.reduce((s, x) => s + x, 0) / v.length, 3), min: Math.min(...v), max: Math.max(...v) })),
    ...(input.points === true ? { points: valued.map(at) } : {}),
    notes,
  };
}

// --- findStations ----------------------------------------------------------------------------------

/** The input of {@link findStations}. */
export interface FindStationsInput {
  /** A part of a station's name, a kenn (9 digits) or a postal code (or its first digits). */
  query?: string | undefined;
  /** A Land: name, abbreviation or code. */
  state?: string | undefined;
  /** A point (both lat and lon): the nearest stations first, with their distance. */
  lat?: number | undefined;
  lon?: number | undefined;
  /** Only stations with this status (in Betrieb, defekt, Testbetrieb). */
  status?: string | undefined;
  offset?: number | undefined;
  /** 1–100, default 20. */
  limit?: number | undefined;
}

/** The answer of {@link findStations}. */
export type StationSearch =
  | { status: "ok"; searched: Record<string, string | number>; total: number; stations: (StationReading & { distanceKm?: number })[]; nextOffset?: number; notes: string[] }
  | { status: "empty"; searched: Record<string, string | number>; reason: string };

/** The status values of the network. */
export const STATION_STATUSES = ["in Betrieb", "defekt", "Testbetrieb"] as const;

/**
 * Stations of the network with their latest reading, by a part of the name, a kenn, a postal code,
 * a Land, a status, or nearest to a point. One request (the whole network, filtered here: the WFS
 * has no name search).
 */
export async function findStations(client: StrahlenschutzClient, input: FindStationsInput = {}): Promise<StationSearch> {
  const query = input.query === undefined ? undefined : normalizeText(assertValid("query", input.query, textProblem));
  const land = input.state === undefined ? undefined : resolveLand(input.state);
  const point = pointOf(input.lat, input.lon);
  const status = input.status === undefined ? undefined : STATION_STATUSES.find((s) => fold(s) === fold(normalizeText(input.status as string)));
  if (input.status !== undefined && status === undefined) throw new StrahlValidationError(`Invalid status: expected one of ${STATION_STATUSES.join(", ")}.`);
  const offset = assertValid("offset", input.offset ?? 0, intRangeProblem(0, 100_000));
  const limit = assertValid("limit", input.limit ?? 20, limitProblem(100));
  const searched: Record<string, string | number> = {
    ...(query === undefined ? {} : { query }),
    ...(land === undefined ? {} : { state: land[2] }),
    ...(point === undefined ? {} : { lat: point[1], lon: point[0] }),
    ...(status === undefined ? {} : { status }),
  };
  const network = await loadNetwork(client);
  let found = network;
  const notes: string[] = [];
  if (query !== undefined) {
    if (KENN.test(query)) found = found.filter((s) => s.kenn === query);
    else if (/^\d{1,5}$/.test(query)) found = found.filter((s) => s.plz?.startsWith(query) === true);
    else {
      const named = stationsNamed(found, query);
      if (named.length > 0) found = named;
      else {
        // No word starts with it: any part of a name ("münchen" in Waldmünchen).
        const wanted = fold(query);
        found = found.filter((s) => fold(s.name).includes(wanted));
      }
    }
  }
  if (land !== undefined) found = found.filter((s) => s.kenn.startsWith(land[0]));
  if (status !== undefined) found = found.filter((s) => s.status === status);
  let stations: (StationReading & { distanceKm?: number })[];
  if (point !== undefined) {
    const placed = found.filter((s) => inGermany(s.coordinates));
    if (placed.length < found.length) notes.push(`${found.length - placed.length} station${found.length - placed.length === 1 ? " has" : "s have"} no usable coordinates and ${found.length - placed.length === 1 ? "is" : "are"} left out of the distance order.`);
    stations = placed
      .map((s) => ({ ...s, distanceKm: round(distanceKm(point, s.coordinates as [number, number]), 1) }))
      .sort((a, b) => a.distanceKm - b.distanceKm || a.kenn.localeCompare(b.kenn));
  } else {
    stations = [...found].sort((a, b) => a.name.localeCompare(b.name, "de") || a.kenn.localeCompare(b.kenn));
  }
  if (stations.length === 0) {
    return {
      status: "empty",
      searched,
      reason: `No station matches ${Object.entries(searched).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(", ") || "the search"}. Names are German towns or districts as the BfS writes them (München-Pasing, Berlin-Buch); try a shorter part, a postal code or a Land.`,
    };
  }
  if (offset >= stations.length) {
    return { status: "empty", searched, reason: `${stations.length} station${stations.length === 1 ? " matches" : "s match"}; offset ${offset} is past the end (offsets 0–${stations.length - 1}).` };
  }
  const page = stations.slice(offset, offset + limit);
  const next = offset + page.length;
  notes.push("value is the latest reading in µSv/h (null: no reading, the station is defekt or in Testbetrieb), for the hour ending at hourEnding (UTC); kenn is the id getStationTrend and getTimeseries take.");
  return { status: "ok", searched, total: stations.length, stations: page, ...(next < stations.length ? { nextOffset: next } : {}), notes };
}

// --- getTimeseries ---------------------------------------------------------------------------------

/** The input of {@link getTimeseries}. */
export interface TimeseriesInput {
  /** The station's kenn (9 digits). */
  station: string;
  /** hourly (default, about one week) or daily (Flensburg only). */
  resolution?: "hourly" | "daily" | undefined;
  /** newest (default) or oldest first. */
  order?: "newest" | "oldest" | undefined;
  offset?: number | undefined;
  /** 1–500, default 168. */
  limit?: number | undefined;
}

/** The answer of {@link getTimeseries}. */
export type Timeseries =
  | {
      status: "ok";
      searched: { station: string; resolution: string; order: string };
      station: { kenn: string; name: string; land?: string };
      /** The series' length, all pages together; absent when the WFS gave no usable count. */
      total?: number;
      points: SeriesPoint[];
      nextOffset?: number;
      unit: string;
      notes: string[];
    }
  | { status: "empty"; searched: { station: string; resolution: string; order: string }; reason: string };

/** The station whose daily series has values: the only one (26 Sep 2026, still on 19 Nov 2026). */
export const DAILY_SERIES_STATION = "010010001";

/**
 * One station's series as published, newest (or oldest) first, paged by the WFS. An empty series
 * is told apart: an unknown kenn, a daily series (Flensburg only), or a station without readings.
 */
export async function getTimeseries(client: StrahlenschutzClient, input: TimeseriesInput): Promise<Timeseries> {
  const station = normalizeText(assertValid("station", input.station, textProblem));
  if (!KENN.test(station)) throw new StrahlValidationError(`Invalid station: ${quoteValue(station, 40)} is no kenn (9 digits, 083370490). findStations finds it by name.`);
  const resolution = input.resolution ?? "hourly";
  if (resolution !== "hourly" && resolution !== "daily") throw new StrahlValidationError("Invalid resolution: expected hourly or daily.");
  const order = input.order ?? "newest";
  if (order !== "newest" && order !== "oldest") throw new StrahlValidationError("Invalid order: expected newest or oldest.");
  const offset = assertValid("offset", input.offset ?? 0, intRangeProblem(0, 100_000));
  const limit = assertValid("limit", input.limit ?? 168, limitProblem(500));
  const searched = { station, resolution, order };
  const series = await client.timeseries(station, resolution === "hourly" ? "ts-1h" : "ts-24h", {
    sortBy: order === "newest" ? "end_measure D" : "end_measure",
    maxFeatures: limit,
    startIndex: offset,
  });
  const points = series.features.map(pointOfFeature);
  // The count, from totalFeatures or numberMatched: GeoServer sends "unknown" when it didn't count,
  // and a count below what came back is no count of this series.
  const counts = [series.totalFeatures, series.numberMatched].filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0);
  const total = counts.find((n) => n >= offset + points.length);
  if (points.length === 0) {
    if (offset > 0 && counts[0] !== undefined) return { status: "empty", searched, reason: `The series has ${counts[0]} values; offset ${offset} is past its end.` };
    if (resolution === "daily" && station !== DAILY_SERIES_STATION) {
      return { status: "empty", searched, reason: `The BfS's daily series has values for Flensburg (${DAILY_SERIES_STATION}) only. Ask for resolution hourly, or getStationTrend's days for daily means of the hourly values.` };
    }
    return { status: "empty", searched, reason: await whyEmpty(client, station, undefined, `${resolution} readings`) };
  }
  const first = series.features[0]?.properties ?? {};
  const land = landOf(station);
  const next = offset + points.length;
  // Without a count, a full page may have more after it; a short one is the last.
  const more = total === undefined ? points.length === limit : next < total;
  return {
    status: "ok",
    searched,
    station: { kenn: station, name: str(first["name"]) ?? station, ...(land === undefined ? {} : { land }) },
    ...(total === undefined ? {} : { total }),
    points,
    ...(more ? { nextOffset: next } : {}),
    unit: "µSv/h",
    notes: [
      `${resolution === "hourly" ? "Hourly" : "Daily"} values as published, ${order} first; start and end are UTC. validated false: not marked validated (yet); value null: no reading.`,
      ...(resolution === "hourly" ? ["The hourly series holds about one week."] : []),
      ...seriesUnitNotes(points),
      ...(total === undefined ? [`The WFS did not say how many values the series has (no usable totalFeatures or numberMatched): total is left out${more ? "; nextOffset is given because this page is full, and the next one may be empty" : ""}.`] : []),
    ],
  };
}
