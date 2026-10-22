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

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7, 03#5)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26), the stack and
  // the answer, so it is probed here, never assumed.
  const depth = 200_000;
  const body = `{"type":"FeatureCollection","features":[{"type":"Feature","id":"x","geometry":null,"properties":{"x":${"[".repeat(depth)}${"]".repeat(depth)}}}]}`;
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(body));
  } catch {
    compactPrints = false;
  }
  const deep = (): HttpResponse => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(body) });
  const pretty = makeCli(deep);
  assert.equal(await run(["latest"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.deepEqual(pretty.err, [
    `ERROR [strahlenschutz.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  ]);
  const compact = makeCli(deep);
  assert.equal(await run(["--compact", "latest"], compact.deps), compactPrints ? 0 : 1);
  if (compactPrints) assert.equal(compact.out.join("").length, body.length);
  else assert.deepEqual(compact.err, ["ERROR [strahlenschutz.output] The answer is nested too deeply to print."]);
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli();
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (gap === 2 || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
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
