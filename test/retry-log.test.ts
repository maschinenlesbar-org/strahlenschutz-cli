// Each retry is announced to `onRetry`; the CLI logs it as one WARN record of `strahlenschutz.http`,
// and stdout is the same as without the retry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { StrahlApiError, StrahlValidationError } from "../src/client/errors.js";
import { run } from "../src/cli/run.js";
import { StrahlenschutzClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://example.test/x" },
    { retry: 2, maxRetries: 3, delayMs: 400, status: 503, url: "https://example.test/x" },
  ]);
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.getJson("/x");
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
});

test("a throw in onRetry is swallowed", async () => {
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
});

test("onRetry is never called without a retry", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({})).transport, sleep: async () => {}, onRetry });
  await ok.getJson("/x");
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => jsonResponse({ detail: "no" }, 404)).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.getJson("/x"), StrahlApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.getJson("/x"), StrahlApiError);
  assert.equal(events.length, 1);
  // a Retry-After over the cap is not retried
  const long = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: { "retry-after": "999999" }, body: Buffer.from("{}") })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(long.getJson("/x"), StrahlApiError);
  assert.equal(events.length, 1);
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), StrahlValidationError);
});

const okBody = { type: "FeatureCollection", features: [] };

async function exercise(extra: string[], failures: number, retryAfter?: string) {
  const out: string[] = [];
  const err: string[] = [];
  let n = 0;
  const transport = async (): Promise<HttpResponse> =>
    n++ < failures
      ? { status: 503, headers: retryAfter ? { "retry-after": retryAfter } : {}, body: Buffer.from("{}") }
      : { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(okBody)) };
  const deps = {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    now: () => new Date("2026-01-02T03:04:05.678Z"),
    createClient: (opts) => new StrahlenschutzClient({ ...opts, transport, sleep: async () => {} }),
  } as CliDeps;
  const code = await run([...extra, ...["latest"]], deps);
  return { code, out: out.join("\n"), err };
}

test("a 503 then 200 exits 0, same stdout, and logs one WARN of strahlenschutz.http", async () => {
  const plain = await exercise([], 0);
  const retried = await exercise(["--base-url", "https://mirror.test"], 1, "2");
  assert.equal(retried.code, 0);
  assert.equal(retried.out, plain.out);
  assert.equal(plain.err.length, 0);
  assert.deepEqual(untimed(retried.err.join("\n")).split("\n"), [
    "WARN  [strahlenschutz.http] HTTP 503 from mirror.test: retry 1 of 2 in 2 s",
  ]);
});

test("the same record in jsonl, with the delay in ms under one second", async () => {
  const r = await exercise(["--log-format", "jsonl"], 1);
  assert.equal(r.code, 0);
  assert.equal(r.err.length, 1);
  const rec = JSON.parse(r.err[0] as string) as Record<string, unknown>;
  assert.equal(rec["level"], "WARN");
  assert.equal(rec["topic"], "strahlenschutz.http");
  assert.equal(rec["msg"], "HTTP 503 from www.imis.bfs.de: retry 1 of 2 in 200 ms");
});
