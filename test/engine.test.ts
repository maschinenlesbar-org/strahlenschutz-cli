import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { StrahlApiError, StrahlNetworkError, StrahlParseError } from "../src/client/errors.js";
import type { HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

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
