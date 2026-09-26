import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_AFTER_MS, RequestEngine, owsExceptionText, parseRetryAfter } from "../src/client/engine.js";
import { StrahlApiError, StrahlNetworkError, StrahlParseError } from "../src/client/errors.js";
import type { HttpResponse } from "../src/client/http.js";
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
      (err) => err instanceof StrahlNetworkError && /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("an unparseable base URL is rejected at construction", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  assert.throws(
    () => new RequestEngine({ baseUrl: "not a url", transport: mt.transport }),
    (err) => err instanceof StrahlNetworkError && /Invalid base URL/.test(err.message),
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
    (err: unknown) => err instanceof StrahlNetworkError && /https:\/\/\*\*\*@a\.example\/x/.test(err.message) && !err.message.includes("s3cretpw"),
  );
  const downgrade = makeMockTransport(() => ({ status: 302, headers: { location: "http://v:pw2@b.example/y" }, body: Buffer.alloc(0) }));
  const d = new RequestEngine({ baseUrl: "https://u:s3cretpw@a.example", transport: downgrade.transport });
  await assert.rejects(
    () => d.getJson("/x"),
    (err: unknown) => err instanceof StrahlNetworkError && !err.message.includes("s3cretpw") && !err.message.includes("pw2"),
  );
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://u:s3cretpw@a.example" }),
    (err: unknown) => err instanceof StrahlNetworkError && !err.message.includes("s3cretpw"),
  );
});
