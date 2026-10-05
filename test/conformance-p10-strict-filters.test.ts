// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { StrahlenschutzClient as Client } from "../src/client/client.js";
import { StrahlValidationError as ValidationError } from "../src/client/errors.js";
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> =>
  client.latest(query as never);
/** A valid query, and the filter it sends (read back from the request by `sentFilter`). */
const GOOD = { query: { station: "083370490" } };
const GOOD_SENT = "kenn='083370490'";
/** What a data request carries as its filter (to compare with GOOD_SENT). */
const sentFilter = (req: HttpRequest): string | null => new URL(req.url).searchParams.get("CQL_FILTER");
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { kenn: "083370490" }],
  ["misspelled key", { statoin: "083370490" }],
  ["wrong-case key", { Station: "083370490" }],
  ["WFS 1.x key", { maxfeatures: 2 }],
  ["__proto__ key", JSON.parse('{"__proto__": {"station": "083370490"}}') as Record<string, unknown>],
];
/**
 * The WFS has one filter, on the station id; "names it doesn't have" are station values
 * that are no kenn (the CQL filter would match nothing or something else).
 */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [
  ["letter O for a zero", { station: "08337049O" }],
  ["inner space", { station: "0833 70490" }],
  ["__proto__ as id", { station: "__proto__" }],
  ["constructor as id", { station: "constructor" }],
  ["Arabic-Indic digits", { station: "\u0660\u0668\u0663" }],
];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array station", { station: ["083370490", "010010001"] }],
  ["one-element array station", { station: ["083370490"] }],
  ["object station", { station: { kenn: "083370490" } }],
  ["number station (drops the leading zero)", { station: 83370490 }],
  ["NaN maxFeatures", { maxFeatures: Number.NaN }],
  ["NaN startIndex", { startIndex: Number.NaN }],
  ["array maxFeatures", { maxFeatures: [1, 2] }],
  ["array sortBy", { sortBy: ["kenn", "value D"] }],
];
/**
 * Queries that differ from GOOD only in how the id is spelled (padding): "normalise" = sent
 * as GOOD_SENT; "reject" = the validation error.
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [
  ["padded id", { station: " 083370490 " }],
  ["id with a trailing newline", { station: "083370490\n" }],
];
const UNNORMALISED_POLICY = "normalise" as "normalise" | "reject";
/** The CLI's filter flag given twice, and what the repo does with it (one station per query). */
const REPEATED_FLAG_ARGV = ["latest", "--station", "083370490", "--station", "010010001"];
const REPEATED_POLICY = "reject" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["latest", "--sort", "kenn", "--sort", "value D"];
const USAGE_EXIT = 1; // strahlenschutz's usage errors exit 1 (commander's default)
/** Every request the client sends fetches data. */
const isDataRequest = (_req: HttpRequest): boolean => true;
/** The answer to any request. */
const respond = (_req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json;charset=UTF-8" },
  body: Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [] })),
});
/** CliDeps for this repo. */
const makeDeps = (io: CliDeps["io"], transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io,
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
