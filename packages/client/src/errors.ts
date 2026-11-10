// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A value that does not parse as a URL (a port typo, an unencoded `#` in the
 * password) has its userinfo cut out by text ({@link credentialsIn}); a value
 * without userinfo is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A value that doesn't parse can still carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // A URL without userinfo, or `user:pw@host` without a scheme (it parses as a URL with
  // the scheme "user:"), which is no URL with credentials at all.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * A scheme WHATWG parses as special (`ftp`, `file`, `http(s)`, `ws(s)`) at the start of a value,
 * with the slashes and backslashes it skips after it (`http:`, `http:///`, `https:\\` all start
 * the authority): a special scheme's authority starts after them, and also ends at a backslash.
 */
const SPECIAL_SCHEME = /^(?:ftp|file|https?|wss?):[/\\]*/i;

/**
 * The userinfo a URL carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. Only a value that starts
 * with a scheme counts (`^[A-Za-z][A-Za-z0-9+.-]*://`, or a special one such as `http:` with
 * any slashes or backslashes after it, as WHATWG reads `http:///alice:pw@host` and
 * `http:alice:pw@host`): a bare `a:b@c` is a station id, a User-Agent or a sort key as often
 * as a credential, and the base URL always has a scheme. It works on URLs that don't parse
 * too: the userinfo is everything between the scheme's slashes and the last `@` before the
 * host. Used to redact those exact strings from text that echoes the value (usage errors,
 * help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  // WHATWG skips any number of "/" and "\" after a special scheme, so its userinfo starts after them.
  const special = SPECIAL_SCHEME.exec(value);
  const scheme = special ?? /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (scheme === null) return [];
  const rest = value.slice(scheme[0].length);
  let parses = false;
  try {
    new URL(value);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#", and for a special scheme such as http(s) a "\", where WHATWG ends
  // it too: `https://u:pw@a.example\@b.example` sends `u:pw` to a.example); in one that doesn't,
  // at the last "@" of the value.
  const stop = special !== null ? /[/?#\\]|$/ : /[/?#]|$/;
  const authority = parses ? rest.slice(0, rest.search(stop)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/** How many pieces a TextBuilder joins at a time. */
const BUILDER_BATCH = 16_384;

/**
 * A text put together from many pieces (slices of a server answer and their replacements),
 * joined in batches of BUILDER_BATCH into flat strings, so memory stays proportional to the text,
 * not to the number of pieces. One `+=` per piece made a rope node each, and one array of every
 * piece a slot each: millions of lone-surrogate repairs in a large answer exhausted a small heap
 * either way.
 */
export class TextBuilder {
  readonly #done: string[] = [];
  #batch: string[] = [];

  push(...pieces: string[]): void {
    for (const piece of pieces) this.#batch.push(piece);
    if (this.#batch.length >= BUILDER_BATCH) {
      this.#done.push(this.#batch.join(""));
      this.#batch = [];
    }
  }

  toString(): string {
    this.#done.push(this.#batch.join(""));
    this.#batch = [];
    return this.#done.join("");
  }
}

/** A scheme character (RFC 3986: letters, digits, `+`, `.`, `-`). */
function isSchemeChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2e || code === 0x2d;
}

/** An ASCII letter, with which a scheme starts. */
function isLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/**
 * Where the scheme of the `://` at `at` starts: the first letter of the run of scheme characters
 * before it, looking back no further than `from`; -1 when there is none (`1://`, ` ://`). A run
 * led by other scheme characters (`-https://`) starts at its first letter.
 */
function schemeStart(text: string, at: number, from: number): number {
  let start = at;
  while (start > from && isSchemeChar(text.charCodeAt(start - 1))) start--;
  while (start < at && !isLetter(text.charCodeAt(start))) start++;
  return start < at ? start : -1;
}

/**
 * `text` with the userinfo of every URL in it replaced by `***` (`https://user:secret@host`
 * becomes `https://***@host`): the pattern backstop for text no exact secret matches. Text-based,
 * so it also covers a URL that does not parse; the userinfo ends at the last `@` before the first
 * whitespace, `/`, `?`, `#` or `'` after `://`. Linear in `text`, however many URLs it holds: each
 * `://` is found with `indexOf`, its scheme by walking back no further than the previous `://`,
 * and the search goes on right after each `://`, not after the authority it read: a URL glued
 * onto the one before it (`https://host://u:p@h`, `https://u:p@x://v:q@w`) starts inside that
 * authority, which ends at its `/`. An authority holds no `/`, so no `://` lies wholly inside
 * one, and every character is read a bounded number of times: by the authority loop and
 * `indexOf` forwards, by `schemeStart` backwards. The regex it replaces (a scheme tried at every
 * word start) was quadratic: 200 000 characters of `a.a.…` on stdout took 38 s.
 */
export function redactUrlUserinfo(text: string): string {
  const parts = new TextBuilder();
  let copied = 0;
  let from = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", from)) {
    const begin = at + 3;
    let end = begin;
    let lastAt = -1;
    for (; end < text.length; end++) {
      const c = text.charCodeAt(end);
      if (c === 0x2f || c === 0x3f || c === 0x23 || c === 0x27 || /\s/.test(text[end] as string)) break;
      if (c === 0x40) lastAt = end;
    }
    if (lastAt !== -1 && schemeStart(text, at, from) !== -1) {
      parts.push(text.slice(copied, begin), "***");
      copied = lastAt;
    }
    from = begin;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.toString();
}

/**
 * The forms in which a server may echo the credentials of a userinfo (`user:password`,
 * as {@link credentialsIn} returns it) back in an error body, in this order: the
 * `Authorization: Basic` value (base64 of the decoded `user:password`, UTF-8 as the engine
 * sends it), the decoded `user:password` itself, and the secret alone when it is at least 4
 * characters long. The secret is the password; in a userinfo without one (`TOKEN@host`,
 * `TOKEN:@host`) it is the user name, a token, which the engine sends as Basic `TOKEN:`. `[]`
 * for an empty userinfo. None of them has an `@` to anchor on, so they are replaced as exact
 * strings ({@link redactSecrets}).
 */
export function echoedCredentialForms(userinfo: string): string[] {
  const colon = userinfo.indexOf(":");
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const user = decode(colon < 0 ? userinfo : userinfo.slice(0, colon));
  const password = colon < 0 ? "" : decode(userinfo.slice(colon + 1));
  const secret = password === "" ? user : password;
  if (secret === "") return [];
  const pair = `${user}:${password}`;
  const forms = [Buffer.from(pair, "utf8").toString("base64"), pair];
  if (secret.length >= 4) forms.push(secret);
  return forms;
}

/**
 * `text` with every occurrence of each secret (a form a server echoes a credential in,
 * which has no `@` to anchor on) replaced by `***`. Secrets shorter than 4 characters are
 * skipped: they are not credentials, and replacing them would garble the rest of the text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * `text` with every occurrence of each credential (as {@link credentialsIn} returns them)
 * that is followed by `@` replaced by `***`. Matching the exact strings, not a pattern,
 * covers passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * The longest value (in characters) an own message quotes from a server answer or from
 * the user's input: a redirect target, a rejected option value. A longer one is cut
 * (`cutText`) and ends in "…", so a library caller's `err.message` stays bounded too.
 */
export const MAX_QUOTED_LENGTH = 200;

/** `text` cut to `max` characters (default `MAX_QUOTED_LENGTH`), a cut marked with "…". */
export function cutForMessage(text: string, max = MAX_QUOTED_LENGTH): string {
  const cut = cutText(text, max);
  return cut.length < text.length ? `${cut}…` : text;
}

/** Unicode General Category Cf (format): bidi controls, zero-width characters, U+00AD, U+FEFF, … */
const FORMAT_CHAR = /\p{Cf}/u;

/**
 * Quote a value for an error message, as `JSON.stringify` does, and also escape what it
 * leaves raw although a terminal acts on it: DEL, the C1 controls, every Unicode
 * format character (bidi overrides, zero-width characters, a soft hyphen) and the line and
 * paragraph separators U+2028/U+2029, which a viewer may break the line at. A refused value
 * is echoed in messages, and an invisible character in it must be seen (`"a\u200bb"`), never
 * hidden; an override would reorder the rest of the line ("Trojan Source"). A lone surrogate
 * is escaped by `JSON.stringify` itself. A value longer than `max` characters (default
 * `MAX_QUOTED_LENGTH`) is cut, never inside a surrogate pair, and the "…" goes after the
 * closing quote (`"AAAA"…`), so it does not read as part of the value. The quoted part stays a
 * valid JSON string.
 */
export function quoteValue(value: string, max = MAX_QUOTED_LENGTH): string {
  const cut = value.length > max;
  let out = "";
  for (const ch of JSON.stringify(cut ? cutText(value, max) : value)) {
    const n = ch.codePointAt(0) ?? 0;
    if ((n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || FORMAT_CHAR.test(ch)) {
      // One escape per UTF-16 unit, so a character above U+FFFF stays valid JSON.
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return cut ? `${out}…` : out;
}

/**
 * The longest URL (in characters) a message quotes. A request URL is the caller's base
 * URL and query, but after a redirect it is the server's choice, up to Node's 16 KiB
 * header limit; a longer one is cut and ends in "…".
 */
export const MAX_QUOTED_URL_LENGTH = 500;

/**
 * `url` as a message shows it: userinfo redacted (`redactUrl`, before the cut, so no
 * part of a password survives a cut), then cut at `MAX_QUOTED_URL_LENGTH`.
 */
export function urlForMessage(url: string): string {
  return cutForMessage(redactUrl(url), MAX_QUOTED_URL_LENGTH);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
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
  /**
   * The response body as text, with the base URL's credentials scrubbed. It keeps its spelling,
   * unless a credential hides behind an escape in it: then a JSON body is the decoded JSON
   * written again (other escapes, no insignificant whitespace) with the credential scrubbed, and
   * an XML body (an entity, a character reference or a CDATA section) is `""`. `""` too for a
   * body too large to read as a string, or JSON too deeply nested to write again.
   */
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
    super(`${head} for ${args.method} ${urlForMessage(url)}${detailPart}`);
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
