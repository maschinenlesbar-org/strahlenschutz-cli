// CLI <-> library parity: the same input through run() and through the library
// call, on one recording mock transport, must give the same outcome — both reject
// before any request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StrahlenschutzClient } from "../src/client/client.js";
import { StrahlNotFoundError, StrahlValidationError } from "../src/client/errors.js";
import * as library from "../src/index.js";
import { MAX_RETRIES, MAX_TIMEOUT_MS } from "../src/index.js";
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

test("parity: station() for an unknown kenn is a not-found on both sides, after the same request", async () => {
  const { cli, lib } = await parity(["--compact", "station", "4711"], (transport) =>
    new StrahlenschutzClient({ transport }).station("4711"),
  );
  assert.equal(cli.code, 4);
  assert.equal(cli.err, 'Error: No station found for kenn "4711".');
  assert.equal(lib.ok, false);
  assert.ok(lib.error instanceof StrahlNotFoundError, String(lib.error));
  assert.equal((lib.error as Error).message, 'No station found for kenn "4711".');
  assert.equal(cli.requests.length, 1);
  assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url));
});

test("parity: latest --station keeps an empty result as success on both sides", async () => {
  const { cli, lib } = await parity(["--compact", "latest", "--station", "4711"], (transport) =>
    new StrahlenschutzClient({ transport }).latest({ station: "4711" }),
  );
  assert.equal(cli.code, 0);
  assert.equal(lib.ok, true);
  assert.equal(cli.out, JSON.stringify(lib.value));
});

test("the library root exports StrahlNotFoundError", () => {
  assert.equal(library.StrahlNotFoundError, StrahlNotFoundError);
});

test("parity: out-of-range numeric engine options are rejected by the CLI and the library before any request", async () => {
  const cases: [string, string, Record<string, number>][] = [
    ["--max-retries", "11", { maxRetries: 11 }],
    ["--max-retries", "-1", { maxRetries: -1 }],
    ["--max-retries", "1.5", { maxRetries: 1.5 }],
    ["--timeout", "-1", { timeoutMs: -1 }],
    ["--timeout", "1.5", { timeoutMs: 1.5 }],
    ["--timeout", "2147483648", { timeoutMs: 2_147_483_648 }],
    ["--max-response-bytes", "-1", { maxResponseBytes: -1 }],
    ["--max-response-bytes", "1.5", { maxResponseBytes: 1.5 }],
  ];
  for (const [flag, value, options] of cases) {
    const result = await parity([flag, value, "latest"], (transport) =>
      new StrahlenschutzClient({ transport, ...options }).latest(),
    );
    assertBothReject(`${flag} ${value}`, result);
  }
});

test("parity: the numeric engine option bounds are accepted by both", async () => {
  const cases: [string, string, Record<string, number>][] = [
    ["--max-retries", "0", { maxRetries: 0 }],
    ["--max-retries", String(MAX_RETRIES), { maxRetries: MAX_RETRIES }],
    ["--timeout", "0", { timeoutMs: 0 }],
    ["--timeout", String(MAX_TIMEOUT_MS), { timeoutMs: MAX_TIMEOUT_MS }],
    ["--max-response-bytes", "0", { maxResponseBytes: 0 }],
  ];
  for (const [flag, value, options] of cases) {
    const { cli, lib } = await parity([flag, value, "latest"], (transport) =>
      new StrahlenschutzClient({ transport, ...options }).latest(),
    );
    assert.equal(cli.code, 0, `${flag} ${value}`);
    assert.equal(lib.ok, true, `${flag} ${value}`);
    assert.deepEqual(cli.requests, lib.requests);
  }
});

test("parity: a blank or unsendable User-Agent is rejected by the CLI and the library before any request", async () => {
  for (const ua of ["", "  ", "a\r\nX-Evil: 1", "ua\u0007", "a\u007fb", "bot☃"]) {
    const result = await parity(["--user-agent", ua, "latest"], (transport) =>
      new StrahlenschutzClient({ transport, userAgent: ua }).latest(),
    );
    assertBothReject(JSON.stringify(ua), result);
  }
});

test("parity: a valid User-Agent (Latin-1, tab, padding) is sent unchanged by both", async () => {
  for (const ua of [" ok ", "odl-tüv\t1"]) {
    const { cli, lib } = await parity(["--user-agent", ua, "latest"], (transport) =>
      new StrahlenschutzClient({ transport, userAgent: ua }).latest(),
    );
    assert.equal(cli.code, 0);
    assert.equal(lib.ok, true);
    assert.equal(lib.requests[0]?.headers?.["User-Agent"], ua);
    assert.deepEqual(cli.requests, lib.requests);
  }
});

test("parity: a base URL with whitespace is rejected by the CLI and the library before any request", async () => {
  for (const baseUrl of ["https://example.org ", " https://example.org", "https://example.org\t", "https://example.org/ ", "https://exa\nmple.org", "https://example.org/a b"]) {
    const result = await parity(["--base-url", baseUrl, "latest"], (transport) =>
      new StrahlenschutzClient({ transport, baseUrl }).latest(),
    );
    assertBothReject(JSON.stringify(baseUrl), result);
  }
});

test("parity: a well-formed base URL with a path prefix and userinfo is used the same by both", async () => {
  for (const baseUrl of ["https://mirror.example/bfs/", "https://u:pw@mirror.example"]) {
    const { cli, lib } = await parity(["--base-url", baseUrl, "latest"], (transport) =>
      new StrahlenschutzClient({ transport, baseUrl }).latest(),
    );
    assert.equal(cli.code, 0);
    assert.equal(lib.ok, true);
    assert.deepEqual(cli.requests, lib.requests);
  }
});
