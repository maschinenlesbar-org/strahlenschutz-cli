// CLI <-> library parity: the same input through run() and through the library
// call, on one recording mock transport, must give the same outcome — both reject
// before any request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StrahlenschutzClient } from "../src/client/client.js";
import { StrahlValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import { parity } from "./helpers.js";

/** Assert that both sides rejected the input without sending a request. */
function assertBothReject(
  label: string,
  result: Awaited<ReturnType<typeof parity>>,
  libError: new (...args: never[]) => Error = StrahlValidationError,
): void {
  const { cli, lib } = result;
  assert.notEqual(cli.code, 0, `${label}: CLI exit`);
  assert.deepEqual(cli.requests, [], `${label}: CLI requests`);
  assert.equal(lib.ok, false, `${label}: library resolved`);
  assert.ok(lib.error instanceof libError, `${label}: library error ${String(lib.error)}`);
  assert.deepEqual(lib.requests, [], `${label}: library requests`);
}

test("parity: a blank sortBy is rejected by the CLI and the library before any request", async () => {
  const cases: [string[], (transport: Transport) => Promise<unknown>][] = [
    [["latest", "--sort", "", "--start", "5"], (transport) => new StrahlenschutzClient({ transport }).latest({ sortBy: "", startIndex: 5 })],
    [["latest", "--sort", "   "], (transport) => new StrahlenschutzClient({ transport }).latest({ sortBy: "   " })],
    [
      ["timeseries", "091811461", "--sort", " ", "--start", "3"],
      (transport) => new StrahlenschutzClient({ transport }).timeseries("091811461", "ts-1h", { sortBy: " ", startIndex: 3 }),
    ],
  ];
  for (const [argv, call] of cases) {
    assertBothReject(JSON.stringify(argv), await parity(argv, call));
  }
  const direct = await parity(["timeseries", "091811461", "--resolution", "ts-24h", "--sort", ""], (transport) =>
    new StrahlenschutzClient({ transport }).getFeature("ts-24h", { station: "091811461", sortBy: "" }),
  );
  assertBothReject("getFeature ts-24h sortBy ''", direct);
  assert.equal((direct.lib.error as Error).message, "Invalid sortBy: Expected a non-empty value.");
});

test("parity: a padded but non-blank sortBy is sent unchanged by both", async () => {
  const { cli, lib } = await parity(["latest", "--sort", " kenn "], (transport) =>
    new StrahlenschutzClient({ transport }).latest({ sortBy: " kenn " }),
  );
  assert.equal(cli.code, 0);
  assert.equal(lib.ok, true);
  assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url));
});

test("parity: an invalid timeseries resolution is rejected by the CLI and the library before any request", async () => {
  for (const res of ["latest", "ts-7d", "TS-1H", " ts-1h", "", "bogus", "__proto__", "toString", "constructor"]) {
    const result = await parity(["--compact", "timeseries", "091811461", "--resolution", res], (transport) =>
      new StrahlenschutzClient({ transport }).timeseries("091811461", res as never),
    );
    assertBothReject(JSON.stringify(res), result);
    assert.equal(
      (result.lib.error as Error).message,
      `Invalid resolution: Expected one of: ts-1h, ts-24h (got ${JSON.stringify(res)}).`,
    );
    assert.equal(result.cli.err, `Error: ${(result.lib.error as Error).message}`);
  }
});

test("parity: a valid resolution sends the identical request from both sides", async () => {
  for (const res of ["ts-1h", "ts-24h"] as const) {
    const { cli, lib } = await parity(["timeseries", "091811461", "--resolution", res], (transport) =>
      new StrahlenschutzClient({ transport }).timeseries("091811461", res),
    );
    assert.equal(cli.code, 0);
    assert.equal(lib.ok, true);
    assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url));
  }
});

test("getFeature rejects an unknown feature kind, inherited names included, before any request", async () => {
  for (const kind of ["bogus", "", "constructor", "__proto__", "toString", "LATEST"]) {
    const { lib } = await parity(["latest"], (transport) =>
      new StrahlenschutzClient({ transport }).getFeature(kind as never),
    );
    assert.equal(lib.ok, false, kind);
    assert.ok(lib.error instanceof StrahlValidationError, kind);
    assert.equal(
      (lib.error as Error).message,
      `Invalid kind: Expected one of: latest, ts-1h, ts-24h (got ${JSON.stringify(kind)}).`,
    );
    assert.deepEqual(lib.requests, []);
  }
});
