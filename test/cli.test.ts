import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { StrahlenschutzClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

const fc = { type: "FeatureCollection", features: [] };

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new StrahlenschutzClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("latest --max builds the WFS query", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["latest", "--max", "3"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("typeName"), "opendata:odlinfo_odl_1h_latest");
  assert.equal(url.searchParams.get("count"), "3");
});

const oneFeature = {
  type: "FeatureCollection",
  features: [{ type: "Feature", id: "x", geometry: null, properties: {} }],
};

test("station builds a viewparams filter", async () => {
  const cli = makeCli(() => jsonResponse(oneFeature));
  await run(["station", "091811461"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("viewparams"), "kenn:091811461");
});

test("station with no matching feature exits 4 (not found)", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["station", "999999999"], cli.deps);
  assert.equal(code, 4);
  assert.match(cli.err.join("\n"), /No station found/);
});

test("latest --sort and --start propagate to the WFS query", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  await run(["latest", "--sort", "end_measure+D", "--start", "10"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("sortBy"), "end_measure+D");
  assert.equal(url.searchParams.get("startIndex"), "10");
});

test("station rejects a non-numeric kenn before any request", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["station", "x;drop"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid station id/);
});

test("timeseries --resolution ts-24h picks the daily type", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  await run(["timeseries", "091811461", "--resolution", "ts-24h"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).searchParams.get("typeName"),
    "opendata:odlinfo_timeseries_odl_24h",
  );
});

test("timeseries rejects an invalid resolution before any request", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["timeseries", "x", "--resolution", "weekly"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid resolution/);
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["latest"], cli.deps);
  assert.equal(code, 4);
});

test("no arguments prints usage to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /Usage: strahlenschutz/);
  assert.equal(cli.mt.calls.length, 0);
});

test("--max rejects hex, exponent, empty, and unsafe magnitudes before any request", async () => {
  for (const bad of ["0x10", "1e3", "", "99999999999999999999", " 5 "]) {
    const cli = makeCli(() => jsonResponse(fc));
    const code = await run(["latest", "--max", bad], cli.deps);
    assert.notEqual(code, 0, `expected --max ${JSON.stringify(bad)} to be rejected`);
    assert.equal(cli.mt.calls.length, 0);
  }
});
