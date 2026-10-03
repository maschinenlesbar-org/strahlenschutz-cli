// StrahlenschutzClient — a typed client over the open (no-auth) ODL-Info WFS of
// the Bundesamt für Strahlenschutz (https://www.imis.bfs.de/ogc/opendata/ows).
//
// The service is an OGC WFS 2.0; this client fixes the boilerplate WFS
// parameters (service=WFS, request=GetFeature, outputFormat=json) and exposes
// the feature types as friendly methods.
//
//   client.latest({ maxFeatures: 5 })
//   client.station("091811461")
//   client.timeseries("091811461", "ts-24h")

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { TYPE_NAMES, type FeatureKind, type TimeseriesResolution } from "./enums.js";
import { StrahlError, StrahlNotFoundError, StrahlParseError } from "./errors.js";
import { assertValid, featureKindProblem, nonEmptyProblem, timeseriesResolutionProblem } from "./validate.js";
import type { FeatureCollection, FeatureQuery } from "./types.js";

const OWS = "/ogc/opendata/ows";

// The BfS service speaks WFS 2.0, where the result-limit parameter is `count`
// (the WFS 1.x `maxFeatures` is silently ignored). A `startIndex` needs no
// `count`: with a `sortBy` (always sent, see below) the server returns everything
// from the offset on.

/**
 * The sort the client sends when the caller gives none. The BfS layers have no
 * primary key, so GeoServer refuses any `startIndex` on an unsorted query with
 * HTTP 400 ("Cannot do natural order without a primary key"). Sorting every
 * query by a stable key makes paging work and keeps pages consistent with an
 * unpaged `--max` request: `kenn` is unique per station in `latest`, and
 * `kenn,end_measure` orders a time series oldest first, station by station (the
 * order the service used anyway). A caller's own `sortBy` replaces it.
 */
export const DEFAULT_SORT_BY: Record<FeatureKind, string> = {
  latest: "kenn",
  "ts-1h": "kenn,end_measure",
  "ts-24h": "kenn,end_measure",
};

// A BfS `kenn` station id is a fixed-format numeric identifier. We validate the
// shape (digits only, non-empty) at the domain boundary before splicing it into
// the server-side `CQL_FILTER` (e.g. `kenn='<id>'`). The value is also
// percent-encoded via URLSearchParams downstream — this allow-list is
// defence in depth, turning the implicit encoding guarantee into an explicit one.
// Because the filter is restricted to digits the surrounding quotes are safe.
const KENN_PATTERN = /^\d+$/;

function assertKenn(kenn: string): string {
  if (!KENN_PATTERN.test(kenn)) {
    throw new StrahlError(
      `Invalid station id "${kenn}". Expected a non-empty numeric kenn (digits only).`,
    );
  }
  return kenn;
}

/**
 * A paging value (`maxFeatures` → `count`, `startIndex`) must be a non-negative
 * safe integer: the query builder would otherwise send `count=NaN`, `count=-5` or
 * `count=1.5` as typed. The CLI's parsers already guard this; library callers get
 * the same check here, before any request.
 */
function assertPagingInt(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    const got = typeof value === "string" ? JSON.stringify(value) : String(value);
    throw new StrahlError(`Invalid ${name}: expected a non-negative integer, got ${got}.`);
  }
  return value;
}

/**
 * Runtime shape guard for the WFS response. `getJson` casts the parsed body to
 * `T` with no runtime check, so a 200 reply that is valid JSON but not a
 * FeatureCollection (`{}`, `{"features":null}`) would otherwise flow through as
 * a `FeatureCollection` and only fail later when a caller dereferences
 * `features.length` — surfacing as an untyped "Unexpected error". Each feature
 * must also be a JSON object with a `properties` object (callers read
 * `f.properties.value`, and `station` must not report `[null]` as a found
 * station). Only this top-level shape is checked, never the property schema.
 */
function assertFeatureCollection(value: unknown): FeatureCollection {
  if (!isObject(value) || !Array.isArray(value["features"])) {
    throw new StrahlParseError(
      "Unexpected response shape from the WFS: expected a GeoJSON FeatureCollection " +
        "(an object with a `features` array).",
    );
  }
  value["features"].forEach((feature: unknown, i) => {
    const problem = !isObject(feature) ? `is ${kindOf(feature)}` : !isObject(feature["properties"]) ? "has none" : undefined;
    if (problem !== undefined) {
      throw new StrahlParseError(
        "Unexpected response shape from the WFS: expected every feature to be a JSON object " +
          `with a properties object, feature ${i} ${problem}.`,
      );
    }
  });
  return value as unknown as FeatureCollection;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A short description of a JSON value for a shape error ("null", "a string", …). */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

export class StrahlenschutzClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Generic WFS GetFeature for one of the published feature kinds. A `kind`
   * outside `FeatureKindValues` is a `StrahlValidationError` before any request.
   */
  async getFeature(kind: FeatureKind, query: FeatureQuery = {}): Promise<FeatureCollection> {
    assertValid("kind", kind, featureKindProblem);
    const params: QueryParams = {
      service: "WFS",
      request: "GetFeature",
      typeName: TYPE_NAMES[kind],
      outputFormat: "application/json",
    };
    if (query.station !== undefined) params["CQL_FILTER"] = `kenn='${assertKenn(query.station)}'`;
    // A sortBy given explicitly must not be blank: `sortBy=` would replace the
    // default sort that paging needs (GeoServer answers HTTP 400 to a `startIndex`
    // on an unsorted query). Only `undefined` selects the default.
    params["sortBy"] =
      query.sortBy === undefined ? DEFAULT_SORT_BY[kind] : assertValid("sortBy", query.sortBy, nonEmptyProblem);
    // WFS 2.0: the limit is `count` (not the WFS 1.x `maxFeatures`). A `startIndex`
    // without one returns the rest of the collection from that offset.
    if (query.maxFeatures !== undefined) params["count"] = assertPagingInt("maxFeatures", query.maxFeatures);
    if (query.startIndex !== undefined) params["startIndex"] = assertPagingInt("startIndex", query.startIndex);
    return assertFeatureCollection(await this.engine.getJson<unknown>(OWS, params));
  }

  /** The latest ODL reading per station (optionally filtered/limited). */
  latest(query: FeatureQuery = {}): Promise<FeatureCollection> {
    return this.getFeature("latest", query);
  }

  /**
   * The latest reading for a single station by its `kenn` id. The WFS answers an
   * unknown `kenn` with an empty FeatureCollection (HTTP 200), never a 404, so an
   * empty result here means the station does not exist: it rejects with
   * `StrahlNotFoundError`. (`latest({ station })` and `timeseries()` pass an empty
   * collection through, since a real station can have no readings in a series.)
   */
  async station(kenn: string): Promise<FeatureCollection> {
    const result = await this.getFeature("latest", { station: kenn });
    if (result.features.length === 0) {
      throw new StrahlNotFoundError(`No station found for kenn "${kenn}".`);
    }
    return result;
  }

  /**
   * The hourly (default) or daily time series for a single station. A
   * `resolution` outside `TimeseriesResolutionValues` (`latest` included) is a
   * `StrahlValidationError` before any request.
   */
  async timeseries(
    kenn: string,
    resolution: TimeseriesResolution = "ts-1h",
    query: FeatureQuery = {},
  ): Promise<FeatureCollection> {
    assertValid("resolution", resolution, timeseriesResolutionProblem);
    return this.getFeature(resolution, { ...query, station: kenn });
  }
}
