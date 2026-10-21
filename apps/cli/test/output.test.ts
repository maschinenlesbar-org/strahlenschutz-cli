// The JSON rendering of src/cli/shared.ts: a deep answer refused cleanly, the --compact path
// chosen per answer, terminal controls escaped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/shared.js";
import type { CliDeps } from "../src/cli/io.js";
import { StrahlenschutzClient } from "@maschinenlesbar.org/strahlenschutz-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/strahlenschutz-client/internal/http";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";

const FC = { type: "FeatureCollection", features: [{ type: "Feature", id: "x", geometry: null, properties: { kenn: "083370490" } }] };

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse(FC)) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(untimed(s)) },
    createClient: (opts) => new StrahlenschutzClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("pretty-printing an answer nested too deeply is a clean error that suggests --compact", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't.
  const depth = 200_000;
  const cli = makeCli(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(
      `{"type":"FeatureCollection","features":[{"type":"Feature","id":"x","geometry":null,"properties":{"x":${"[".repeat(depth)}${"]".repeat(depth)}}}]}`,
    ),
  }));
  assert.equal(await run(["latest"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.deepEqual(cli.err, ["ERROR [strahlenschutz.output] The answer is nested too deeply to pretty-print; try --compact."]);
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli();
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("DEL, C1 and the bidi controls in server data are escaped in the JSON output, pretty and --compact", async () => {
  const controls = String.fromCharCode(0x7f, 0x9b, 0x202e, 0x2066, 0x200f, 0x061c);
  const served = { type: "FeatureCollection", features: [{ type: "Feature", id: "x", geometry: null, properties: { name: `A1${controls}live` } }] };
  for (const argv of [["latest"], ["--compact", "latest"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run(argv, cli.deps), 0);
    const text = cli.out.join("\n");
    assert.ok(!/[\u007f\u009b‮⁦‏؜]/.test(text), argv.join(" "));
    assert.match(text, /A1\\u007f\\u009b\\u202e\\u2066\\u200f\\u061clive/);
    assert.deepEqual(JSON.parse(text), served);
  }
});
