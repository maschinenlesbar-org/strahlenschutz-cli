// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { FeatureKindValues, TimeseriesResolutionValues } from "./enums.js";
import { StrahlValidationError } from "./errors.js";

/** A rule: the reason `value` is invalid (e.g. `"Expected a non-empty value."`), or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw a {@link StrahlValidationError} with the message `Invalid <name>: <reason>`
 * when `problem(value)` finds a reason; otherwise return `value` unchanged. Call it
 * before any request, so a rejected input sends nothing. Async methods call it
 * inside their body, so the rejection arrives as a rejected promise rather than a
 * synchronous throw.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new StrahlValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** True for an empty or whitespace-only string. */
export function isBlank(value: string): boolean {
  return value.trim() === "";
}

/**
 * A query value given explicitly must be a non-blank string. A blank `sortBy` would
 * be sent as `sortBy=` and replace the default sort, which GeoServer needs to page
 * (`startIndex` on an unsorted query is an HTTP 400) and to give a stable order.
 */
export const nonEmptyProblem: Problem<unknown> = (value) =>
  typeof value !== "string" || isBlank(value) ? "Expected a non-empty value." : undefined;

/** A short description of a rejected value for a message: a string quoted, anything else as is. */
function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * A value must be one of `allowed`. Checked with `includes()` on the value list,
 * never by a keyed table lookup, so inherited names such as `__proto__`,
 * `toString` or `constructor` are rejected too.
 */
export function oneOfProblem(allowed: readonly string[]): Problem<unknown> {
  return (value) =>
    (allowed as readonly unknown[]).includes(value)
      ? undefined
      : `Expected one of: ${allowed.join(", ")} (got ${describe(value)}).`;
}

/** The feature kind of `getFeature()`: one of `FeatureKindValues`. */
export const featureKindProblem: Problem<unknown> = oneOfProblem(FeatureKindValues);

/**
 * The resolution of `timeseries()`: one of `TimeseriesResolutionValues` (`ts-1h`,
 * `ts-24h`). `latest` is a feature kind but not a time series: it would silently
 * return the latest-reading layer in the shape of a one-point series.
 */
export const timeseriesResolutionProblem: Problem<unknown> = oneOfProblem(TimeseriesResolutionValues);
