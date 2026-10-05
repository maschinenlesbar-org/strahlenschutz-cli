// Conformance test P4 + P19 (fix plan 2026-10-06): a base URL the client can't use fails as a
// usage error before any request (P4), and help works whatever an environment variable holds
// (P19). Shared across the *-cli repos; only the adapter block differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { StrahlenschutzClient as Client } from "../src/client/client.js";
import { StrahlValidationError as ValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
const BASE_URL_ENV: string | undefined = undefined; // strahlenschutz reads no environment variable (P19 skipped)
const SIMPLE_COMMAND = ["latest"];
const USAGE_EXIT = 1; // strahlenschutz's usage errors exit 1 (commander's default)
/** This repo's CliDeps: no env. */
function makeDeps(out: string[], err: string[], _env: Record<string, string>, transport: Transport): CliDeps {
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new Client({ ...opts, transport }),
  };
}
// --------------------------------------------------------------------------------------

function cli(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let requests = 0;
  const transport = async (): Promise<HttpResponse> => {
    requests++;
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") };
  };
  const deps: CliDeps = makeDeps(out, err, env, transport);
  return { deps, out, err, requests: () => requests };
}

test("P4: a '%' that isn't an escape in the userinfo is a usage error before any request", async () => {
  for (const url of ["https://alice:100%@mirror.example", "https://alice:pa%zzss@mirror.example", "https://al%ice:pw@mirror.example"]) {
    const c = cli();
    const code = await run(["--base-url", url, ...SIMPLE_COMMAND], c.deps);
    assert.equal(code, USAGE_EXIT, `${url}: ${c.err.join("\n")}`);
    assert.equal(c.requests(), 0);
    assert.match(c.err.join("\n"), /%25/);
    assert.throws(() => new Client({ baseUrl: url }), ValidationError);
  }
  // An escaped "%" is fine.
  assert.doesNotThrow(() => new Client({ baseUrl: "https://alice:100%25@mirror.example" }));
});

test("P19: help works whatever the base-URL variable holds", async (t) => {
  if (BASE_URL_ENV === undefined) return t.skip("this CLI reads no base-URL variable");
  for (const value of ["not a url", "http://x:99999", "ftp://h", " "]) {
    for (const argv of [["--help"], ["help"], ["help", ...SIMPLE_COMMAND], [...SIMPLE_COMMAND, "--help"]]) {
      const c = cli({ [BASE_URL_ENV]: value });
      const code = await run(argv, c.deps);
      assert.equal(code, 0, `${BASE_URL_ENV}=${JSON.stringify(value)} ${argv.join(" ")}: ${c.err.join("\n")}`);
    }
    // A command that uses it still fails as a usage error.
    const c = cli({ [BASE_URL_ENV]: value });
    assert.equal(await run(SIMPLE_COMMAND, c.deps), USAGE_EXIT);
  }
});
