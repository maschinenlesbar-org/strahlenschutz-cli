// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { FeatureKindValues, TimeseriesResolutionValues } from "./enums.js";
import { StrahlValidationError, cutForMessage } from "./errors.js";

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

/**
 * An id or name as the user meant it: surrounding whitespace dropped (a copy-pasted
 * `" 083370490 "`, a trailing newline from a file) and Unicode NFC applied, so the same
 * text always goes out the same way. No case-folding: the WFS compares ids and property
 * names case-sensitively. A non-string value is returned unchanged for the type check
 * that follows.
 */
export function normalizeInput<T>(value: T): T {
  return (typeof value === "string" ? value.trim().normalize("NFC") : value) as T;
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

/** One sort key, split into its property and direction token (if any). */
function sortKeyParts(key: string): string[] {
  return key.trim().split(/\s+/).filter((t) => t !== "");
}

/** The canonical direction for a token GeoServer reads (any case), or undefined. */
function sortDirection(token: string): "A" | "D" | undefined {
  const t = token.toUpperCase();
  if (t === "A" || t === "ASC") return "A";
  if (t === "D" || t === "DESC") return "D";
  return undefined;
}

/**
 * A WFS `sortBy`: comma-separated keys, each a property name with an optional
 * direction — `A`/`ASC` (ascending) or `D`/`DESC` (descending), any case. GeoServer
 * reads any other direction token (`DSC`, `X`), and a key with two spaces before the
 * direction, as ascending with HTTP 200: `"end_measure DSC"` returned the oldest hours
 * where the newest were meant. Whitespace is fine here (normalizeSortBy collapses it);
 * an unknown direction, an empty key (`kenn,,value`) or a third word is the problem.
 */
export const sortByProblem: Problem<unknown> = (value) => {
  const blank = nonEmptyProblem(value);
  if (blank !== undefined) return blank;
  for (const key of (value as string).split(",")) {
    const parts = sortKeyParts(key);
    if (parts.length === 0) return "Expected comma-separated sort keys, got an empty one.";
    if (parts.length > 2) {
      return `Expected "<property>" or "<property> D" per sort key, got ${JSON.stringify(cut(key.trim()))}.`;
    }
    const direction = parts[1];
    if (direction !== undefined && sortDirection(direction) === undefined) {
      return (
        `Unknown sort direction ${JSON.stringify(cut(direction))} in ${JSON.stringify(cut(key.trim()))}; ` +
        "use D or DESC for descending, A or ASC for ascending (the WFS reads anything else as ascending)."
      );
    }
  }
  return undefined;
};

/**
 * A `sortBy` that passed {@link sortByProblem}, in the form the client sends: each key
 * trimmed, whitespace inside it collapsed to one space, the direction as `A` or `D`
 * (`" end_measure  desc , kenn"` → `"end_measure D,kenn"`). Property names are kept as
 * typed: the WFS compares them case-sensitively and answers a wrong one with HTTP 400.
 */
export function normalizeSortBy(value: string): string {
  return value
    .split(",")
    .map((key) => {
      const [property, direction] = sortKeyParts(key);
      return direction === undefined ? (property ?? "") : `${property} ${sortDirection(direction) ?? direction}`;
    })
    .join(",");
}

/** A value cut to 60 characters for a message, never inside a surrogate pair. */
function cut(text: string): string {
  return cutForMessage(text, 60);
}

/**
 * A short description of a rejected value for a message: a string quoted, anything else
 * as is, cut at `MAX_QUOTED_LENGTH` (200) characters.
 */
function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(cutForMessage(value)) : cutForMessage(String(value));
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

/**
 * A query object may hold only the `allowed` keys. GeoServer ignores a parameter it
 * doesn't know, and the client used to ignore a query key it doesn't know: a misspelled
 * `{ statoin: "083370490" }` returned the whole network with no error. An own
 * `__proto__` key (from `JSON.parse`) counts as unknown too. `undefined` is fine (no
 * query); anything but a plain object is not.
 */
export function queryKeysProblem(allowed: readonly string[]): Problem<unknown> {
  return (value) => {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "Expected an object.";
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        return `Unknown key ${JSON.stringify(cut(key))}; expected one of: ${allowed.join(", ")}.`;
      }
    }
    return undefined;
  };
}

/**
 * A number must be a safe integer from `min` to `max`. The reasons are worded like
 * the CLI's integer parsers ("Must be <= 10."), which call this rule for their bounds.
 */
export function intRangeProblem(min: number, max: number): Problem<unknown> {
  return (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      return min >= 0 ? "Expected a non-negative integer." : "Expected an integer.";
    }
    if (value < min) return `Must be >= ${min}.`;
    if (value > max) return `Must be <= ${max}.`;
    return undefined;
  };
}

/**
 * A value that goes into an HTTP header (the User-Agent): non-blank, no C0 control
 * or DEL (tab is allowed, as in HTTP), nothing above U+00FF. A blank value would be
 * sent as an empty header; Node's HTTP layer refuses the others with an opaque
 * "Invalid character in header content" TypeError at request time, and an injected
 * transport would send a CR/LF value as is (header injection). Checked by char code
 * so the source stays free of control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string" || isBlank(value)) return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * Whitespace and control characters in a base URL. `new URL()` silently trims
 * surrounding whitespace and strips an inner tab or newline, so the URL checks
 * pass, but the engine appends the WFS path to the raw string: `"https://h/ "`
 * would request `/%20/ogc/...`, and a custom transport would get the padded value.
 */
export const baseUrlWhitespaceProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "A base URL cannot contain whitespace or control characters.";
  return undefined;
};

/**
 * The full base-URL rule set, in order: no whitespace or control characters
 * (baseUrlWhitespaceProblem), an absolute URL, an `http:`/`https:` scheme, and no
 * query or fragment. The WFS path is appended to the base URL as a string, so a
 * `?` or `#` would swallow it (`http://h/#f` requests `/`). A path prefix is fine,
 * and so is userinfo (the engine sends it as Basic auth, e.g. for a mirror); a `%` in
 * it must start a valid escape (`%25` for a literal one). The reasons name no URL, so
 * a credential in it never reaches a message.
 */
export const baseUrlProblem: Problem<unknown> = (value) => {
  const whitespace = baseUrlWhitespaceProblem(value);
  if (whitespace !== undefined) return whitespace;
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    return "Expected a valid absolute URL (e.g. https://host).";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return 'Only "http:" and "https:" base URLs are supported.';
  }
  if (/[?#]/.test(value as string)) return "A base URL cannot have a query (?) or fragment (#).";
  // The userinfo is percent-decoded for the Authorization header; a "%" that isn't an
  // escape would fail there ("URI malformed") at request time. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};
