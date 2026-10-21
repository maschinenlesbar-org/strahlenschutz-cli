// Compile-time checks of the exported library types: a consumer compiled with the strictest
// settings, and the runtime meaning of an option given as undefined.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StrahlenschutzClient } from "../src/index.js";
import { stationEcho } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "strahlenschutz-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { RequestEngine, StrahlenschutzClient, type EngineOptions, type FeatureQuery } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const query: FeatureQuery = allUndefined<FeatureQuery>();",
        "export const client = new StrahlenschutzClient({ baseUrl: process.env.STRAHLENSCHUTZ_BASE_URL, timeoutMs: 15_000 });",
        "export const latest = (): Promise<unknown> => client.latest({ station: process.env.KENN, sortBy: undefined, maxFeatures: undefined, startIndex: undefined });",
        "export const series = (): Promise<unknown> => client.timeseries(\"083370490\", \"ts-1h\", { sortBy: undefined, maxFeatures: undefined, startIndex: undefined });",
        "export const raw = (): Promise<unknown> => new RequestEngine().request(\"GET\", \"/x\", { query: undefined, accept: \"application/json\" });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const omitted = stationEcho();
  const given = stationEcho();
  const plain = new StrahlenschutzClient({ transport: omitted.transport });
  const client = new StrahlenschutzClient({
    baseUrl: undefined,
    userAgent: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: given.transport,
  });
  const none = { station: undefined, sortBy: undefined, maxFeatures: undefined, startIndex: undefined };
  await plain.latest();
  await client.latest(none);
  await plain.timeseries("083370490", "ts-24h");
  await client.timeseries("083370490", "ts-24h", { sortBy: undefined, maxFeatures: undefined, startIndex: undefined });
  assert.deepEqual(
    given.calls.map((req) => [req.url, req.headers?.["User-Agent"]]),
    omitted.calls.map((req) => [req.url, req.headers?.["User-Agent"]]),
  );
  assert.equal(given.calls[0]?.url.startsWith("https://www.imis.bfs.de/ogc/opendata/ows?"), true);
  assert.equal(given.calls[0]?.headers?.["User-Agent"], "strahlenschutz-cli");
});
