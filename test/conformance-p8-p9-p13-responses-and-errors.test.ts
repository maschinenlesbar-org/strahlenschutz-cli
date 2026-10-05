// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { StrahlenschutzClient as Client } from "../src/client/client.js";
import {
  StrahlError as BaseError,
  StrahlParseError as ParseError,
  StrahlValidationError as ValidationError,
} from "../src/client/errors.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.latest();
const textBody = (text: string): unknown => ({
  type: "FeatureCollection",
  features: [{ type: "Feature", id: "x", geometry: null, properties: { name: text, unit: "µSv/h" } }],
});
const readText = (result: unknown): string =>
  (result as { features: Array<{ properties: { name: string } }> }).features[0]!.properties.name;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  null, {}, [], "text", 42, { features: "x" }, { error: "boom" }, { features: null },
  { type: "FeatureCollection", features: [null] },
  { type: "FeatureCollection", features: [1] },
  { type: "FeatureCollection", features: [{ type: "Feature" }] },
];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["station(5)", () => new Client().station(5 as unknown as string)],
  ["station(null)", () => new Client().station(null as unknown as string)],
  ["station(['1'])", () => new Client().station(["1"] as unknown as string)],
  ["latest('x')", () => new Client().latest("x" as never)],
  ["latest({ station: 5 })", () => new Client().latest({ station: 5 as unknown as string })],
  ["latest({ maxFeatures: '5' })", () => new Client().latest({ maxFeatures: "5" as unknown as number })],
  ["latest({ sortBy: 5 })", () => new Client().latest({ sortBy: 5 as unknown as string })],
  ["latest({ startIndex: -1 })", () => new Client().latest({ startIndex: -1 })],
  ["timeseries('1', 'latest')", () => new Client().timeseries("1", "latest" as never)],
  ["timeseries('1', 5)", () => new Client().timeseries("1", 5 as never)],
  ["getFeature('bogus')", () => new Client().getFeature("bogus" as never)],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["maxRedirects: 11", () => new Client({ maxRedirects: 11 })],
  ["retryDelayMs: 30001", () => new Client({ retryDelayMs: 30_001 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as never })],
  ["sleep: 1", () => new Client({ sleep: 1 as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
