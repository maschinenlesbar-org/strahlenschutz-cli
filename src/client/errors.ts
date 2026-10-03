// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A URL without userinfo, or one that does not parse, is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/** Base class for every error originating from this client. */
export class StrahlError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API reported an error: a non-2xx status code, or (with a 2xx `status`) an
 * OGC ExceptionReport where GeoJSON was expected. `detail` holds a human-readable
 * message extracted from the response body when one is present (a JSON
 * `detail`/`message`, or the ExceptionReport's `ExceptionText`).
 */
export class StrahlApiError extends StrahlError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const detailPart = args.detail ? `: ${args.detail}` : "";
    const head =
      args.status >= 200 && args.status < 300 ? `WFS exception (HTTP ${args.status})` : `HTTP ${args.status}`;
    super(`${head} for ${args.method} ${url}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/**
 * An input the library rejects before sending any request: a client option or a
 * method argument that breaks one of the rules in `validate.ts`. The message reads
 * `Invalid <name>: <reason>`. The CLI reports it as a usage error (exit 1).
 */
export class StrahlValidationError extends StrahlError {}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class StrahlNetworkError extends StrahlError {}

/**
 * A requested resource does not exist. Raised by the client's `station()` when the
 * lookup for one specific station by its `kenn` comes back empty.
 * The WFS never answers 404 for an unknown id — it returns an empty
 * FeatureCollection with status 200 — so we synthesise this so an unknown id is
 * distinguishable from a request error and maps to the documented exit code 4.
 */
export class StrahlNotFoundError extends StrahlError {}

/** The response body could not be parsed as the expected JSON shape. */
export class StrahlParseError extends StrahlError {}
