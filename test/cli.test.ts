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

test("station builds a CQL_FILTER", async () => {
  const cli = makeCli(() => jsonResponse(oneFeature));
  await run(["station", "091811461"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("CQL_FILTER"), "kenn='091811461'");
});

test("station with no matching feature exits 4 (not found)", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["station", "999999999"], cli.deps);
  assert.equal(code, 4);
  assert.match(cli.err.join("\n"), /No station found/);
});

test("latest --sort and --start propagate to the WFS query", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  await run(["latest", "--sort", "end_measure D", "--start", "10"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("sortBy"), "end_measure D");
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

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "x",
        geometry: null,
        properties: { name: `Station${controls}`, kenn: String.fromCharCode(0x1b) + "[31m" },
      },
    ],
  };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "latest"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) =>
      c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f,
    );
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Station\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
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

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  assert.equal(await run(["--timeout", "2147483647", "latest"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(fc));
  assert.equal(await run(["--timeout", "2147483648", "latest"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0); // rejected before any request
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("--base-url rejects a non-http(s) scheme at parse time before any request", async () => {
  for (const bad of ["file:///etc/passwd", "ftp://host/x", "not a url"]) {
    const cli = makeCli(() => jsonResponse(fc));
    const code = await run(["--base-url", bad, "latest"], cli.deps);
    assert.notEqual(code, 0, `expected --base-url ${JSON.stringify(bad)} to be rejected`);
    assert.equal(cli.mt.calls.length, 0);
  }
});

test("--base-url accepts a well-formed https URL", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["--base-url", "https://example.test", "latest"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).origin, "https://example.test");
});
