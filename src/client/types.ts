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
  /** Restrict to a station by its `kenn` id (becomes `CQL_FILTER=kenn='<id>'`). */
  station?: string;
  /**
   * Property to sort by; append " D" (a space) for descending, e.g. "end_measure D";
   * several keys are comma-separated ("end_measure D,kenn"). Defaults to
   * `DEFAULT_SORT_BY[kind]` (`kenn`, or `kenn,end_measure` for a time series), since
   * the service can only page a sorted result. A blank value ("" or whitespace), an
   * empty key or a direction other than `A`/`ASC`/`D`/`DESC` (any case) is rejected
   * with `StrahlValidationError` before any request — the WFS reads an unknown
   * direction as ascending. Sent normalised (`normalizeSortBy`): keys trimmed, inner
   * whitespace collapsed, the direction as `A` or `D`.
   */
  sortBy?: string;
  /** Max features to return (sent as the WFS 2.0 `count` parameter). */
  maxFeatures?: number;
  /** Offset for paging (WFS 2.0 `startIndex`); without `maxFeatures`, everything from it on. */
  startIndex?: number;
}
