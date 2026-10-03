import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SORT_BY, StrahlenschutzClient } from "../src/client/client.js";
import {
  StrahlApiError,
  StrahlError,
  StrahlNotFoundError,
  StrahlParseError,
  StrahlValidationError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): StrahlenschutzClient {
  return new StrahlenschutzClient({ transport: mt.transport });
}

const fc = { type: "FeatureCollection", features: [] };
/** station() treats an empty result as not-found, so its tests answer with one feature. */
const oneStation = {
  type: "FeatureCollection",
  features: [{ type: "Feature", id: "x", geometry: null, properties: {} }],
};

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
  const mt = constantJson(oneStation);
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

test("every query is sorted by a stable default key unless the caller sorts", async () => {
  // The layers have no primary key: GeoServer refuses a startIndex on an unsorted
  // query with HTTP 400, so the client always sends a sortBy.
  const cases: Array<[(c: StrahlenschutzClient) => Promise<unknown>, string]> = [
    [(c) => c.latest(), "kenn"],
    [(c) => c.latest({ startIndex: 10, maxFeatures: 5 }), "kenn"],
    [(c) => c.station("091811461"), "kenn"],
    [(c) => c.timeseries("091811461"), "kenn,end_measure"],
    [(c) => c.timeseries("091811461", "ts-24h", { startIndex: 2 }), "kenn,end_measure"],
    [(c) => c.latest({ sortBy: "end_measure D", startIndex: 10 }), "end_measure D"],
  ];
  for (const [call, expected] of cases) {
    const mt = constantJson(oneStation);
    await call(clientWith(mt));
    assert.equal(new URL(mt.last().url).searchParams.get("sortBy"), expected);
  }
  assert.deepEqual(DEFAULT_SORT_BY, { latest: "kenn", "ts-1h": "kenn,end_measure", "ts-24h": "kenn,end_measure" });
});

test("startIndex without an explicit limit sends no count, so the rest of the collection comes back", async () => {
  // A made-up count (it used to be 1000) silently cut `--start 600` of 1676 stations
  // to 1000; with the sortBy the server honours a bare startIndex.
  const mt = constantJson(fc);
  await clientWith(mt).latest({ startIndex: 10 });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("startIndex"), "10");
  assert.equal(url.searchParams.get("count"), null);
});

test("an explicit maxFeatures is sent as count next to startIndex", async () => {
  const mt = constantJson(fc);
  await clientWith(mt).latest({ startIndex: 10, maxFeatures: 5 });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("count"), "5");
});

test("CQL_FILTER is percent-encoded in the URL (no injection)", async () => {
  // The encoding of the "kenn='<id>'" token is the central anti-injection property.
  // The "=" and "'" characters must be percent-encoded so the value cannot start a
  // second query parameter or break out of the CQL literal at the URL level.
  const mt = constantJson(oneStation);
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

test("a 200 body that is valid JSON but not a FeatureCollection raises StrahlParseError", async () => {
  // A hostile/MITM'd or merely buggy endpoint returns well-formed JSON whose
  // shape is not a GeoJSON FeatureCollection. The shape guard must turn each of
  // these into a typed StrahlParseError rather than letting an untyped TypeError
  // surface later when a caller dereferences `features.length`.
  for (const body of [{}, { features: null }, { features: "nope" }, [], 42, "str", null]) {
    const mt = makeMockTransport(() => jsonResponse(body));
    await assert.rejects(() => clientWith(mt).latest(), StrahlParseError);
  }
});

test("the client rejects a non-http(s) base URL even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fc));
    assert.throws(
      () => new StrahlenschutzClient({ baseUrl, transport: mt.transport }),
      (err) =>
        err instanceof StrahlValidationError &&
        err.message === 'Invalid baseUrl: Only "http:" and "https:" base URLs are supported.',
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("a base URL with a query or fragment is rejected at construction (userinfo redacted)", () => {
  for (const baseUrl of ["https://www.imis.bfs.de/?x=1", "https://u:s3cretpw@www.imis.bfs.de/#f"]) {
    assert.throws(
      () => new StrahlenschutzClient({ baseUrl, transport: constantJson(fc).transport }),
      (err: unknown) =>
        err instanceof StrahlValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#)." &&
        !err.message.includes("s3cretpw"),
      baseUrl,
    );
  }
});

test("maxFeatures and startIndex must be non-negative safe integers (no request otherwise)", async () => {
  for (const [query, message] of [
    [{ maxFeatures: Number.NaN }, "Invalid maxFeatures: expected a non-negative integer, got NaN."],
    [{ maxFeatures: -5 }, "Invalid maxFeatures: expected a non-negative integer, got -5."],
    [{ maxFeatures: 1.5 }, "Invalid maxFeatures: expected a non-negative integer, got 1.5."],
    [{ maxFeatures: 2 ** 53 }, "Invalid maxFeatures: expected a non-negative integer, got 9007199254740992."],
    [{ startIndex: -1 }, "Invalid startIndex: expected a non-negative integer, got -1."],
    [{ startIndex: "10" as unknown as number }, 'Invalid startIndex: expected a non-negative integer, got "10".'],
  ] as const) {
    const mt = constantJson(fc);
    await assert.rejects(
      () => clientWith(mt).latest(query),
      (err: unknown) => err instanceof StrahlError && err.message === message,
    );
    assert.equal(mt.calls.length, 0);
  }
  const mt = constantJson(fc);
  await clientWith(mt).latest({ maxFeatures: 0, startIndex: 0 });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("count"), "0");
  assert.equal(url.searchParams.get("startIndex"), "0");
});

test("every feature must be a JSON object with a properties object", async () => {
  for (const [features, message] of [
    [["a", 1, null], "feature 0 is a string."],
    [[{ type: "Feature", properties: {} }, null], "feature 1 is null."],
    [[[1]], "feature 0 is an array."],
    [[{ type: "Feature", geometry: null }], "feature 0 has none."],
    [[{ type: "Feature", properties: null }], "feature 0 has none."],
  ] as const) {
    const mt = makeMockTransport(() => jsonResponse({ type: "FeatureCollection", features }));
    await assert.rejects(
      () => clientWith(mt).latest(),
      (err: unknown) =>
        err instanceof StrahlParseError &&
        err.message ===
          `Unexpected response shape from the WFS: expected every feature to be a JSON object with a properties object, ${message}`,
    );
  }
});

test("station() rejects with StrahlNotFoundError when the WFS returns no feature", async () => {
  const mt = constantJson(fc);
  await assert.rejects(clientWith(mt).station("999999999"), (err: unknown) =>
    err instanceof StrahlNotFoundError && err.message === 'No station found for kenn "999999999".',
  );
  assert.equal(mt.calls.length, 1);
  // latest({ station }) and timeseries() pass the empty collection through.
  assert.deepEqual(await clientWith(mt).latest({ station: "999999999" }), fc);
  assert.deepEqual(await clientWith(mt).timeseries("999999999"), fc);
});
