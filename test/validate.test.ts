import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  featureKindProblem,
  nonEmptyProblem,
  timeseriesResolutionProblem,
  type Problem,
} from "../src/client/validate.js";
import { FeatureKindValues, TimeseriesResolutionValues } from "../src/client/enums.js";
import { StrahlError, StrahlValidationError } from "../src/client/errors.js";
import * as library from "../src/index.js";
import { StrahlenschutzClient } from "../src/client/client.js";
import { jsonResponse, parity } from "./helpers.js";

const nonEmpty: Problem<string> = (value) => (value.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("name", "x", nonEmpty), "x");
});

test("assertValid throws StrahlValidationError with 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("sortBy", " ", nonEmpty),
    (err: unknown) =>
      err instanceof StrahlValidationError &&
      err instanceof StrahlError &&
      err.name === "StrahlValidationError" &&
      err.message === "Invalid sortBy: Expected a non-empty value.",
  );
});

test("assertValid inside an async method rejects instead of throwing synchronously", async () => {
  const method = async (value: string): Promise<string> => assertValid("q", value, nonEmpty);
  const pending = method("");
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, StrahlValidationError);
});

test("the library root exports the validation layer", () => {
  assert.equal(library.StrahlValidationError, StrahlValidationError);
  assert.equal(library.assertValid, assertValid);
});

test("parity() runs one input through run() and the library on one recording transport", async () => {
  const fc = { type: "FeatureCollection", features: [] };
  const { cli, lib } = await parity(
    ["--compact", "latest", "--max", "2"],
    (transport) => new StrahlenschutzClient({ transport }).latest({ maxFeatures: 2 }),
    () => jsonResponse(fc),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.out, JSON.stringify(fc));
  assert.equal(lib.ok, true);
  assert.deepEqual(lib.value, fc);
  assert.equal(cli.requests.length, 1);
  assert.deepEqual(
    cli.requests.map((r) => r.url),
    lib.requests.map((r) => r.url),
  );

  const failing = await parity(["latest", "--max", "x"], () => {
    throw new StrahlValidationError("Invalid x: y");
  });
  assert.equal(failing.cli.code, 1);
  assert.deepEqual(failing.cli.requests, []);
  assert.equal(failing.lib.ok, false);
  assert.ok(failing.lib.error instanceof StrahlValidationError);
  assert.deepEqual(failing.lib.requests, []);
});

test("nonEmptyProblem rejects blank and non-string values", () => {
  assert.equal(nonEmptyProblem("kenn"), undefined);
  assert.equal(nonEmptyProblem(" kenn "), undefined);
  for (const bad of ["", " ", "\t\n", undefined, null, 5]) {
    assert.equal(nonEmptyProblem(bad), "Expected a non-empty value.", JSON.stringify(bad));
  }
});

test("featureKindProblem and timeseriesResolutionProblem accept only their own values", () => {
  for (const kind of FeatureKindValues) assert.equal(featureKindProblem(kind), undefined);
  for (const res of TimeseriesResolutionValues) assert.equal(timeseriesResolutionProblem(res), undefined);
  assert.deepEqual([...TimeseriesResolutionValues], ["ts-1h", "ts-24h"]);
  assert.equal(
    timeseriesResolutionProblem("latest"),
    'Expected one of: ts-1h, ts-24h (got "latest").',
  );
  for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty", "", " latest", 1, undefined]) {
    assert.match(featureKindProblem(bad) ?? "", /^Expected one of: latest, ts-1h, ts-24h \(got .*\)\.$/, String(bad));
  }
});
