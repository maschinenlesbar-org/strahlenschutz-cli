import { test } from "node:test";
import assert from "node:assert/strict";
import { StrahlenschutzClient } from "../src/client/client.js";
import { StrahlApiError, StrahlError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): StrahlenschutzClient {
  return new StrahlenschutzClient({ transport: mt.transport });
}

const fc = { type: "FeatureCollection", features: [] };

test("latest sets the fixed WFS params and the latest typeName", async () => {
  const mt = constantJson(fc);
  await clientWith(mt).latest({ maxFeatures: 5 });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, "/ogc/opendata/ows");
  assert.equal(url.searchParams.get("service"), "WFS");
  assert.equal(url.searchParams.get("request"), "GetFeature");
  assert.equal(url.searchParams.get("outputFormat"), "application/json");
  assert.equal(url.searchParams.get("typeName"), "opendata:odlinfo_odl_1h_latest");
  // WFS 2.0 limit parameter is `count`, not the WFS 1.x `maxFeatures`.
  assert.equal(url.searchParams.get("count"), "5");
  assert.equal(url.searchParams.get("maxFeatures"), null);
});

test("station turns a kenn id into a CQL_FILTER", async () => {
  const mt = constantJson(fc);
  await clientWith(mt).station("091811461");
  assert.equal(new URL(mt.last().url).searchParams.get("CQL_FILTER"), "kenn='091811461'");
});

test("timeseries selects the resolution typeName and station", async () => {
  const mt = constantJson(fc);
  await clientWith(mt).timeseries("091811461", "ts-24h");
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("typeName"), "opendata:odlinfo_timeseries_odl_24h");
  assert.equal(url.searchParams.get("CQL_FILTER"), "kenn='091811461'");
});

test("timeseries defaults to the hourly type", async () => {
  const mt = constantJson(fc);
  await clientWith(mt).timeseries("091811461");
  assert.equal(
    new URL(mt.last().url).searchParams.get("typeName"),
    "opendata:odlinfo_timeseries_odl_1h",
  );
});

test("sortBy and startIndex are propagated to the WFS query", async () => {
  const mt = constantJson(fc);
  await clientWith(mt).latest({ sortBy: "end_measure D", startIndex: 10 });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("sortBy"), "end_measure D");
  assert.equal(url.searchParams.get("startIndex"), "10");
});

test("startIndex without an explicit limit gets a default count (WFS 2.0 paging)", async () => {
  // WFS 2.0 rejects a bare startIndex with HTTP 400; a count must accompany it.
  const mt = constantJson(fc);
  await clientWith(mt).latest({ startIndex: 10 });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("startIndex"), "10");
  assert.equal(url.searchParams.get("count"), "1000");
});

test("an explicit maxFeatures takes precedence over the default page count", async () => {
  const mt = constantJson(fc);
  await clientWith(mt).latest({ startIndex: 10, maxFeatures: 5 });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("count"), "5");
});

test("CQL_FILTER is percent-encoded in the URL (no injection)", async () => {
  // The encoding of the "kenn='<id>'" token is the central anti-injection property.
  // The "=" and "'" characters must be percent-encoded so the value cannot start a
  // second query parameter or break out of the CQL literal at the URL level.
  const mt = constantJson(fc);
  await clientWith(mt).station("091811461");
  assert.match(mt.last().url, /CQL_FILTER=kenn%3D%27091811461%27/);
});

test("an empty kenn is rejected with a StrahlError", async () => {
  const mt = constantJson(fc);
  await assert.rejects(() => clientWith(mt).station(""), StrahlError);
  assert.equal(mt.calls.length, 0);
});

test("a non-numeric kenn is rejected with a StrahlError", async () => {
  const mt = constantJson(fc);
  await assert.rejects(() => clientWith(mt).station("x;foo:bar"), StrahlError);
  await assert.rejects(() => clientWith(mt).timeseries("a b", "ts-1h"), StrahlError);
  await assert.rejects(() => clientWith(mt).latest({ station: "  " }), StrahlError);
  assert.equal(mt.calls.length, 0);
});

test("a 404 raises StrahlApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).latest(),
    (err) => err instanceof StrahlApiError && err.status === 404,
  );
});
