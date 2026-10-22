// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { FeatureKindValues, TimeseriesResolutionValues } from "./enums.js";
import { StrahlValidationError, cutForMessage, quoteValue } from "./errors.js";

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

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no value" upstream, or matches nothing, so it is refused as blank.
 */
export function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter, or undefined when it can. The WFS takes no free
 * text today; the rule is the kit's, exported for a library caller and a future text parameter.
 * Refused, before any request, as an API would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`): an empty filter reads as "no filter";
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes a search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/**
 * A text filter as an API matches it: without surrounding whitespace and in composed Unicode,
 * NFC (a decomposed "Müller", u plus U+0308 as pasted from a macOS file name, matched nothing).
 * Inner whitespace is kept.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is a value the WFS
 * compares exactly: the station id `kenn`, a sort key, the resolution (a closed set). The rules
 * apply to the value with surrounding whitespace trimmed, as it is sent ({@link normalizeToken}):
 * not blank (and not only invisible characters or combining marks), no lone surrogate, and no
 * control or format character at all (a zero-width space, ZWJ, a soft hyphen, a bidi control),
 * since an invisible character in a code only ever makes it match nothing. The reason quotes the
 * value visibly (`"\u200b091811461" contains an invisible or control character (U+200B).`).
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/**
 * A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem}
 * first. A non-string value is returned unchanged.
 */
export function normalizeToken<T>(value: T): T {
  return (typeof value === "string" ? value.trim().normalize("NFC") : value) as T;
}

/**
 * The items of a comma-separated list, as typed: each item is checked (`listProblem`) and
 * canonicalised (`normalizeToken`) on its own, so `"a1, a2"` sends `a2`, and `"a1,,a2"`, `"a1,"`
 * and `","` are refused rather than sent as an empty item (which an API may read as "no
 * filter"). The WFS takes no list option today; the rule is the kit's.
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all (an empty list reads as "no filter"), or an item that `itemProblem` refuses (by
 * default {@link tokenProblem}: a blank item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
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
 * A property name as GeoServer knows it: an XML name (a letter or "_", then letters, digits,
 * "_", "." or "-"), with an optional namespace prefix (`opendata:end_measure`). `kenn+D` (a
 * direction typed without its space), `..` or `a/b` are no property names.
 */
const PROPERTY_NAME = /^(?:[\p{L}_][\p{L}\p{N}_.-]*:)?[\p{L}_][\p{L}\p{N}_.-]*$/u;

/**
 * What a sort value may not hold once trimmed: a token's control and format characters (but TAB,
 * which separates a property from its direction like a space), and the line and paragraph
 * separators U+2028/U+2029 (whitespace to a split, a line break to a terminal).
 */
const SORT_INVISIBLE = /(?!\t)[\p{Cc}\p{Cf}\u2028\u2029]/u;

/**
 * A WFS `sortBy`: comma-separated keys, each a property name with an optional
 * direction — `A`/`ASC` (ascending) or `D`/`DESC` (descending), any case. GeoServer
 * reads any other direction token (`DSC`, `X`), and a key with two spaces before the
 * direction, as ascending with HTTP 200: `"end_measure DSC"` returned the oldest hours
 * where the newest were meant. The value is checked as a token ({@link tokenProblem}): not
 * blank (or only invisible characters), no lone surrogate, no control or format character (a
 * zero-width space pasted along made a property name that looks right but matched nothing);
 * only a TAB may stand where a space does. Whitespace between
 * a property and its direction is fine (normalizeSortBy collapses it); an unknown direction, an
 * empty key (`kenn,,value`), a third word, or a property that is no XML name (`kenn+D`, `..`,
 * `a/b`) is the problem. The reasons quote the value visibly (`quoteValue`).
 */
export const sortByProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string" || isBlank(value)) return "Expected a non-empty value.";
  const trimmed = value.trim();
  if (LONE_SURROGATE.test(trimmed)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (SORT_INVISIBLE.test(trimmed)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(trimmed, SORT_INVISIBLE)}).`;
  }
  for (const key of value.split(",")) {
    const parts = sortKeyParts(key);
    if (parts.length === 0) return "Expected comma-separated sort keys, got an empty one.";
    if (parts.length > 2) {
      return `Expected "<property>" or "<property> D" per sort key, got ${quote(key.trim())}.`;
    }
    const [property = "", direction] = parts;
    if (!PROPERTY_NAME.test(property.normalize("NFC"))) {
      return (
        `Expected a property name (a letter or "_", then letters, digits, "_", "." or "-"), got ${quote(property)}` +
        (direction === undefined ? "." : ` in ${quote(key.trim())}.`)
      );
    }
    if (direction !== undefined && sortDirection(direction) === undefined) {
      return (
        `Unknown sort direction ${quote(direction)} in ${quote(key.trim())}; ` +
        "use D or DESC for descending, A or ASC for ascending (the WFS reads anything else as ascending)."
      );
    }
  }
  return undefined;
};

/**
 * A `sortBy` that passed {@link sortByProblem}, in the form the client sends: each key
 * trimmed, whitespace inside it collapsed to one space, the property name in composed Unicode
 * (NFC), the direction as `A` or `D` (`" end_measure  desc , kenn"` → `"end_measure D,kenn"`).
 * No case-folding: the WFS compares property names case-sensitively and answers a wrong one with
 * HTTP 400.
 */
export function normalizeSortBy(value: string): string {
  return value
    .split(",")
    .map((key) => {
      const [property = "", direction] = sortKeyParts(key);
      const name = normalizeToken(property);
      return direction === undefined ? name : `${name} ${sortDirection(direction) ?? direction}`;
    })
    .join(",");
}

/** A value quoted visibly for a message (`quoteValue`), cut at 60 characters, never inside a surrogate pair. */
function quote(text: string): string {
  return quoteValue(text, 60);
}

/**
 * A short description of a rejected value for a message: a string quoted visibly (an
 * invisible, format or control character escaped, `"a\u200bb"`), anything else as is, cut at
 * `MAX_QUOTED_LENGTH` (200) characters.
 */
function describe(value: unknown): string {
  return typeof value === "string" ? quoteValue(value) : cutForMessage(String(value));
}

/**
 * A value must be one of `allowed`, as a token: a string is checked with {@link tokenProblem}
 * (not blank, no invisible, control or half character, quoted visibly), then trimmed and in NFC
 * ({@link normalizeToken}) and looked up, so `" ts-24h "` is `ts-24h` (the caller sends
 * `normalizeToken(value)`). Case is not folded: `TS-1H` is refused. Checked with `includes()` on
 * the value list, never by a keyed table lookup, so inherited names such as `__proto__`,
 * `toString` or `constructor` are rejected too.
 */
export function oneOfProblem(allowed: readonly string[]): Problem<unknown> {
  return (value) => {
    if (typeof value === "string") {
      const token = tokenProblem(value);
      if (token !== undefined) return token;
      if (allowed.includes(normalizeToken(value))) return undefined;
    }
    return `Expected one of: ${allowed.join(", ")} (got ${describe(value)}).`;
  };
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
        return `Unknown key ${quote(key)}; expected one of: ${allowed.join(", ")}.`;
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
