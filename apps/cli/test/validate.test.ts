import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  baseUrlProblem,
  baseUrlWhitespaceProblem,
  featureKindProblem,
  headerValueProblem,
  intRangeProblem,
  nonEmptyProblem,
  normalizeSortBy,
  sortByProblem,
  timeseriesResolutionProblem,
  type Problem,
} from "@maschinenlesbar.org/strahlenschutz-client/internal/validate";
import { FeatureKindValues, TimeseriesResolutionValues } from "@maschinenlesbar.org/strahlenschutz-client/internal/enums";
import { StrahlError, StrahlValidationError } from "@maschinenlesbar.org/strahlenschutz-client/internal/errors";
import * as library from "../src/index.js";
import { StrahlenschutzClient } from "@maschinenlesbar.org/strahlenschutz-client/internal/client";
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
  for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty", "LATEST", 1, undefined]) {
    assert.match(featureKindProblem(bad) ?? "", /^Expected one of: latest, ts-1h, ts-24h \(got .*\)\.$/, String(bad));
  }
  // A closed set is a token (D8): a padded value is the value (sent trimmed), a blank or
  // invisible one is refused as such.
  assert.equal(featureKindProblem(" latest\n"), undefined);
  assert.equal(featureKindProblem(""), "Expected a non-empty value.");
  assert.equal(timeseriesResolutionProblem("ts-1h\u00ad"), '"ts-1h\\u00ad" contains an invisible or control character (U+00AD).');
});

test("intRangeProblem accepts safe integers within [min, max] and words its reasons like the CLI", () => {
  const problem = intRangeProblem(0, 10);
  for (const ok of [0, 5, 10]) assert.equal(problem(ok), undefined);
  assert.equal(problem(11), "Must be <= 10.");
  assert.equal(problem(-1), "Must be >= 0.");
  for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", undefined]) {
    assert.equal(problem(bad), "Expected a non-negative integer.", String(bad));
  }
  assert.equal(intRangeProblem(-5, 5)(0.5), "Expected an integer.");
});

test("headerValueProblem rejects blank, control-character and non-Latin-1 values", () => {
  for (const ok of ["ua", " ok ", "a\tb", "tüv", "ÿ"]) assert.equal(headerValueProblem(ok), undefined, ok);
  for (const blank of ["", "   ", undefined, 5]) assert.equal(headerValueProblem(blank), "Expected a non-empty value.");
  for (const ctl of ["a\r\nb", "a\u0000b", "a\u007fb", "a\u001bb"]) {
    assert.equal(headerValueProblem(ctl), "Value contains control characters.", JSON.stringify(ctl));
  }
  for (const wide of ["Ā", "bot☃", "\u{1F642}"]) {
    assert.equal(headerValueProblem(wide), "Value contains characters outside Latin-1 (above U+00FF).");
  }
});

test("baseUrlWhitespaceProblem rejects surrounding and inner whitespace or control characters", () => {
  for (const ok of ["https://www.imis.bfs.de", "https://h/p/", "https://u:pw@h"]) assert.equal(baseUrlWhitespaceProblem(ok), undefined);
  for (const padded of [" https://h", "https://h ", "https://h/ ", "https://h\t", "\nhttps://h"]) {
    assert.equal(baseUrlWhitespaceProblem(padded), "A base URL cannot have surrounding whitespace.", JSON.stringify(padded));
  }
  for (const inner of ["https://h/a b", "https://h/a\tb", "https://exa\nmple.org", "https://h/\u007f"]) {
    assert.equal(
      baseUrlWhitespaceProblem(inner),
      "A base URL cannot contain whitespace or control characters.",
      JSON.stringify(inner),
    );
  }
});

test("baseUrlProblem checks whitespace, parse, scheme and query/fragment in that order", () => {
  for (const ok of ["https://www.imis.bfs.de", "http://127.0.0.1:8080/bfs/", "https://u:pw@h"]) {
    assert.equal(baseUrlProblem(ok), undefined, ok);
  }
  assert.equal(baseUrlProblem(" ftp://x"), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem("notaurl"), "Expected a valid absolute URL (e.g. https://host).");
  assert.equal(baseUrlProblem("ftp://x?q"), 'Only "http:" and "https:" base URLs are supported.');
  assert.equal(baseUrlProblem("https://h#"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem(42), "Expected a string.");
});

test("every value an own message quotes is cut, never inside a surrogate pair", async () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const huge = "a" + "\u{1f600}".repeat(100_000);
  const client = new StrahlenschutzClient({ transport: async () => jsonResponse({ type: "FeatureCollection", features: [] }) });
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["resolution", () => client.timeseries("091811461", huge as never)],
    ["kind", () => client.getFeature(huge as never)],
    ["station", () => client.station(huge)],
    ["maxFeatures", () => client.latest({ maxFeatures: huge as never })],
    ["query key", () => client.latest({ [huge]: 1 } as never)],
    ["sortBy", () => client.latest({ sortBy: `${huge} X` })],
  ];
  for (const [label, call] of calls) {
    await assert.rejects(call, (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(err instanceof StrahlValidationError, `${label}: ${message.slice(0, 100)}`);
      assert.ok(message.length < 500, `${label}: ${message.length} characters`);
      assert.doesNotMatch(message, lone, label);
      assert.match(message, /…/, label);
      return true;
    }, label);
  }
});

test("a sort key is a property name in the documented syntax, sent trimmed and in NFC (D8)", () => {
  for (const ok of ["kenn", "end_measure D", "opendata:end_measure desc", "k\u00e9nn", "ke\u0301nn A", " value\tD , kenn "]) {
    assert.equal(sortByProblem(ok), undefined, JSON.stringify(ok));
  }
  assert.equal(normalizeSortBy("ke\u0301nn A"), "k\u00e9nn A");
  assert.equal(normalizeSortBy(" value\tD , kenn "), "value D,kenn");
  for (const bad of ["kenn+D", "a/b", ":kenn", "a:b:c", "..", ".", "%2e%2e", "1kenn", "kenn,a/b D"]) {
    assert.match(sortByProblem(bad) ?? "", /^Expected a property name \(a letter or "_", then letters, digits, "_", "\." or "-"\), got "/, JSON.stringify(bad));
  }
  // Blank, or only invisible characters, is blank; an invisible character inside is named.
  for (const blank of ["", " ", "\u200b", "\u0301"]) assert.equal(sortByProblem(blank), "Expected a non-empty value.", JSON.stringify(blank));
  assert.equal(sortByProblem("kenn\u200b"), '"kenn\\u200b" contains an invisible or control character (U+200B).');
});
