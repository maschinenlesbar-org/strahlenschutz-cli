// Domain types for the BfS ODL-Info open-data WFS (imis.bfs.de) — ambient gamma
// dose-rate (ODL) measurements across Germany, served as GeoJSON.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A GeoJSON geometry (typically a Point with [lon, lat]). */
export interface Geometry {
  type: string;
  coordinates: JsonValue;
}

/** One GeoJSON feature: a measurement (station + reading), shape varies by type. */
export interface Feature {
  type: string;
  id: string;
  geometry: Geometry | null;
  geometry_name?: string;
  properties: JsonObject;
}

/** A WFS GetFeature response (GeoJSON FeatureCollection). */
export interface FeatureCollection {
  type: "FeatureCollection";
  totalFeatures?: number | string;
  numberReturned?: number;
  timeStamp?: string;
  features: Feature[];
}

/** Common options for a feature query. */
export interface FeatureQuery {
  /** Restrict to a station by its `kenn` id (becomes `viewparams=kenn:<id>`). */
  station?: string;
  /** Property to sort by; append "+D" for descending. */
  sortBy?: string;
  /** Max features to return. */
  maxFeatures?: number;
  /** Offset for paging. */
  startIndex?: number;
}
