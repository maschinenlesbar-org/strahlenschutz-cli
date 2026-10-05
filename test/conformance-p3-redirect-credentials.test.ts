// Conformance test P3 (fix plan 2026-10-06): base-URL credentials follow a redirect only to
// their own origin. A redirect to another origin (port, host or scheme) reaches the target
// without them; a same-origin redirect keeps them, relative or absolute; a transport that
// followed a redirect itself is caught; an http→https drop is named when the target then
// answers 401. Written first in dwd-cli; shared across the redirect-following and keyed
// *-cli repos, only the adapter block differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { StrahlenschutzClient as Client } from "../src/client/client.js";
import { StrahlApiError as ApiError, StrahlNetworkError as NetworkError } from "../src/client/errors.js";
/** The client option that holds the base URL the call below uses. */
const BASE_OPTION = "baseUrl";
/** One call that makes a single GET and needs no arguments. */
const call = (client: Client): Promise<unknown> => client.latest();
/** A 2xx body the call accepts. */
const okBody = { type: "FeatureCollection", features: [] };
// --------------------------------------------------------------------------------------

const USER = "alice";
const PW = "s3cret-Pw";
const BASIC = `Basic ${Buffer.from(`${USER}:${PW}`).toString("base64")}`;

interface Seen { url: string; authorization: string | undefined }

/** A local server that records each request and answers with `respond`. */
async function server(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
    respond(req, res);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { origin, seen, close: () => new Promise<void>((r) => s.close(() => r())) };
}

const ok = (res: http.ServerResponse): void => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(okBody));
};

const withCredentials = (origin: string): string => origin.replace("http://", `http://${USER}:${PW}@`);

test("P3: a redirect to another origin (port) reaches it without the credentials", async () => {
  const b = await server((_req, res) => ok(res));
  const a = await server((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", `${b.origin}/moved`);
    res.end();
  });
  try {
    await call(new Client({ [BASE_OPTION]: withCredentials(a.origin), maxRetries: 0 }));
    assert.equal(a.seen[0]?.authorization, BASIC, "the base URL's own origin gets them");
    assert.equal(b.seen.length, 1);
    assert.equal(b.seen[0]?.authorization, undefined, "the other origin must not");
    assert.ok(!b.seen[0]?.url.includes(PW));
  } finally {
    await a.close();
    await b.close();
  }
});

test("P3: a same-origin redirect keeps the credentials, relative or absolute", async () => {
  for (const absolute of [false, true]) {
    let origin = "";
    const a = await server((req, res) => {
      if (req.url?.includes("/moved")) return ok(res);
      res.statusCode = 308;
      res.setHeader("location", absolute ? `${origin}/moved` : "/moved");
      res.end();
    });
    origin = a.origin;
    try {
      await call(new Client({ [BASE_OPTION]: withCredentials(a.origin), maxRetries: 0 }));
      assert.equal(a.seen.length, 2);
      assert.deepEqual(a.seen.map((s) => s.authorization), [BASIC, BASIC], `absolute=${absolute}`);
    } finally {
      await a.close();
    }
  }
});

test("P3: a Location's own userinfo is never used", async () => {
  let origin = "";
  const a = await server((req, res) => {
    if (req.url?.includes("/moved")) return ok(res);
    res.statusCode = 302;
    res.setHeader("location", origin.replace("http://", "http://mallory:other@") + "/moved");
    res.end();
  });
  origin = a.origin;
  try {
    await call(new Client({ [BASE_OPTION]: a.origin, maxRetries: 0 }));
    assert.deepEqual(a.seen.map((s) => s.authorization), [undefined, undefined]);
  } finally {
    await a.close();
  }
});

test("P3: the transport is told not to follow redirects, and one that did is rejected", async () => {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(okBody)),
      url: "https://elsewhere.example/feed",
    };
  };
  await assert.rejects(
    call(new Client({ [BASE_OPTION]: `https://${USER}:${PW}@mirror.example`, transport, maxRetries: 0 })),
    (e: unknown) => e instanceof NetworkError && /followed a redirect to another origin/.test(e.message) && !e.message.includes(PW),
  );
  assert.equal(requests[0]?.redirect, "manual");
  assert.ok(!requests[0]?.url.includes(PW), "the transport never sees the userinfo in the URL");
  assert.equal(requests[0]?.headers?.["Authorization"], BASIC);
  // A transport that reports the URL it was asked for is fine.
  const same = async (req: HttpRequest): Promise<HttpResponse> => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(okBody)),
    url: req.url,
  });
  await assert.doesNotReject(call(new Client({ [BASE_OPTION]: "https://mirror.example", transport: same })));
});

test("P3: a 401 after an http→https redirect names the dropped credentials", async () => {
  const transport = async (req: HttpRequest): Promise<HttpResponse> =>
    req.url.startsWith("http:")
      ? { status: 301, headers: { location: req.url.replace("http:", "https:") }, body: Buffer.alloc(0) }
      : { status: 401, headers: {}, body: Buffer.alloc(0) };
  await assert.rejects(
    call(new Client({ [BASE_OPTION]: `http://${USER}:${PW}@mirror.example`, transport, maxRetries: 0 })),
    (e: unknown) => e instanceof ApiError && e.status === 401 && /http→https/.test(e.message) && /https base URL/.test(e.message),
  );
});
