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
  assert.equal(url.searchParams.get("maxFeatures"), "5");
});

test("station turns a kenn id into a viewparams filter", async () => {
  const mt = constantJson(fc);
  await clientWith(mt).station("091811461");
  assert.equal(new URL(mt.last().url).searchParams.get("viewparams"), "kenn:091811461");
});

test("timeseries selects the resolution typeName and station", async () => {
  const mt = constantJson(fc);
  await clientWith(mt).timeseries("091811461", "ts-24h");
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("typeName"), "opendata:odlinfo_timeseries_odl_24h");
  assert.equal(url.searchParams.get("viewparams"), "kenn:091811461");
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
  await clientWith(mt).latest({ sortBy: "end_measure+D", startIndex: 10 });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("sortBy"), "end_measure+D");
  assert.equal(url.searchParams.get("startIndex"), "10");
});

test("viewparams is percent-encoded in the URL (no injection)", async () => {
  // The encoding of the "kenn:<id>" token is the central anti-injection property.
  // The ":" separator must be percent-encoded so the value cannot start a second
  // WFS view parameter at the URL level.
  const mt = constantJson(fc);
  await clientWith(mt).station("091811461");
  assert.match(mt.last().url, /viewparams=kenn%3A091811461/);
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
