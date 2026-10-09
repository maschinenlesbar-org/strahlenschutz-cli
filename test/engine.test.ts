import { test } from "node:test";
import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
import {
  MAX_REDIRECTS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  owsExceptionText,
  parseRetryAfter,
  type EngineOptions,
} from "../src/client/engine.js";
import { StrahlApiError, StrahlNetworkError, StrahlParseError, StrahlValidationError, cutText, toWellFormed } from "../src/client/errors.js";
import { MAX_TIMEOUT_MS, type HttpRequest, type HttpResponse } from "../src/client/http.js";
import { LIVE_EXCEPTION_REPORT, makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

/** A 30x redirect response pointing at `location`. */
function redirectResponse(location: string, status = 302): HttpResponse {
  return { status, headers: { location }, body: Buffer.alloc(0) };
}

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("ogc/"), "https://example.test/ogc/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws StrahlParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), StrahlParseError);
});

test("a 503 is retried up to maxRetries then surfaces as StrahlApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof StrahlApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("a same-origin redirect is followed and the request succeeds", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(req.url, "https://example.test/a");
      return redirectResponse("/b");
    }
    assert.equal(req.url, "https://example.test/b");
    return jsonResponse({ ok: true });
  });
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  assert.deepEqual(await e.getJson("/a"), { ok: true });
  assert.equal(calls, 2);
});

test("a same-origin redirect preserves request headers", async () => {
  let secondHeaders: Record<string, string> | undefined;
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) return redirectResponse("/b");
    secondHeaders = req.headers;
    return jsonResponse({ ok: true });
  });
  // On a same-origin redirect all headers are reused on the next hop.
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    userAgent: "ua/1",
  });
  await e.getJson("/a");
  assert.equal(secondHeaders?.["User-Agent"], "ua/1");
});

test("a cross-origin redirect drops credential-bearing headers", async () => {
  let firstHeaders: Record<string, string> | undefined;
  let secondHeaders: Record<string, string> | undefined;
  let calls = 0;
  // The engine builds and reuses a single headers object across redirect hops.
  // We capture it on the first hop, inject credential headers into that live
  // object, return a cross-origin redirect, then assert they are stripped before
  // the second hop is issued to the different origin.
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      firstHeaders = req.headers;
      if (req.headers) {
        req.headers["Authorization"] = "Bearer secret";
        req.headers["X-API-Key"] = "key";
        req.headers["Cookie"] = "session=1";
      }
      return redirectResponse("https://evil.test/steal");
    }
    secondHeaders = req.headers;
    return jsonResponse({ ok: true });
  });
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await e.getJson("/a");
  assert.ok(firstHeaders);
  assert.equal(calls, 2);
  // Credential headers must not be re-sent to the different origin.
  assert.equal(secondHeaders?.["Authorization"], undefined);
  assert.equal(secondHeaders?.["X-API-Key"], undefined);
  assert.equal(secondHeaders?.["Cookie"], undefined);
  // Non-credential headers still travel.
  assert.equal(secondHeaders?.["Accept"], "application/json");
});

test("an https->http downgrade redirect is refused", async () => {
  const mt = makeMockTransport(() => redirectResponse("http://example.test/b"));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(() => e.getJson("/a"), StrahlNetworkError);
});

test("a redirect without a Location header throws a clear error", async () => {
  const mt = makeMockTransport(() => ({ status: 302, headers: {}, body: Buffer.alloc(0) }));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/a"),
    (err) => err instanceof StrahlNetworkError && /without a Location/.test(err.message),
  );
});

test("exceeding maxRedirects throws a too-many-redirects error", async () => {
  const mt = makeMockTransport(() => redirectResponse("/loop"));
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    maxRedirects: 2,
  });
  await assert.rejects(
    () => e.getJson("/a"),
    (err) => err instanceof StrahlNetworkError && /Too many redirects/.test(err.message),
  );
});

// Control chars are built via char codes so no raw control byte ever appears in
// this source file (an editor would turn a literal escape into a raw byte).
const ESC = String.fromCharCode(0x1b); // C0 ESC — introduces ANSI/OSC sequences
const BEL = String.fromCharCode(0x07); // C0 BEL
const CSI = String.fromCharCode(0x9b); // C1 CSI — a single-byte escape introducer

/** True if the string contains any C0/C1 control char (tab/newline excepted). */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("error detail is stripped of C0 and C1 terminal control characters", async () => {
  // A hostile/MITM'd endpoint plants ESC/CSI/BEL sequences in the error body;
  // JSON.parse decodes the escapes into real control bytes. The engine must
  // strip them before they reach the StrahlApiError message printed to stderr.
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  const mt = makeMockTransport(() => jsonResponse({ detail: evil }, 500));
  const e = new RequestEngine({
    baseUrl: "https://a.example",
    transport: mt.transport,
    maxRetries: 0,
  });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof StrahlApiError);
      // Both the structured detail and the human-readable message that run.ts
      // prints to stderr are free of control bytes...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable text survives (only the control bytes were removed).
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("a non-http(s) base URL is rejected at construction, before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) =>
        err instanceof StrahlValidationError &&
        !(err instanceof StrahlNetworkError) &&
        err.message === 'Invalid baseUrl: Only "http:" and "https:" base URLs are supported.',
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("an unparseable base URL is rejected at construction", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  assert.throws(
    () => new RequestEngine({ baseUrl: "not-a-url", transport: mt.transport }),
    (err) =>
      err instanceof StrahlValidationError &&
      err.message === "Invalid baseUrl: Expected a valid absolute URL (e.g. https://host).",
  );
  assert.equal(mt.calls.length, 0);
});

// ---- Retry-After ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from(JSON.stringify({ detail: "slow down" })),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("3");
  await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof StrahlApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [3000, 3000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof StrahlApiError && e.status === 429);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("Retry-After 0 or a past date waits the linear backoff, never less (P6)", async () => {
  for (const header of ["0", "Sat, 26 Sep 2015 09:00:00 GMT"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"));
    assert.deepEqual(delays, [200, 400], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:04 GMT", now), 4000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

// ---- OGC ExceptionReport ----

test("a 400 ExceptionReport puts its ExceptionText into the error detail", async () => {
  const mt = makeMockTransport(() => rawResponse(LIVE_EXCEPTION_REPORT, "application/xml", 400));
  const e = new RequestEngine({ baseUrl: "https://a.example", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/ows", { sortBy: "bogus_prop" }),
    (err: unknown) =>
      err instanceof StrahlApiError &&
      err.status === 400 &&
      err.detail === "Illegal property name: bogus_prop for feature type opendata:odlinfo_odl_1h_latest" &&
      err.message ===
        "HTTP 400 for GET https://a.example/ows?sortBy=bogus_prop: " +
          "Illegal property name: bogus_prop for feature type opendata:odlinfo_odl_1h_latest",
  );
});

test("a 200 ExceptionReport is a StrahlApiError with its reason, not a JSON parse error", async () => {
  const mt = makeMockTransport(() => rawResponse(LIVE_EXCEPTION_REPORT, "application/xml", 200));
  const e = new RequestEngine({ baseUrl: "https://a.example", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/ows"),
    (err: unknown) =>
      err instanceof StrahlApiError &&
      err.status === 200 &&
      !err.isRetryable &&
      err.message ===
        "WFS exception (HTTP 200) for GET https://a.example/ows: " +
          "Illegal property name: bogus_prop for feature type opendata:odlinfo_odl_1h_latest",
  );
});

test("owsExceptionText decodes entities, joins texts, flattens lines and strips controls", () => {
  const esc = String.fromCharCode(0x1b);
  const report = (inner: string) => `<ExceptionReport><Exception exceptionCode="NoApplicableCode">${inner}</Exception></ExceptionReport>`;
  assert.equal(
    owsExceptionText(report("<ExceptionText>a &lt;b&gt; &amp; &#x41;&#66;\nError: forged</ExceptionText><ExceptionText>two</ExceptionText>")),
    "a <b> & AB Error: forged; two",
  );
  assert.equal(owsExceptionText(report(`<ows:ExceptionText><![CDATA[x ${esc}[31my]]></ows:ExceptionText>`)), "x [31my");
  assert.equal(owsExceptionText(report("")), "NoApplicableCode");
  const long = owsExceptionText(report(`<ExceptionText>${"x".repeat(5000)}</ExceptionText>`)) ?? "";
  assert.equal(long.length, 501);
  assert.ok(long.endsWith("…"));
  for (const notAReport of ["<html><body>Bad Request</body></html>", "", "{}"]) {
    assert.equal(owsExceptionText(notAReport), undefined, notAReport);
  }
});

test("a non-JSON, non-ExceptionReport 200 body stays a StrahlParseError", async () => {
  const mt = makeMockTransport(() => rawResponse("<html>oops</html>", "text/html"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/ows"), StrahlParseError);
});

test("redirect and base-URL errors redact userinfo", async () => {
  const noLocation = makeMockTransport(() => ({ status: 302, headers: {}, body: Buffer.alloc(0) }));
  const e = new RequestEngine({ baseUrl: "https://u:s3cretpw@a.example", transport: noLocation.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    // The userinfo travels as the Authorization header, never in a request URL (P3).
    (err: unknown) => err instanceof StrahlNetworkError && /https:\/\/a\.example\/x/.test(err.message) && !err.message.includes("s3cretpw"),
  );
  const downgrade = makeMockTransport(() => ({ status: 302, headers: { location: "http://v:pw2@b.example/y" }, body: Buffer.alloc(0) }));
  const d = new RequestEngine({ baseUrl: "https://u:s3cretpw@a.example", transport: downgrade.transport });
  await assert.rejects(
    () => d.getJson("/x"),
    (err: unknown) => err instanceof StrahlNetworkError && !err.message.includes("s3cretpw") && !err.message.includes("pw2"),
  );
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://u:s3cretpw@a.example" }),
    (err: unknown) => err instanceof StrahlValidationError && !err.message.includes("s3cretpw"),
  );
});

test("an unparseable redirect Location is a StrahlNetworkError without the password (02#3)", async () => {
  const mt = makeMockTransport(() => redirectResponse("http://[::1"));
  const e = new RequestEngine({ baseUrl: "http://alice:S3CRETpw@127.0.0.1:20641/rbadloc", transport: mt.transport });
  const err = await e.getJson("/ogc/opendata/ows").then(
    () => assert.fail("resolved"),
    (x: unknown) => x,
  );
  assert.ok(err instanceof StrahlNetworkError, String(err));
  assert.match(err.message, /invalid Location/);
  assert.ok(!JSON.stringify(err).includes("S3CRETpw") && !err.message.includes("S3CRETpw"), err.message);
});

test("the engine rejects out-of-range numeric options at construction", () => {
  const bad: Array<[keyof EngineOptions, number]> = [];
  for (const v of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const name of ["timeoutMs", "maxRetries", "maxRedirects", "maxResponseBytes", "retryDelayMs"] as const) {
      bad.push([name, v]);
    }
  }
  bad.push(["timeoutMs", MAX_TIMEOUT_MS + 1], ["maxRetries", MAX_RETRIES + 1], ["maxRedirects", MAX_REDIRECTS + 1]);
  for (const [name, value] of bad) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, [name]: value }),
      (err: unknown) => err instanceof StrahlValidationError && (err as Error).message.startsWith(`Invalid ${name}: `),
      `${name}=${value}`,
    );
  }
  for (const options of [
    { timeoutMs: 0, maxRetries: 0, maxRedirects: 0, maxResponseBytes: 0, retryDelayMs: 0 },
    { timeoutMs: MAX_TIMEOUT_MS, maxRetries: MAX_RETRIES, maxRedirects: MAX_REDIRECTS, maxResponseBytes: Number.MAX_SAFE_INTEGER },
  ]) {
    new RequestEngine(options);
  }
  assert.equal(MAX_RETRIES, 10);
  assert.equal(MAX_REDIRECTS, 10);
});

test("custom transports: header names in any case and a Headers object are read (04#3)", async () => {
  for (const headers of [{ Location: "/moved" }, new Headers({ Location: "/moved" })]) {
    let n = 0;
    const mt = makeMockTransport(() =>
      n++ === 0
        ? { status: 302, headers: headers as unknown as HttpResponse["headers"], body: Buffer.alloc(0) }
        : jsonResponse({ ok: true }),
    );
    const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
    assert.deepEqual(await e.getJson("/x"), { ok: true });
    assert.equal(new URL(mt.last().url).pathname, "/moved");
  }
});

test("custom transports: a Uint8Array error body keeps its detail and text (04#4)", async () => {
  const body = new Uint8Array(Buffer.from('{"detail":"no such layer"}'));
  const mt = makeMockTransport(() => ({ status: 404, headers: { "content-type": "application/json" }, body: body as Buffer }));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof StrahlApiError && err.detail === "no such layer" && err.body === '{"detail":"no such layer"}',
  );
});

test("custom transports: no status, a string status, missing headers or a string body is a StrahlNetworkError (04#4)", async () => {
  for (const response of [
    { headers: {}, body: Buffer.from("{}") },
    { status: "200", headers: {}, body: Buffer.from("{}") },
    { status: 503, body: Buffer.from("{}") },
    { status: 200, headers: {}, body: "{}" },
  ]) {
    const e = new RequestEngine({ transport: async () => response as unknown as HttpResponse, maxRetries: 0 });
    await assert.rejects(() => e.getJson("/x"), StrahlNetworkError, JSON.stringify(response));
  }
});

test("a redirect to a non-http(s) scheme is refused before the transport is called", async () => {
  for (const location of ["file:///etc/passwd", "data:text/plain,hi", "javascript:alert(1)", "ftp://h/x"]) {
    const mt = makeMockTransport(() => redirectResponse(location));
    const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
    await assert.rejects(
      () => e.getJson("/x"),
      (err) => err instanceof StrahlNetworkError && /unsupported protocol/.test(err.message),
      location,
    );
    assert.equal(mt.calls.length, 1, location);
  }
});

test("the size-cap error names the CLI flag too (03#4)", async () => {
  const mt = makeMockTransport(() => jsonResponse({ big: "x".repeat(2000) }));
  const e = new RequestEngine({ transport: mt.transport, maxResponseBytes: 1238 });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof StrahlNetworkError && /--max-response-bytes/.test(err.message) && /1238/.test(err.message),
  );
});

test("a body is decoded by its declared charset; an unknown one is a StrahlParseError (03#3)", async () => {
  const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: { unit: "µSv/h", name: "Müllheim" } }] };
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const mt = makeMockTransport(() => rawResponse(Buffer.from(JSON.stringify(fc), encoding), `application/json; charset=${charset}`));
    const e = new RequestEngine({ transport: mt.transport });
    assert.deepEqual(await e.getJson("/ows"), fc, charset);
  }
  const bom = makeMockTransport(() => rawResponse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(fc))]), "application/json"));
  assert.deepEqual(await new RequestEngine({ transport: bom.transport }).getJson("/ows"), fc);
  const unknown = makeMockTransport(() => rawResponse(JSON.stringify(fc), "application/json; charset=x-bogus"));
  await assert.rejects(
    () => new RequestEngine({ transport: unknown.transport }).getJson("/ows"),
    (err) => err instanceof StrahlParseError && /charset "x-bogus"/.test(err.message),
  );
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail, an ExceptionText and a charset label cut to their limits keep the message well-formed", async () => {
  for (const text of ["\u{1f600}".repeat(400), "a" + "\u{1f600}".repeat(400)]) {
    const report = `<ows:ExceptionReport><ows:Exception><ows:ExceptionText>${text}</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`;
    for (const answer of [jsonResponse({ detail: text }, 500), rawResponse(report, "application/xml", 400), rawResponse(report, "application/xml", 200)]) {
      const engine = new RequestEngine({ transport: async () => answer });
      await assert.rejects(engine.getJson("/x"), (err: Error) => {
        assert.ok(err instanceof StrahlApiError, err.message);
        assert.equal(toWellFormed(err.message), err.message);
        assert.match(err.message, /…/);
        return true;
      });
    }
  }
  // A custom transport can hand over any header text: a label of 499 units and an emoji.
  const label = "a".repeat(499) + "\u{1f600}";
  const engine = new RequestEngine({ transport: async () => rawResponse("{}", `application/json; charset=${label}`) });
  await assert.rejects(engine.getJson("/x"), (err: Error) => {
    assert.ok(err instanceof StrahlParseError);
    assert.equal(toWellFormed(err.message), err.message);
    return true;
  });
});

test("a URL a redirect chose is quoted at most 500 characters long in every message (01-1)", async () => {
  const long = `/ogc/opendata/ows?pad=${"A".repeat(15_000)}`;
  const report = "<ows:ExceptionReport><ows:Exception><ows:ExceptionText>bad</ows:ExceptionText></ows:Exception></ows:ExceptionReport>";
  const cases: Array<[string, (req: HttpRequest) => HttpResponse, EngineOptions]> = [
    // A same-origin redirect to a long URL, then an error status.
    ["status", (req) => (req.url.includes("pad=") ? rawResponse(report, "application/xml", 400) : redirectResponse(long)), {}],
    // A redirect to itself until the limit: "Too many redirects … for GET <url>".
    ["redirects", () => redirectResponse(long), { maxRedirects: 2 }],
    // The followed URL in a network failure.
    ["network", (req) => { if (req.url.includes("pad=")) throw new Error("socket hang up"); return redirectResponse(long); }, {}],
    // A redirect with no Location after the long one.
    ["no location", (req) => (req.url.includes("pad=") ? { status: 302, headers: {}, body: Buffer.alloc(0) } : redirectResponse(long)), {}],
  ];
  for (const [label, respond, options] of cases) {
    const e = new RequestEngine({ baseUrl: "https://u:pw@example.test", transport: async (req) => respond(req), ...options });
    await assert.rejects(e.getJson("/ogc/opendata/ows"), (err: Error) => {
      assert.ok(err.message.length < 700, `${label}: ${err.message.length} characters`);
      assert.match(err.message, /pad=A+…/, label);
      assert.doesNotMatch(err.message, /pw/, label);
      return true;
    }, label);
  }
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // Node sends the pair UTF-8 encoded, so that is the form a server echoes.
  const basic = Buffer.from("alice:p\u00e4 ss-pw", "utf8").toString("base64");
  const body = JSON.stringify({ message: `no: Basic ${basic} / alice:p\u00e4 ss-pw / p\u00e4 ss-pw` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:p%C3%A4%20ss-pw@127.0.0.1",
    maxRetries: 0,
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof StrahlApiError);
    for (const form of [basic, "alice:p\u00e4 ss-pw", "p\u00e4 ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
  // The same in a 200 ExceptionReport, the WFS's own error form.
  const report = `<ows:ExceptionReport><ows:Exception><ows:ExceptionText>no: Basic ${basic} / alice:p\u00e4 ss-pw</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`;
  const wfs = new RequestEngine({ baseUrl: "https://alice:p%C3%A4%20ss-pw@127.0.0.1", transport: async () => rawResponse(report, "application/xml") });
  await assert.rejects(wfs.getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof StrahlApiError);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\*$/);
    return true;
  });
});

// ---- owsExceptionText in linear time (01-2) ------------------------------------------
// The regex it used, /<((?:[\w.-]+:)?ExceptionText)\b[^>]*>([\s\S]*?)<\/\1\s*>/g, rescanned to the
// end of the body from every opening tag that has no closing one: 64 000 unclosed tags
// (1.2 MB) took 13.5 s, after the body had arrived, so --timeout did not bound it. The
// bodies below are as large or larger (0.9-3.3 MB): a quadratic scan runs for minutes, a linear
// one for milliseconds. The test reads no clock: the scan runs in a worker thread, so
// the test runner's own per-test timeout (5 s) ends a test whose scan does not come
// back, which it can't while a synchronous scan blocks its own thread. The timeout aborts
// the test's signal, which terminates the worker: an unref'd worker still stuck in a scan
// would hold the process at exit for minutes.

/** The hostile bodies, built inside the worker, and what owsExceptionText gave for each. */
const HOSTILE_REPORTS_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.engine).then(({ owsExceptionText }) => {
  const n = 100000;
  const bodies = {
    // Opening tags with no closing one (the report's case).
    unclosed: "<ows:ExceptionReport>" + "<ows:ExceptionText>".repeat(n),
    // The same with one closing tag at the very end: the first opening tag's text runs to it.
    closedAtEnd: "<ows:ExceptionReport>" + "<ows:ExceptionText>".repeat(n) + "last</ows:ExceptionText>",
    // Opening tags that never reach a ">".
    noGt: "<ExceptionReport>" + "<ExceptionText ".repeat(n),
    // A different namespace prefix on every tag, none closed.
    prefixes: "<ExceptionReport>" + Array.from({ length: n }, (_, i) => "<p" + i + ":ExceptionText>").join(""),
    // CDATA sections that are never closed, inside one text.
    cdata: "<ExceptionReport><ExceptionText>" + "<![CDATA[".repeat(2 * n) + "</ExceptionText>",
    // Many complete texts: deduplicated and joined, as before.
    many: "<ExceptionReport>" + "<ExceptionText>t</ExceptionText>".repeat(n),
  };
  const results = {};
  for (const [name, body] of Object.entries(bodies)) results[name] = { size: body.length, text: owsExceptionText(body) ?? null };
  parentPort.postMessage(results);
});
`;

test("owsExceptionText reads a hostile ExceptionReport of megabytes in linear time (01-2)", async (t) => {
  const worker = new Worker(HOSTILE_REPORTS_WORKER, {
    eval: true,
    workerData: { engine: new URL("../src/client/engine.js", import.meta.url).href },
  });
  worker.unref();
  t.signal.addEventListener("abort", () => void worker.terminate(), { once: true });
  const results = await new Promise<Record<string, { size: number; text: string | null }>>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  await worker.terminate();
  for (const { size } of Object.values(results)) assert.ok(size > 800_000, `${size} characters`);
  assert.equal(results["unclosed"]?.text, null);
  assert.equal(results["noGt"]?.text, null);
  assert.equal(results["prefixes"]?.text, null);
  const tail = results["closedAtEnd"]?.text ?? "";
  assert.ok(tail.startsWith("<ows:ExceptionText><ows:ExceptionText>") && tail.endsWith("…"), tail.slice(0, 80));
  const cdata = results["cdata"]?.text ?? "";
  assert.ok(cdata.startsWith("<![CDATA[<![CDATA[") && cdata.endsWith("…"), cdata.slice(0, 80));
  assert.equal(results["many"]?.text, "t");
});

/** owsExceptionText as it was, regex for regex: the reference for the rewrite (small inputs only). */
function regexOwsExceptionText(body: string): string | undefined {
  const clean = (text: string): string | undefined => {
    let out = "";
    for (const ch of text) {
      const c = ch.codePointAt(0) ?? 0;
      if (c <= 8 || (c >= 0x0b && c <= 0x1f) || (c >= 0x7f && c <= 0x9f)) continue;
      out += ch;
    }
    const flat = out.replace(/\s+/g, " ").trim();
    if (flat === "") return undefined;
    return flat.length > 500 ? `${cutText(flat, 500)}…` : flat;
  };
  const entities: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  const decode = (text: string): string =>
    text
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(lt|gt|amp|quot|apos));/g, (whole, hex, dec, name) => {
        if (name !== undefined) return entities[name as string] ?? whole;
        const code = Number.parseInt((hex ?? dec) as string, hex !== undefined ? 16 : 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      });
  if (!/<(?:[\w.-]+:)?ExceptionReport[\s>]/.test(body)) return undefined;
  const texts = [...body.matchAll(/<((?:[\w.-]+:)?ExceptionText)\b[^>]*>([\s\S]*?)<\/\1\s*>/g)]
    .map((m) => clean(decode(m[2] ?? "")))
    .filter((t): t is string => t !== undefined);
  if (texts.length > 0) return clean([...new Set(texts)].join("; "));
  const code = /\bexceptionCode\s*=\s*"([^"]*)"/.exec(body)?.[1];
  return code === undefined ? undefined : clean(decode(code));
}

test("owsExceptionText gives what the regex gave, on 5 000 random reports (01-2)", () => {
  const tokens = [
    "<ExceptionReport>", "<ows:ExceptionReport ", "<ows:ExceptionText>", "</ows:ExceptionText>", "<ExceptionText>",
    '<ExceptionText lang="en">', "</ExceptionText >", "</ExceptionText\n>", "<ExceptionText", "</ExceptionText", ">", "<", "</",
    "<p:ExceptionText>", "</p:ExceptionText>", "<p.q-r:ExceptionText>", "</p.q-r:ExceptionText>", "<ExceptionTextX>",
    "<ExceptionText.x>", "</ExceptionTextX>", "<ows:ows:ExceptionText>", "<![CDATA[", "]]>", "&lt;", "&#x41;", "&#66;",
    "&amp;", "&bogus;", 'exceptionCode="C1"', "exceptionCode = 'x'", '"', "x", "y z", " ", "\n", "\t", "\u0085", "\u{1f600}", ":",
  ];
  let seed = 20261009;
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let i = 0; i < 5000; i++) {
    const parts = ["<ExceptionReport>"];
    const length = 1 + random(25);
    for (let j = 0; j < length; j++) parts.push(tokens[random(tokens.length)] as string);
    const body = random(10) === 0 ? parts.slice(1).join("") : parts.join("");
    assert.equal(owsExceptionText(body), regexOwsExceptionText(body), JSON.stringify(body));
  }
});
