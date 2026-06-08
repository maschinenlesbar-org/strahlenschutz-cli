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
import { TYPE_NAMES, type FeatureKind } from "./enums.js";
import { StrahlError } from "./errors.js";
import type { FeatureCollection, FeatureQuery } from "./types.js";

const OWS = "/ogc/opendata/ows";

// The BfS service speaks WFS 2.0, where the result-limit parameter is `count`
// (the WFS 1.x `maxFeatures` is silently ignored). Paging with `startIndex` is
// only honoured when a `count` accompanies it — a bare `startIndex` is rejected
// with HTTP 400 — so when a caller pages without an explicit limit we fall back
// to this server-side default page size.
const DEFAULT_PAGE_COUNT = 1000;

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

export class StrahlenschutzClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /** Generic WFS GetFeature for one of the published feature kinds. */
  async getFeature(kind: FeatureKind, query: FeatureQuery = {}): Promise<FeatureCollection> {
    const params: QueryParams = {
      service: "WFS",
      request: "GetFeature",
      typeName: TYPE_NAMES[kind],
      outputFormat: "application/json",
    };
    if (query.station !== undefined) params["CQL_FILTER"] = `kenn='${assertKenn(query.station)}'`;
    if (query.sortBy !== undefined) params["sortBy"] = query.sortBy;
    // WFS 2.0: the limit is `count` (not the WFS 1.x `maxFeatures`). `startIndex`
    // is only honoured alongside a `count`, so supply one when paging without an
    // explicit limit, otherwise the server answers HTTP 400.
    if (query.maxFeatures !== undefined) params["count"] = query.maxFeatures;
    else if (query.startIndex !== undefined) params["count"] = DEFAULT_PAGE_COUNT;
    if (query.startIndex !== undefined) params["startIndex"] = query.startIndex;
    return this.engine.getJson(OWS, params);
  }

  /** The latest ODL reading per station (optionally filtered/limited). */
  latest(query: FeatureQuery = {}): Promise<FeatureCollection> {
    return this.getFeature("latest", query);
  }

  /** The latest reading for a single station by its `kenn` id. */
  station(kenn: string): Promise<FeatureCollection> {
    return this.getFeature("latest", { station: kenn });
  }

  /** The hourly (default) or daily time series for a single station. */
  timeseries(
    kenn: string,
    resolution: Extract<FeatureKind, "ts-1h" | "ts-24h"> = "ts-1h",
    query: FeatureQuery = {},
  ): Promise<FeatureCollection> {
    return this.getFeature(resolution, { ...query, station: kenn });
  }
}
