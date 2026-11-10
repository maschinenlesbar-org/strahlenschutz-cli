// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { constants } from "node:buffer";
import { TextDecoder } from "node:util";
import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  StrahlApiError,
  StrahlError,
  StrahlNetworkError,
  StrahlParseError,
  StrahlValidationError,
  TextBuilder,
  credentialsIn,
  cutForMessage,
  cutText,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
  redactUrl,
  urlForMessage,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerValueProblem, intRangeProblem } from "./validate.js";

export const DEFAULT_BASE_URL = "https://www.imis.bfs.de";
const DEFAULT_USER_AGENT = "strahlenschutz-cli";

/** Most retries `maxRetries` may ask for: the bound protects the public BfS service. */
export const MAX_RETRIES = 10;

/** Most redirects `maxRedirects` may allow. */
export const MAX_REDIRECTS = 10;

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
  /** The URL that answered (after any redirects). */
  url: string;
  /**
   * That URL as messages name it: without userinfo, and after a redirect the `Location` with the
   * base URL's credentials scrubbed as sent, then resolved (a server can echo them there).
   */
  shownUrl: string;
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://www.imis.bfs.de */
  baseUrl?: string | undefined;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport | undefined;
  /**
   * Value of the User-Agent header: non-blank, no control characters (tab
   * allowed), nothing above U+00FF. Defaults to `strahlenschutz-cli`.
   */
  userAgent?: string | undefined;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: an integer from 0 (disables) to MAX_TIMEOUT_MS (2^31 - 1 ms).
   * Defaults to 30 s. Enforced by the engine for every transport.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections (GET/HEAD only), an integer from
   * 0 to MAX_RETRIES (10); defaults to 2. Each waits `retryDelayMs * attempt`, or
   * longer if the response's `Retry-After` asks (up to `MAX_RETRY_AFTER_MS`; a longer
   * one is not retried, and the error names the requested wait).
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (grows linearly), an integer from 0
   * to `MAX_RETRY_AFTER_MS` (30 000); the floor under any Retry-After. Defaults to 200.
   */
  retryDelayMs?: number | undefined;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, an integer from 0 to
   * MAX_REDIRECTS (10). Defaults to 5.
   */
  maxRedirects?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative safe integer. Defaults to
   * 100 MiB; set to 0 for no limit. Enforced by the engine for every transport.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Called with a one-line warning about an answer the engine delivered changed: characters
   * that were not valid text — invalid bytes in the declared (or default UTF-8) charset, or a
   * lone surrogate written as a JSON escape — replaced with U+FFFD. The message names the
   * request and the count (`GET <url>: 2 characters of the answer were not valid text …`).
   * Without it the replacement is silent. A throw is swallowed. The CLI logs it as a `WARN`
   * record of `strahlenschutz.api`.
   */
  onWarning?: ((message: string) => void) | undefined;
  /**
   * Member names whose number values may exceed 2^53 (a Solr `_version_`, a 64-bit id). The value
   * of a declared member is delivered as its exact literal, as written, as a JSON string (`"5"`),
   * so its type never depends on its size. A declared member whose value is not a number (a
   * string, `null`, an object) is left as it is. Every undeclared number keeps the rule: exact,
   * or a StrahlParseError. Matched by name anywhere in a JSON answer, an escaped name
   * (`"\u005fversion_"`) included. Defaults to none (the BfS WFS needs none: `kenn` is a string,
   * the readings are decimals); anything but a set or list of non-empty strings makes the
   * constructor throw a StrahlValidationError. The set is copied.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * The most server text (in UTF-16 units) `sanitizeServerText` reads; a longer text is cut first.
 * Every message keeps far less of it (MAX_DETAIL_LENGTH, 500 characters; a foreign kenn 20), and
 * cleaning all of a 16 MB error detail, one string node per character, exhausted a small heap.
 */
const MAX_SERVER_TEXT = 16 * 1024;

/**
 * A whole terminal escape sequence: a CSI (`ESC [` or the 8-bit U+009B, parameters,
 * intermediates, final byte), a terminated control string (OSC/DCS/SOS/PM/APC, `ESC ]` …
 * up to BEL or ST, or their 8-bit forms) or a short `ESC` sequence. Dropping only the
 * control bytes left the printable rest behind (`ESC ] 0 ; title BEL` became `]0;title`).
 * An unterminated control string is left to the per-character filter, so it cannot
 * swallow the rest of the message. A control string's body ends at an ESC or at another
 * introducer: with the introducers allowed inside it, an unterminated run of them would be
 * matched from each one to the end of the text, quadratic. Written with escapes, so the source
 * holds no control bytes.
 */
const ESCAPE_SEQUENCE =
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u0090\u0098\u009c-\u009f]*(?:\u0007|\u001b\\|\u009c)|\u001b[ -/]*[0-~]/g;

/**
 * What `sanitizeServerText` drops once the escape sequences are gone: the C0 controls but the
 * whitespace ones (TAB to CR), DEL, the C1 controls, and every format character (General
 * Category Cf: bidi controls, zero-width characters, U+00AD, U+FEFF, …).
 */
const DROPPED_CHAR = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\p{Cf}]/gu;

/**
 * Make a string that originates in an attacker-controlled response — the error `detail`
 * extracted from a non-2xx body, an `ExceptionText`, a foreign `kenn` — safe to print in a
 * one-line error message on stderr:
 *
 * - Whole escape sequences (CSI, OSC and other control strings) are dropped first, then any
 *   remaining C0 and C1 controls and DEL. `JSON.parse` decodes an escaped ESC in an error body
 *   into a real ESC byte; printed raw, a hostile or MITM'd endpoint (the user chose the
 *   `--base-url`) could drive ANSI/OSC escape sequences into the terminal (display spoofing,
 *   title/clipboard writes on permissive terminals). The C1 range covers U+009B CSI.
 * - Unicode format characters (General Category Cf) are dropped: the bidi controls
 *   (`isBidiControl`), so server text cannot reorder the visible message, and the invisible
 *   ones — zero-width space/joiners, word joiner, soft hyphen, BOM.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one space and
 *   the ends are trimmed, so the text stays on one line and a server cannot forge an `Error:`
 *   line of its own.
 * - Only the first MAX_SERVER_TEXT (16 384) units are read, never half a surrogate pair, and
 *   every step is a linear regex replace: a hostile error body costs neither seconds nor the
 *   heap. A caller that scrubs credentials does so first, so a cut never splits one.
 *
 * The CLI's JSON output is escaped separately (`escapeControlChars` in cli/shared.ts), since
 * `JSON.stringify` alone leaves DEL, the C1 range and the bidi controls raw. Written with
 * escapes so no raw control byte appears in this source.
 */
export function sanitizeServerText(text: string): string {
  return cutText(text, MAX_SERVER_TEXT).replace(ESCAPE_SEQUENCE, "").replace(DROPPED_CHAR, "").replace(/\s+/g, " ").trim();
}

/** True for U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069: the bidi controls. */
export function isBidiControl(n: number): boolean {
  return n === 0x061c || n === 0x200e || n === 0x200f || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);
}

/**
 * Server text that one of the client's own messages quotes — the `kenn` of a feature
 * that answers a station query for another station — made safe and short
 * (`sanitizeServerText`: escape sequences, control and format characters, the bidi controls
 * among them, dropped; whitespace, line breaks and U+2028/U+2029 included, folded to one space,
 * so it stays on one line; trimmed), then cut at `max` characters (200), never inside a
 * surrogate pair (`cutText`), ending in "…" when cut.
 */
export function serverTextForMessage(text: string, max = 200): string {
  const clean = sanitizeServerText(text);
  return clean.length > max ? `${cutText(clean, max)}…` : clean;
}

/**
 * `form` and its spelling in a URL (`encodeURIComponent`): a server that quotes a URL with a
 * credential in it percent-encodes it. A form that has no such spelling (a lone surrogate) is
 * kept as it is.
 */
function urlSpellings(form: string): string[] {
  try {
    return [form, encodeURIComponent(form)];
  } catch {
    return [form];
  }
}

/** Longest error detail kept in a message; the full body stays on `StrahlApiError.body`. */
export const MAX_DETAIL_LENGTH = 500;

/**
 * Make server text fit for a one-line error message (`sanitizeServerText`: escape sequences,
 * control and format characters dropped, every run of whitespace, newlines included, so no
 * forged "Error:" line, turned into one space) and cut at MAX_DETAIL_LENGTH characters, never
 * inside a surrogate pair (`cutText`), so the message stays well-formed.
 */
function cleanDetail(text: string): string | undefined {
  const flat = sanitizeServerText(text);
  if (flat === "") return undefined;
  return flat.length > MAX_DETAIL_LENGTH ? `${cutText(flat, MAX_DETAIL_LENGTH)}…` : flat;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/**
 * `text` with every CDATA section (`<![CDATA[…]]>`) replaced by its content, as the regex
 * `/<!\[CDATA\[([\s\S]*?)\]\]>/g` would, in one pass: once a section has no `]]>` after
 * it, no later one has, so the scan stops there instead of rescanning to the end from
 * every unclosed section.
 */
function unwrapCdata(text: string): string {
  // The pieces are joined in batches (TextBuilder): one `+=` per section made a rope node each,
  // and an ExceptionText of 6 million sections exhausted a 160 MB heap.
  const out = new TextBuilder();
  let from = 0;
  for (;;) {
    const open = text.indexOf("<![CDATA[", from);
    if (open < 0) break;
    const close = text.indexOf("]]>", open + 9);
    if (close < 0) break;
    out.push(text.slice(from, open), text.slice(open + 9, close));
    from = close + 3;
  }
  if (from === 0) return text;
  out.push(text.slice(from));
  return out.toString();
}

/** Decode the five predefined XML entities, character references and CDATA sections. */
function decodeXmlText(text: string): string {
  return unwrapCdata(text)
    .replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(lt|gt|amp|quot|apos));/g, (whole, hex, dec, name) => {
      if (name !== undefined) return XML_ENTITIES[name as string] ?? whole;
      const code = Number.parseInt((hex ?? dec) as string, hex !== undefined ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
}

/**
 * The reason text of an OGC `ows:ExceptionReport` — the XML document GeoServer
 * answers a bad WFS request with (HTTP 400, and for some errors HTTP 200), e.g.
 * `Illegal property name: bogus_prop for feature type …`. Returns the
 * `ExceptionText` elements (any namespace prefix) joined with "; ", else the
 * `exceptionCode` attribute, cleaned for a one-line message; `undefined` when the
 * body is not an ExceptionReport. No XML dependency: the elements are found by
 * `exceptionTextElements`, in time linear in the body (a body of many unclosed tags once
 * cost quadratic time, 13.5 s for 1.2 MB, after it had arrived). `scrub` (default: none) is
 * applied to every decoded text before it is cleaned: the engine passes its credential scrub.
 */
export function owsExceptionText(body: string, scrub: (text: string) => string = (text) => text): string | undefined {
  if (!/<(?:[\w.-]+:)?ExceptionReport[\s>]/.test(body)) return undefined;
  // `scrub` runs on each text decoded, before it is cleaned and cut: an entity, a character
  // reference or a split CDATA section hides a secret from a scrub of the body as sent.
  const texts = exceptionTextElements(body)
    .map((content) => cleanDetail(scrub(decodeXmlText(content))))
    .filter((t): t is string => t !== undefined);
  if (texts.length > 0) return cleanDetail([...new Set(texts)].join("; "));
  const code = /\bexceptionCode\s*=\s*"([^"]*)"/.exec(body)?.[1];
  return code === undefined ? undefined : cleanDetail(scrub(decodeXmlText(code)));
}

/** True for a character of `[\w.-]`, the characters of an XML namespace prefix here. */
function isNameChar(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2e || c === 0x2d
  );
}

/** True for a character of `\w`: what `\b` after "ExceptionText" must not be followed by. */
function isWordChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}

const EXCEPTION_TEXT = "ExceptionText";

/** An element name found at a position: the name, and where it ends. */
interface TagName {
  name: string;
  end: number;
}

/**
 * The element names `(?:[\w.-]+:)?ExceptionText` can match at `at` (just after `<` or
 * `</`), in the order the regex tries them: with the prefix (the run of `[\w.-]` up to a
 * ":"; a shorter run can't be followed by one), then without. Usually one or none.
 */
function exceptionTextNames(body: string, at: number): TagName[] {
  const names: TagName[] = [];
  let i = at;
  while (i < body.length && isNameChar(body.charCodeAt(i))) i++;
  if (i > at && body.charCodeAt(i) === 0x3a && body.startsWith(EXCEPTION_TEXT, i + 1)) {
    const end = i + 1 + EXCEPTION_TEXT.length;
    names.push({ name: body.slice(at, end), end });
  }
  if (body.startsWith(EXCEPTION_TEXT, at)) names.push({ name: EXCEPTION_TEXT, end: at + EXCEPTION_TEXT.length });
  return names;
}

/**
 * The content of every `<[prefix:]ExceptionText …>…</[prefix:]ExceptionText>` element of
 * `body`, in order, exactly as the regex
 * `/<((?:[\w.-]+:)?ExceptionText)\b[^>]*>([\s\S]*?)<\/\1\s*>/g` finds them, but in time
 * linear in the body. The regex rescanned to the end from every opening tag that has no
 * closing one, and from every opening tag that never reaches a `>`. Here all closing tags
 * are found in one pass first, grouped by name; an opening tag then takes the first
 * closing tag of its name after its `>` (a pointer per name that only moves forward), and
 * that `>` comes from a position that only moves forward too.
 */
function exceptionTextElements(body: string): string[] {
  // Every closing tag `</name\s*>`, by name, in order of position. A closing tag has at
  // most one name followed by `\s*>`: the prefixed one ends where the unprefixed one
  // would need it to.
  const closes = new Map<string, { at: number; end: number }[]>();
  for (let lt = body.indexOf("</"); lt >= 0; lt = body.indexOf("</", lt + 2)) {
    for (const tag of exceptionTextNames(body, lt + 2)) {
      let i = tag.end;
      while (i < body.length && /\s/.test(body[i] as string)) i++;
      if (body.charCodeAt(i) !== 0x3e) continue;
      const list = closes.get(tag.name) ?? [];
      list.push({ at: lt, end: i + 1 });
      closes.set(tag.name, list);
    }
  }
  if (closes.size === 0) return [];
  const next = new Map<string, number>();
  const contents: string[] = [];
  let gt = -1;
  // `from` is where the regex goes on: after the last element found.
  let from = 0;
  for (let lt = body.indexOf("<"); lt >= 0; lt = body.indexOf("<", Math.max(lt + 1, from))) {
    if (lt < from) continue;
    for (const tag of exceptionTextNames(body, lt + 1)) {
      // `\b`: no word character right after the name.
      if (isWordChar(body.charCodeAt(tag.end))) continue;
      // `[^>]*>`: the first ">" from the end of the name on.
      if (gt < tag.end) gt = body.indexOf(">", tag.end);
      if (gt < 0) return contents; // no ">" from here on: no later opening tag completes
      const list = closes.get(tag.name);
      if (list === undefined) continue;
      let k = next.get(tag.name) ?? 0;
      while (k < list.length && (list[k] as { at: number }).at <= gt) k++;
      next.set(tag.name, k);
      const close = list[k];
      if (close === undefined) continue;
      contents.push(body.slice(gt + 1, close.at));
      from = close.end;
      break;
    }
  }
  return contents;
}

/**
 * Check a base URL against every base-URL rule (`baseUrlProblem`: no whitespace or
 * control characters, an absolute `http:`/`https:` URL, no query or fragment) and
 * return it without trailing slashes. The WFS path is appended to it as a string,
 * so a `?` or `#` would swallow the path (`http://h/#f` requests `/`). The default
 * transport also gates the scheme per hop, but the engine may be handed a custom
 * transport that does no such check. A bad value is a configuration error, so it
 * throws `StrahlValidationError` (`Invalid baseUrl: …`), never a network error.
 */
export function validateBaseUrl(baseUrl: string): string {
  return assertValid("baseUrl", baseUrl, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * A numeric engine option: `fallback` when it is `undefined`, else an integer from
 * 0 to `max`, or a `StrahlValidationError` (`Invalid maxRetries: Must be <= 10.`).
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  return value === undefined ? fallback : assertValid(name, value, intRangeProblem(0, max));
}

/**
 * Read a function-valued option (`transport`, `sleep`): `undefined` gives the default,
 * anything but a function throws a StrahlValidationError here rather than a raw TypeError
 * ("this.transport is not a function") at request time.
 */
function functionOption<F extends (...args: never[]) => unknown>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new StrahlValidationError(`Invalid ${name}: Expected a function, got ${value === null ? "null" : typeof value}.`);
  }
  return value;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws a StrahlValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new StrahlValidationError("Invalid bigIntegerKeys: Expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
}

/** True for a loopback host: `localhost`, 127.0.0.0/8 or `::1` (as URL#hostname spells it). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Whether requests to `baseUrl` would travel unencrypted, as one sentence for a
 * warning (the message of the CLI's WARN record), or `undefined` when they would not: for
 * `https:`, for a URL that does not parse, and for a loopback host (`localhost`,
 * 127.0.0.0/8, `::1`), where nothing leaves the machine.
 *
 * The sentence names the host (`url.host`: host and port, never the userinfo) and what
 * secret travels with the requests: the base URL's credentials when it carries
 * userinfo, and every phrase in `secrets` (noun phrases such as "the API key"; the BfS
 * WFS takes none, so the CLI passes none). It never contains a password. The CLI
 * logs it once per run as a WARN record of `strahlenschutz.http` on stderr.
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const userinfo = url.username !== "" || url.password !== "";
  const phrases = [...secrets, ...(userinfo ? ["the base URL's credentials"] : [])];
  if (phrases.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const verb = phrases.length === 1 && !userinfo ? "is" : "are";
  return `${phrases.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. Node's transport
 * lower-cases them; a custom one may not (`Retry-After`, `Location`, `Content-Type`), and
 * a fetch transport naturally returns its `Headers` object, which has no plain properties.
 * Such an object (anything with `get` and `forEach`: `Headers`, a `Map`) is copied.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  // Records built from an answer have no prototype: a header named `__proto__` is an own
  // entry like any other, never the record's prototype (whose entries would read as headers).
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record = Object.create(null) as Record<string, string>;
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = value;
    });
    return record;
  }
  const record = Object.create(null) as Record<string, string | string[] | undefined>;
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** The first value of a header (a repeated one arrives as an array). */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a StrahlNetworkError caused by a reset or aborted connection, which the engine
 * retries — whichever transport raised it (a Node error, fetch's TypeError with an undici
 * cause). A refused connection, a DNS failure or a timeout is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return err instanceof StrahlNetworkError && hasTransientCode(err.cause);
}

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages show request URLs through urlForMessage (redacted, cut).
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /**
   * The forms a server echoes that userinfo back in (the Basic value, the decoded
   * `user:password`, the password alone), longest first, so a password never leaves half
   * of the `user:password` around it.
   */
  readonly #echoed: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly onWarning: ((message: string) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined.
    options = options ?? {};
    // Check the raw value, before the trailing-slash strip: "https://h/ " must not
    // get past it, and new URL() would hide the whitespace from the scheme check.
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    // Each form also percent-encoded (`urlSpellings`), as a server quoting a URL writes it.
    this.#echoed = [...new Set(credentialsIn(this.#baseUrl).flatMap(echoedCredentialForms).flatMap(urlSpellings))].sort(
      (a, b) => b.length - a.length,
    );
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    // Only `undefined` selects the default. A blank value would go out as an empty
    // User-Agent, and a control or non-Latin-1 character would reach a custom
    // transport raw (header injection) or make Node throw at request time.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("userAgent", options.userAgent, headerValueProblem);
    // Numeric limits are range-checked: a negative, fractional, NaN or infinite
    // value would otherwise silently disable the timeout or the size cap, or retry
    // without bound. `undefined` keeps the default; 0 keeps its documented meaning.
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, 5, MAX_REDIRECTS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = functionOption("sleep", options.sleep, realSleep);
    this.onRetry =
      options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
    this.onWarning =
      options.onWarning === undefined ? undefined : functionOption("onWarning", options.onWarning, () => {});
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /** Tell `onWarning` about an answer delivered changed. A throwing callback never breaks the request. */
  private warn(message: string): void {
    try {
      this.onWarning?.(message);
    } catch {
      // a logging hook is no reason to fail the request
    }
  }

  /**
   * Tell `onRetry` about a retry (`shown`: the URL as messages name it, userinfo redacted and,
   * after a redirect, the credentials echoed in it scrubbed), then wait. A throwing callback
   * never breaks the request.
   */
  private async backOff(attempt: number, delayMs: number, shown: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: shown,
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL, the Authorization header or the decoded `user:password`) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactSecrets(redactCredentials(text, this.#credentials), this.#echoed);
  }

  /**
   * A value from a 2xx answer that one of the client's own messages quotes (the `kenn` of a
   * feature for another station), as `"<text>"`: the base URL's credentials scrubbed, then made
   * safe and short (`serverTextForMessage`: cleaned to one line, cut at `max` characters), and
   * scrubbed again in between, so neither a cut nor a control character dropped from inside an
   * echo leaves any part of a credential. `serverTextForMessage` alone cuts first: a password
   * echoed there kept its first `max` characters.
   */
  quoteServerValue(value: string, max = 200): string {
    const clean = this.scrub(sanitizeServerText(this.scrub(value)));
    return `"${clean.length > max ? `${cutText(clean, max)}…` : clean}"`;
  }

  /**
   * An error body, already scrubbed as sent, as `StrahlApiError.body` keeps it: when it is JSON
   * with an escape in it, or XML with an entity, a character reference or a CDATA section, it is
   * checked decoded too. An escape (`\u0026`, `&amp;`, `<![CDATA[`) hides an echoed credential from
   * the scrub of the text as sent, while a caller who decodes the body sees it. Such a JSON body
   * is kept as the decoded JSON written again (`JSON.stringify`, one spelling per character) with
   * the credential scrubbed in that spelling; such an XML body is left out (`""`), since it cannot
   * be written again soundly (the detail still says what the server reported). A body that is
   * neither is text nobody decodes, and stays as sent; JSON too deeply nested to write again is
   * left out.
   */
  private scrubBody(scrubbed: string): string {
    const jsonEscape = scrubbed.includes("\\");
    if (this.#echoed.length === 0 || (!jsonEscape && !/&|<!\[CDATA\[/.test(scrubbed))) return scrubbed;
    let decoded: unknown;
    try {
      decoded = JSON.parse(scrubbed);
    } catch {
      const text = decodeXmlText(scrubbed);
      return this.scrub(text) === text ? scrubbed : "";
    }
    if (!jsonEscape) return scrubbed;
    let rewritten: string;
    try {
      rewritten = JSON.stringify(decoded);
    } catch {
      return "";
    }
    const spelled = this.#echoed.map((form) => JSON.stringify(form).slice(1, -1));
    return spelled.some((form) => rewritten.includes(form)) ? redactSecrets(rewritten, spelled) : scrubbed;
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && this.scrub(cause.stack ?? "") === (cause.stack ?? "")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters. It keeps any
   * userinfo of the base URL (`http://user:pw@mirror/…`); request() leaves it out and
   * sends it as an Authorization header instead (see basicAuthorization).
   */
  buildUrl(path: string, query?: QueryParams): string {
    return this.composeUrl(this.#baseUrl, path, query);
  }

  /**
   * The request URL as an error about the answer shows it: absolute (so a message names the
   * host that gave a bad answer, which matters with a custom base URL), without the base URL's
   * userinfo (as the network errors show it), cut at MAX_QUOTED_URL_LENGTH characters
   * (`urlForMessage`). It never throws: describing a URL for a message does not validate it.
   */
  describeUrl(path: string, query?: QueryParams): string {
    return urlForMessage(this.composeUrl(withoutUserinfo(this.#baseUrl), path, query));
  }

  /** `base` + path + query string. */
  private composeUrl(base: string, path: string, query: QueryParams | undefined): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${base}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new StrahlNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, Math.min(this.timeoutMs, MAX_TIMEOUT_MS));
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams | undefined; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    // The transport never sees the base URL's userinfo: the engine sends it as an
    // Authorization header, per hop, so a redirect to the same origin (relative or
    // absolute) keeps it and one to another origin or scheme drops it. A transport such
    // as fetch also refuses a URL with credentials outright.
    let url = this.composeUrl(withoutUserinfo(this.#baseUrl), path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };
    const authorization = basicAuthorization(this.#baseUrl);
    if (authorization !== undefined) headers["Authorization"] = authorization;
    /** Why a redirect dropped the base URL's credentials, for a 401/403 message. */
    let dropped: string | undefined;
    // The URL as messages name it: after a redirect, the Location as the server sent it with the
    // credentials scrubbed, then resolved (`redirectTarget`). Resolving first would percent-encode
    // an echoed password in a new spelling (`'` as `%27` in a query) no scrub matches. The
    // request itself goes to the Location as sent.
    let shown = redactUrl(url);

    // Only an idempotent request is sent again: request() is public, and a POST re-sent
    // after a reset may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          redirect: "manual",
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a proxy) reset is the network-level twin of a 503:
        // retry an idempotent request, whichever transport reported it. Timeouts are not
        // retried — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.backOff(attempt, this.retryDelayMs * attempt, shown);
          continue;
        }
        // The default transport rejects with StrahlNetworkError only; an injected one may
        // throw anything, and its text may carry the request URL with the base URL's
        // password (fetch refuses a URL with credentials and quotes it). Keep the
        // library's error contract — every failure is a StrahlError — and scrub that text.
        if (cause instanceof StrahlError && !(cause instanceof StrahlNetworkError)) throw cause;
        // A transport's text names the URL it was given; the message names the one shown.
        const reason = (cause instanceof Error ? cause.message : String(cause)).split(url).join(shown);
        throw new StrahlNetworkError(
          `${method} ${urlForMessage(shown)} failed: ${cleanDetail(this.scrub(reason)) ?? "unknown error"}`,
          { cause: this.scrubCause(cause) },
        );
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the StrahlError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new StrahlNetworkError(
          `${method} ${urlForMessage(shown)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }

      // A transport must not follow redirects itself (`redirect: "manual"`): one that did
      // (fetch's default) may have carried the Authorization header to another host, and
      // the answer is not the one asked for. Reject it when it says so (`url`).
      const finalUrl = (response as { url?: unknown }).url;
      if (typeof finalUrl === "string" && finalUrl !== "" && originOf(finalUrl) !== originOf(url)) {
        throw new StrahlNetworkError(
          `${method} ${urlForMessage(shown)} failed: the transport followed a redirect to another origin ` +
            `(${cleanDetail(redactUrl(this.scrub(finalUrl))) ?? ""}); a transport must not follow redirects ` +
            `(HttpRequest.redirect is "manual").`,
        );
      }

      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new StrahlNetworkError(`${method} ${urlForMessage(shown)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }
      const retryable = status === 429 || status === 503;
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      if (retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs * attempt). A Retry-After can ask for longer, never
        // for less: `Retry-After: 0` or a date in the past made a zero-delay burst against a
        // server that had just asked for less load. A Retry-After beyond MAX_RETRY_AFTER_MS
        // is not retried: the error below surfaces at once and names the requested wait.
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.backOff(attempt, retryAfter === undefined ? backoff : Math.max(retryAfter, backoff), shown, status);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL.
      if (status >= 300 && status < 400) {
        if (redirects >= this.maxRedirects) {
          throw new StrahlNetworkError(
            `Too many redirects (>${this.maxRedirects}) for ${method} ${urlForMessage(shown)}`,
          );
        }
        const location = headerValue(responseHeaders["location"]);
        if (typeof location !== "string" || location.length === 0) {
          throw new StrahlNetworkError(
            `Redirect status ${status} for ${method} ${urlForMessage(shown)} without a Location header`,
          );
        }

        const from = new URL(url);
        // A malformed Location would make `new URL` throw a raw TypeError (whose `base`
        // property is the request URL, credentials included): report it as a typed error.
        let to: URL;
        try {
          to = new URL(location, url);
        } catch {
          throw new StrahlNetworkError(
            `Redirect status ${status} for ${method} ${urlForMessage(shown)} with an invalid Location header ` +
              `"${cleanDetail(this.scrub(location)) ?? ""}"`,
          );
        }

        // Enforce the http(s) scheme allowlist on the redirect target here in the
        // engine, before the transport is called. The default transport also rejects
        // non-http(s), but Transport is an injectable library seam: a consumer's custom
        // transport must not be steered to file:/data:/other schemes by a hostile redirect.
        if (to.protocol !== "http:" && to.protocol !== "https:") {
          throw new StrahlNetworkError(
            `Refusing to follow redirect to unsupported protocol "${cleanDetail(this.scrub(to.protocol)) ?? ""}" for ${method} ${urlForMessage(shown)}`,
          );
        }

        const target = redirectTarget(shown, location, (text) => this.scrub(text));
        // Refuse to downgrade https -> http on redirect (defends against a
        // redirect that strips transport security).
        if (from.protocol === "https:" && to.protocol === "http:") {
          throw new StrahlNetworkError(
            `Refusing to follow https->http downgrade redirect from ${urlForMessage(shown)} to ${urlForMessage(target)}`,
          );
        }

        // Userinfo in a Location is not used: credentials come from the base URL only,
        // as the Authorization header, never from a server.
        to.username = "";
        to.password = "";

        // Cross-origin redirect: drop credential-bearing headers so they are never
        // re-sent to a different origin (matches fetch/browser behaviour). Compare by
        // origin (scheme + host + port); the same origin keeps them, whether the
        // Location is relative or absolute.
        if (to.origin !== from.origin) {
          for (const name of Object.keys(headers)) {
            const lower = name.toLowerCase();
            if (lower === "authorization" || lower === "x-api-key" || lower === "cookie") {
              delete headers[name];
              if (name === "Authorization" && authorization !== undefined && dropped === undefined) {
                dropped =
                  from.protocol === "http:" && to.protocol === "https:" && from.hostname === to.hostname
                    ? "the server redirected http→https, which dropped the base URL's credentials; use an https base URL"
                    : `the redirect to ${cleanDetail(this.scrub(to.origin)) ?? ""} dropped the base URL's credentials (they are sent to their own origin only)`;
              }
            }
          }
        }

        url = to.toString();
        shown = target;
        redirects += 1;
        continue;
      }

      const contentType = String(headerValue(responseHeaders["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(
          method,
          shown,
          status,
          body,
          contentType,
          status === 401 || status === 403
            ? dropped
            : retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS
              ? `the server asked to wait ${Math.ceil(retryAfter / 1000)} s (Retry-After), longer than the ` +
                `${MAX_RETRY_AFTER_MS / 1000} s the client waits; retrying sooner won't help`
              : undefined,
        );
      }

      return { data: body, contentType, status, url, shownUrl: shown };
    }
  }

  /**
   * Perform a GET expecting JSON and parse it into `T`. An empty (or whitespace-only) body is a
   * StrahlParseError: the WFS always answers with a document. Every error about the answer names
   * the request (`GET <url>: …`, without the userinfo, as the network errors show it).
   *
   * The text is never changed silently: bytes that are not valid in the charset, and lone
   * surrogates written as JSON escapes (`\ud800`), are replaced with U+FFFD, so the result is
   * well-formed text (`jq` rejects a lone surrogate, and with it the whole output), and
   * `onWarning` is told how many. One bad character never sinks a whole answer.
   */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const request = `GET ${this.describeUrl(path, query)}`;
    const decoded = decodeBody(res.data, res.contentType, request, (t) => this.scrub(t));
    const text = decoded.text;
    if (text.trim() === "") {
      // A broken answer, not "no results": printed as nothing with exit 0, it would let a
      // script carry on as if the WFS had found nothing.
      throw new StrahlParseError(`${request}: empty response body.`);
    }
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const repaired = wellFormedEscapes(text);
    const { json, inexact } = scanNumbers(repaired.json, this.bigIntegerKeys);
    let parsed: T;
    try {
      parsed = JSON.parse(json) as T;
    } catch (cause) {
      // GeoServer answers some bad requests with HTTP 200 and an OGC
      // ExceptionReport (XML) instead of GeoJSON: report its reason, not a parse error.
      const exception = owsExceptionText(text, (t) => this.scrub(t));
      if (exception !== undefined) {
        const body = this.scrubBody(this.scrub(text));
        throw new StrahlApiError({ status: res.status, url: res.shownUrl, method: "GET", body, detail: this.scrub(exception) });
      }
      // A maintenance or proxy page answered with 200: say what it was.
      const type = res.contentType.split(";")[0]?.trim() ?? "";
      // Header text, as a server or a custom transport sent it, and JSON.parse's message, which
      // quotes the start of the body: scrubbed of the base URL's credentials, like an error detail.
      const hint = type !== "" && !/json/i.test(type) ? ` (expected JSON, got Content-Type "${cleanDetail(this.scrub(type)) ?? ""}")` : "";
      throw new StrahlParseError(`${request}: the answer is not valid JSON${hint}.`, { cause: this.scrubCause(cause) });
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than print a
    // changed value. The BfS sends dose rates and coordinates as decimals, which pass.
    if (inexact !== undefined) {
      throw new StrahlParseError(`${request}: the number ${cutForMessage(inexact)} cannot be represented exactly.`);
    }
    const replaced = decoded.replaced + repaired.replaced;
    if (replaced > 0) {
      this.warn(
        `${request}: ${replaced} ${replaced === 1 ? "character" : "characters"} of the answer ${replaced === 1 ? "was" : "were"} ` +
          "not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
      );
    }
    return parsed;
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    contentType: string,
    hint?: string,
  ): StrahlApiError {
    const raw = decodeErrorBody(body, contentType);
    // The body is kept on the error and may echo the credentials: scrubbed as sent, and checked
    // decoded (scrubBody).
    const text = this.scrubBody(this.scrub(raw));
    // The detail is read from the body as sent and scrubbed once decoded: an escape (a JSON
    // `\u0073`, an XML `&amp;`, a split CDATA section) hid a credential from a scrub of the raw
    // text, and decoding then turned it into the plain password.
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Not JSON: GeoServer's errors are an OGC ExceptionReport (XML).
      detail = owsExceptionText(raw, (t) => this.scrub(t));
    }
    // `detail` came from the response body: scrubbed, then stripped of control characters so a
    // hostile endpoint cannot inject terminal escape sequences via the stderr error message, kept
    // to one bounded line, and scrubbed again (a dropped control character inside an echo no
    // longer hides it).
    if (detail !== undefined) detail = cleanDetail(this.scrub(detail));
    if (detail !== undefined) detail = this.scrub(detail);
    if (hint !== undefined) detail = detail === undefined ? hint : `${detail}; ${hint}`;
    return new StrahlApiError({ status, url, method, body: text, detail });
  }
}

/**
 * A redirect's `Location` as messages show the request after it: the base URL's credentials
 * scrubbed (`scrub`) as sent, before resolving percent-encodes what is left of them in a new
 * spelling (`'` as `%27` in a query); resolved against the URL shown so far, userinfo redacted.
 * The engine follows the Location as sent; this is only its name in messages.
 */
function redirectTarget(shownUrl: string, location: string, scrub: (text: string) => string): string {
  const sent = scrub(location);
  try {
    return redactUrl(new URL(sent, shownUrl).href);
  } catch {
    return redactUrl(scrub(new URL(location, shownUrl).href));
  }
}

/** `url` without its userinfo, otherwise exactly as written. */
function withoutUserinfo(url: string): string {
  const [userinfo] = credentialsIn(url);
  return userinfo === undefined ? url : url.replace(`://${userinfo}@`, "://");
}

/**
 * The `Authorization` header for a URL's userinfo (`Basic base64(user:password)`, both
 * percent-decoded, as Node's own http client builds it), or undefined without userinfo.
 */
function basicAuthorization(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.username === "" && parsed.password === "") return undefined;
  const pair = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

/** The origin (scheme, host, port) of a URL, or the value itself if it doesn't parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The charset label of a Content-Type (`application/json; charset=iso-8859-1`), or undefined. */
function charsetOf(contentType: string): string | undefined {
  return /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1];
}

/**
 * Decode a response body by the charset of its Content-Type (UTF-8 when none is
 * given, as JSON requires). A leading byte-order mark is dropped: TextDecoder does
 * that by default, where Buffer#toString kept it and JSON.parse then failed. An
 * unknown charset label is a StrahlParseError naming it. The BfS server sends UTF-8;
 * this matters for proxies and mirrors that re-encode (`µSv/h` and the umlauts of
 * station names would otherwise turn into U+FFFD). `request` (`GET <url>`) starts the
 * message of the error, which quotes the label scrubbed of the base URL's credentials (`scrub`). Bytes that are not valid in the charset become U+FFFD, and
 * `replaced` counts them: exactly for UTF-8 and the single-byte charsets; for UTF-16 a
 * U+FFFD the server sent counts too.
 */
function decodeBody(
  body: Buffer,
  contentType: string,
  request: string,
  scrub: (text: string) => string,
): { text: string; replaced: number } {
  const charset = charsetOf(contentType) ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: true });
  } catch {
    throw new StrahlParseError(`${request}: unsupported response charset "${cleanDetail(scrub(charset)) ?? ""}".`);
  }
  try {
    return { text: decoder.decode(body), replaced: 0 };
  } catch (err) {
    if (isStringTooLong(err)) throw tooLargeForText(request, body);
    // Not valid in the charset: decode with replacement, and count what was replaced.
    let text: string;
    try {
      text = new TextDecoder(decoder.encoding).decode(body);
    } catch (again) {
      if (isStringTooLong(again)) throw tooLargeForText(request, body);
      throw again;
    }
    const sent = decoder.encoding === "utf-8" ? countBytes(body, REPLACEMENT_UTF8) : 0;
    return { text, replaced: countChar(text, 0xfffd) - sent };
  }
}

/** V8's longest string (2^29 − 24 characters on 64-bit). */
const MAX_STRING_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * True for V8's error for a string past its longest one (2^29 − 24 characters on 64-bit): a body
 * of 512 MB and more, possible once `maxResponseBytes` is lifted, can't be decoded into one.
 */
function isStringTooLong(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ERR_STRING_TOO_LONG";
}

/** The parse error for a body too large to decode: it used to escape as a plain Error ("Unexpected error"). */
function tooLargeForText(request: string, body: Buffer): StrahlParseError {
  return new StrahlParseError(
    `${request}: the answer is too large to read as text (${body.byteLength} bytes; the longest string is ${MAX_STRING_LENGTH} characters).`,
  );
}

/** U+FFFD in UTF-8. */
const REPLACEMENT_UTF8 = Buffer.from([0xef, 0xbf, 0xbd]);

/** How often `needle` occurs in `body`. */
function countBytes(body: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** How often the UTF-16 unit `code` occurs in `text`. */
function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

/** A JSON escape of a surrogate, `\uD800`–`\uDFFF`, anywhere in a text (a cheap pre-check). */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** The value of the four hex digits of a `\uXXXX` escape whose `u` is at `at`, or -1. */
function escapeAt(json: string, at: number): number {
  if (json.charCodeAt(at) !== 0x75) return -1;
  const hex = json.slice(at + 1, at + 5);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * `json` (decoded answer text) with every lone surrogate written as a JSON escape (`\ud800` not
 * followed by a low-surrogate escape, or a `\udc00` not preceded by a high one) rewritten as
 * `\ufffd`, and how many. JSON.parse would make such an escape half a character, which a JSON
 * printer writes back as `\ud800` and `jq` refuses (the whole output with it). A raw lone
 * surrogate cannot occur: TextDecoder never makes one. One linear pass, and only when the text
 * holds a surrogate escape at all; the text is copied only when one is lone.
 */
function wellFormedEscapes(json: string): { json: string; replaced: number } {
  if (!SURROGATE_ESCAPE.test(json)) return { json, replaced: 0 };
  // The pieces are joined in batches (TextBuilder): one `+=` per repair made a rope node each,
  // and 6 million repairs exhausted a 128 MB heap.
  const out = new TextBuilder();
  let copied = 0;
  let replaced = 0;
  for (let i = 0; i < json.length; i++) {
    if (json.charCodeAt(i) !== 0x5c) continue;
    const code = escapeAt(json, i + 1);
    if (code < 0xd800 || code > 0xdfff) {
      i++; // an escape of another kind (\", \\, \n, \u0041): skip its second character
      continue;
    }
    const pairedLow = code <= 0xdbff && json.charCodeAt(i + 6) === 0x5c && isLowSurrogate(escapeAt(json, i + 7));
    if (pairedLow) {
      i += 11;
      continue;
    }
    out.push(json.slice(copied, i), "\\ufffd");
    copied = i + 6;
    replaced++;
    i += 5;
  }
  if (replaced === 0) return { json, replaced };
  out.push(json.slice(copied));
  return { json: out.toString(), replaced };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * An error body as text: by its declared charset when Node knows it, else UTF-8. One too large to
 * be a string (maxResponseBytes lifted) is left out (""): the status is the error.
 */
function decodeErrorBody(body: Buffer, contentType: string): string {
  try {
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charsetOf(contentType) ?? "utf-8");
    } catch {
      decoder = new TextDecoder("utf-8");
    }
    return decoder.decode(body);
  } catch (err) {
    if (isStringTooLong(err)) return "";
    throw err;
  }
}

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  // The zeros are counted with index loops: `/0+$/` tried a match at every zero of a run that
  // doesn't end the text, quadratic in the run, and one `1.<64 000 zeros>1e300` in an answer held
  // the CLI for seconds, past --timeout (the scan runs once the answer is in).
  const all = whole + fraction;
  let start = 0;
  while (start < all.length && all.charCodeAt(start) === 0x30) start++;
  let end = all.length;
  while (end > start && all.charCodeAt(end - 1) === 0x30) end--;
  return { negative: sign === "-", digits: all.slice(start, end), exponent: Number(exp) - fraction.length + (all.length - end) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings and looks at every
 * number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"_version_":
 *   1858054135406919680` becomes `"_version_":"1858054135406919680"`), so JSON.parse delivers
 *   it exactly as a string, whatever its size. Only a literal the JSON grammar allows is quoted,
 *   so a malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  // Joined in batches (TextBuilder): one `+=` per quoted member made a rope node each, and
  // 3 million declared members exhausted a 128 MB heap.
  let out: TextBuilder | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out ??= new TextBuilder();
      out.push(json.slice(copied, at), '"', literal, '"');
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  if (out === undefined) return { json, inexact };
  out.push(json.slice(copied));
  return { json: out.toString(), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it. {@link scanNumbers} without declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}
