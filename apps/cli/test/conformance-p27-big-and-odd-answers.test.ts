// Conformance test P27 (fix plan 2026-10-21, D2 and D7): a big or odd answer is printed or
// refused in one clean record, within memory; never a heap crash, never output `jq` can't read.
// - A large flat answer prints with --compact under a small heap: the check for huge strings
//   before printing walks it without an allocation per value (Object.entries made one pair per
//   element: 7 GB and a crash on 48M numbers).
// The memory cases run the built bin in a child process with --max-old-space-size. Shared across
// the *-cli repos that print JSON; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

// ---- adapter (per repo) -------------------------------------------------------------
/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
/** CLI argv (after the global options) for a call whose answer carries a free-form value. */
const call = ["latest"];
/** The raw 2xx body with `json` (a JSON value, written as is) as that value (a station's property). */
const bodyWith = (json: string): string =>
  `{"type":"FeatureCollection","features":[{"type":"Feature","id":"x","geometry":null,"properties":{"kenn":"083370490","x":${json}}}]}`;
/** The value from the CLI's printed result. */
type Answer = { features: Array<{ properties: { x: unknown } }> };
const fromCli = (out: string): unknown => (JSON.parse(out) as Answer).features[0]?.properties.x;
// --------------------------------------------------------------------------------------

// These tests start the built CLI as a process: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

/** Serve `body` (as JSON) to one run of the bin with a heap of `heapMb`, then stop. */
async function runWithAnswer(body: Buffer, heapMb: number, argv: string[] = []): Promise<Run> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await new Promise<Run>((resolve) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${heapMb}`, BIN, "--base-url", base, "--max-retries", "0", ...argv, ...call],
        { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
      );
      const out: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr }));
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** No crash: no V8 out-of-memory report, no abort, no stack. */
function noCrash(run: Run, label: string): void {
  assert.notEqual(run.signal, "SIGABRT", `${label}: aborted`);
  assert.ok(run.code !== null && run.code !== 134, `${label}: exit ${run.code} ${run.signal}`);
  assert.doesNotMatch(run.stderr, /FATAL ERROR|heap out of memory|Allocation failed|\n\s+at /, `${label}: ${run.stderr.slice(0, 500)}`);
}

test("P27: a large flat answer prints with --compact within a small heap", STARTS_A_PROCESS, async () => {
  const n = 8_000_000;
  const run = await runWithAnswer(Buffer.from(bodyWith(`[${"1,".repeat(n - 1)}1]`)), 256, ["--compact"]);
  noCrash(run, "flat");
  assert.equal(run.code, 0, run.stderr.slice(0, 500));
  const printed = fromCli(run.stdout.toString("utf8")) as unknown[];
  assert.equal(printed.length, n);
});
