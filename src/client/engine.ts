// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { StrahlApiError, StrahlNetworkError, StrahlParseError, redactUrl } from "./errors.js";
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
}

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://www.imis.bfs.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header: non-blank, no control characters (tab
   * allowed), nothing above U+00FF. Defaults to `strahlenschutz-cli`.
   */
  userAgent?: string;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: an integer from 0 (disables) to MAX_TIMEOUT_MS (2^31 - 1 ms).
   * Defaults to 30 s.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, an integer from
   * 0 to MAX_RETRIES (10); defaults to 2. Each waits the response's `Retry-After`
   * (up to `MAX_RETRY_AFTER_MS`; a longer one is not retried), or else
   * `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly), a non-negative
   * integer; used without a Retry-After. Defaults to 200.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, an integer from 0 to
   * MAX_REDIRECTS (10). Defaults to 5.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative safe integer. Defaults to
   * 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
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
 * Strip control characters out of a string that originates in an
 * attacker-controlled response — the error `detail` extracted from a non-2xx
 * body. `JSON.parse` decodes an escaped ESC in an error body into a real ESC
 * byte, so without this a hostile or MITM'd endpoint (the user chose the
 * `--base-url`) could drive ANSI/OSC escape sequences into the terminal when the
 * message is printed raw to stderr (display spoofing, title/clipboard writes on
 * permissive terminals). This only covers text that flows into an error message;
 * the CLI's JSON output is escaped separately (escapeControlChars in
 * cli/shared.ts), since `JSON.stringify` alone leaves DEL and the C1 range raw.
 *
 * The filter removes C0 controls except tab/newline, DEL, and all C1 controls
 * (0x7f-0x9f — this range covers U+009B CSI, which some terminals treat as an
 * escape-sequence introducer). Built with `codePointAt` so no raw control byte
 * ever appears in this source.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/** Longest error detail kept in a message; the full body stays on `StrahlApiError.body`. */
export const MAX_DETAIL_LENGTH = 500;

/**
 * Make server text fit for a one-line error message: control characters stripped,
 * every run of whitespace (newlines included, so no forged "Error:" line) turned
 * into one space, and cut at MAX_DETAIL_LENGTH characters.
 */
function cleanDetail(text: string): string | undefined {
  const flat = sanitizeServerText(text).replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length > MAX_DETAIL_LENGTH ? `${flat.slice(0, MAX_DETAIL_LENGTH)}…` : flat;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decode the five predefined XML entities, character references and CDATA sections. */
function decodeXmlText(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
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
 * body is not an ExceptionReport. A regex is enough here: no XML dependency.
 */
export function owsExceptionText(body: string): string | undefined {
  if (!/<(?:[\w.-]+:)?ExceptionReport[\s>]/.test(body)) return undefined;
  const texts = [...body.matchAll(/<((?:[\w.-]+:)?ExceptionText)\b[^>]*>([\s\S]*?)<\/\1\s*>/g)]
    .map((m) => cleanDetail(decodeXmlText(m[2] ?? "")))
    .filter((t): t is string => t !== undefined);
  if (texts.length > 0) return cleanDetail([...new Set(texts)].join("; "));
  const code = /\bexceptionCode\s*=\s*"([^"]*)"/.exec(body)?.[1];
  return code === undefined ? undefined : cleanDetail(decodeXmlText(code));
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

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // Check the raw value, before the trailing-slash strip: "https://h/ " must not
    // get past it, and new URL() would hide the whitespace from the scheme check.
    this.baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.transport = options.transport ?? nodeHttpTransport;
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
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, Number.MAX_SAFE_INTEGER);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, 5, MAX_REDIRECTS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    let url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL.
      if (status >= 300 && status < 400) {
        if (redirects >= this.maxRedirects) {
          throw new StrahlNetworkError(
            `Too many redirects (>${this.maxRedirects}) for ${method} ${redactUrl(url)}`,
          );
        }
        const location = response.headers["location"];
        if (typeof location !== "string" || location.length === 0) {
          throw new StrahlNetworkError(
            `Redirect status ${status} for ${method} ${redactUrl(url)} without a Location header`,
          );
        }

        const from = new URL(url);
        const to = new URL(location, url);

        // Refuse to downgrade https -> http on redirect (defends against a
        // redirect that strips transport security).
        if (from.protocol === "https:" && to.protocol === "http:") {
          throw new StrahlNetworkError(
            `Refusing to follow https->http downgrade redirect from ${redactUrl(url)} to ${redactUrl(to.toString())}`,
          );
        }

        // Cross-origin redirect: drop credential-bearing headers so they are
        // never re-sent to a different origin (matches fetch/browser behaviour).
        // Compare by origin (scheme + host + port).
        if (to.origin !== from.origin) {
          for (const name of Object.keys(headers)) {
            const lower = name.toLowerCase();
            if (lower === "authorization" || lower === "x-api-key" || lower === "cookie") {
              delete headers[name];
            }
          }
        }

        url = to.toString();
        redirects += 1;
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status, url };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      // GeoServer answers some bad requests with HTTP 200 and an OGC
      // ExceptionReport (XML) instead of GeoJSON: report its reason, not a parse error.
      const exception = owsExceptionText(text);
      if (exception !== undefined) {
        throw new StrahlApiError({ status: res.status, url: res.url, method: "GET", body: text, detail: exception });
      }
      throw new StrahlParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): StrahlApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Not JSON: GeoServer's errors are an OGC ExceptionReport (XML).
      detail = owsExceptionText(text);
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message,
    // and keep it to one bounded line.
    if (detail !== undefined) detail = cleanDetail(detail);
    return new StrahlApiError({ status, url, method, body: text, detail });
  }
}
