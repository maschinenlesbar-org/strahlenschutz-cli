// Enum-like value sets. These const arrays double as runtime CLI choice
// validators and as TS union types.

/**
 * The WFS feature types published by the BfS ODL-Info open-data service:
 *   latest  — the most recent gamma dose-rate (ODL) reading per station
 *   ts-1h   — the hourly-averaged time series
 *   ts-24h  — the daily-averaged time series
 */
export const FeatureKindValues = ["latest", "ts-1h", "ts-24h"] as const;
export type FeatureKind = (typeof FeatureKindValues)[number];

/** Map a friendly feature kind to its WFS `typeName`. */
export const TYPE_NAMES: Record<FeatureKind, string> = {
  latest: "opendata:odlinfo_odl_1h_latest",
  "ts-1h": "opendata:odlinfo_timeseries_odl_1h",
  "ts-24h": "opendata:odlinfo_timeseries_odl_24h",
};
