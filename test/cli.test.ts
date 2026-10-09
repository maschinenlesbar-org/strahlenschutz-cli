import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { StrahlenschutzClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { StrahlValidationError, credentialsIn } from "../src/client/errors.js";
import { LIVE_EXCEPTION_REPORT, makeMockTransport, jsonResponse, rawResponse, untimed } from "./helpers.js";

const fc = { type: "FeatureCollection", features: [] };

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new StrahlenschutzClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("latest --max builds the WFS query", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["latest", "--max", "3"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("typeName"), "opendata:odlinfo_odl_1h_latest");
  assert.equal(url.searchParams.get("count"), "3");
});

const oneFeature = {
  type: "FeatureCollection",
  features: [{ type: "Feature", id: "x", geometry: null, properties: {} }],
};

test("station builds a CQL_FILTER", async () => {
  const cli = makeCli(() => jsonResponse(oneFeature));
  await run(["station", "091811461"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("CQL_FILTER"), "kenn='091811461'");
});

test("station with no matching feature exits 4 (not found)", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["station", "999999999"], cli.deps);
  assert.equal(code, 4);
  assert.match(cli.err.join("\n"), /No station found/);
});

test("latest --sort and --start propagate to the WFS query", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  await run(["latest", "--sort", "end_measure D", "--start", "10"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("sortBy"), "end_measure D");
  assert.equal(url.searchParams.get("startIndex"), "10");
});

test("latest --start without --sort sends the default kenn sort, so the service can page", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  assert.equal(await run(["latest", "--max", "2", "--start", "2"], cli.deps), 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("sortBy"), "kenn");
  assert.equal(url.searchParams.get("startIndex"), "2");
});

test("station rejects a non-numeric kenn before any request", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["station", "x;drop"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid station id/);
});

test("timeseries --resolution ts-24h picks the daily type", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  await run(["timeseries", "091811461", "--resolution", "ts-24h"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).searchParams.get("typeName"),
    "opendata:odlinfo_timeseries_odl_24h",
  );
});

test("timeseries rejects an invalid resolution before any request", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["timeseries", "x", "--resolution", "weekly"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid resolution/);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "x",
        geometry: null,
        properties: { name: `Station${controls}`, kenn: String.fromCharCode(0x1b) + "[31m" },
      },
    ],
  };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "latest"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) =>
      c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f,
    );
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Station\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("an HTTP 404 exits 1 with an endpoint note, not 4 (station not found)", async () => {
  for (const argv of [["latest", "--max", "1"], ["station", "091811461"], ["timeseries", "091811461"]]) {
    const cli = makeCli(() => jsonResponse({}, 404));
    const code = await run(["--base-url", "http://127.0.0.1:18133/e404", ...argv], cli.deps);
    assert.equal(code, 1, argv.join(" "));
    assert.equal(cli.err.length, 1);
    assert.match(
      untimed(cli.err[0] ?? ""),
      /^ERROR \[strahlenschutz\.api\] HTTP 404 for GET http:\/\/127\.0\.0\.1:18133\/e404\/ogc\/opendata\/ows\?\S+ \(the WFS endpoint itself was not found: a wrong --base-url, or the API moved\)$/,
    );
  }
});

test("no arguments prints usage to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /Usage: strahlenschutz/);
  assert.equal(cli.mt.calls.length, 0);
});

test("--max rejects hex, exponent, empty, and unsafe magnitudes before any request", async () => {
  for (const bad of ["0x10", "1e3", "", "99999999999999999999", " 5 "]) {
    const cli = makeCli(() => jsonResponse(fc));
    const code = await run(["latest", "--max", bad], cli.deps);
    assert.notEqual(code, 0, `expected --max ${JSON.stringify(bad)} to be rejected`);
    assert.equal(cli.mt.calls.length, 0);
  }
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  assert.equal(await run(["--timeout", "2147483647", "latest"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(fc));
  assert.equal(await run(["--timeout", "2147483648", "latest"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0); // rejected before any request
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("--base-url rejects a non-http(s) scheme at parse time before any request", async () => {
  for (const bad of ["file:///etc/passwd", "ftp://host/x", "not a url"]) {
    const cli = makeCli(() => jsonResponse(fc));
    const code = await run(["--base-url", bad, "latest"], cli.deps);
    assert.notEqual(code, 0, `expected --base-url ${JSON.stringify(bad)} to be rejected`);
    assert.equal(cli.mt.calls.length, 0);
  }
});

test("--base-url accepts a well-formed https URL", async () => {
  const cli = makeCli(() => jsonResponse(fc));
  const code = await run(["--base-url", "https://example.test", "latest"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).origin, "https://example.test");
});

test("blank --sort values are rejected at parse time before any request", async () => {
  const cases: string[][] = [
    ["latest", "--sort", ""],
    ["latest", "--sort", "   "],
    ["timeseries", "091811461", "--sort", ""],
  ];
  for (const argv of cases) {
    const cli = makeCli(() => jsonResponse(fc));
    const code = await run(argv, cli.deps);
    assert.notEqual(code, 0, `expected non-zero exit for ${JSON.stringify(argv)}`);
    assert.equal(cli.mt.calls.length, 0, `expected no request for ${JSON.stringify(argv)}`);
  }
});

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["999999999999", false]] as const) {
    const cli = makeCli(() => jsonResponse(fc));
    const code = await run(["--max-retries", value, "latest", "--max", "1"], cli.deps);
    assert.equal(code, ok ? 0 : 1, value);
    if (!ok) {
      assert.match(cli.err.join("\n"), /Must be <= 10\./);
      assert.equal(cli.mt.calls.length, 0);
    }
  }
});

test("a WFS ExceptionReport shows its reason on stderr, exit 1", async () => {
  const cli = makeCli(() => rawResponse(LIVE_EXCEPTION_REPORT, "application/xml", 400));
  const code = await run(["--compact", "timeseries", "091811461", "--max", "2", "--sort", "bogus_prop"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.err.length, 1);
  assert.match(
    untimed(cli.err[0] ?? ""),
    /^ERROR \[strahlenschutz\.api\] HTTP 400 for GET https:\/\/www\.imis\.bfs\.de\/ogc\/opendata\/ows\?.*sortBy=bogus_prop.*: Illegal property name: bogus_prop for feature type opendata:odlinfo_odl_1h_latest$/,
  );
});

test("userinfo in --base-url is sent but redacted in error messages", async () => {
  const cli = makeCli(() => jsonResponse({ detail: "boom" }, 500));
  const code = await run(["--base-url", "http://user:s3cretpw@127.0.0.1:18133/e500", "latest", "--max", "1"], cli.deps);
  assert.equal(code, 1);
  // The userinfo travels as the Authorization header, never inside the URL (P3).
  assert.ok(cli.mt.last().url.startsWith("http://127.0.0.1:18133/e500/"));
  assert.equal(cli.mt.last().headers?.["Authorization"], `Basic ${Buffer.from("user:s3cretpw").toString("base64")}`);
  const stderr = cli.err.join("\n");
  assert.ok(!stderr.includes("s3cretpw"), stderr);
  assert.match(untimed(stderr), /^ERROR \[strahlenschutz\.api\] HTTP 500 for GET http:\/\/127\.0\.0\.1:18133\/e500\/ogc\/opendata\/ows\?.*: boom$/);
});

test("--base-url with a query, fragment or surrounding whitespace is a usage error before any request", async () => {
  for (const [base, msg] of [
    ["http://127.0.0.1:18133/echo#frag", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    ["http://127.0.0.1:18133/echo?a=1", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    [" https://www.imis.bfs.de", /A base URL cannot have surrounding whitespace\./],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fc));
    const code = await run(["--base-url", base, "latest", "--station", "123", "--max", "1"], cli.deps);
    assert.equal(code, 1, base);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), msg);
  }
  const prefixed = makeCli(() => jsonResponse(fc));
  assert.equal(await run(["--base-url", "https://mirror.example/bfs/", "latest"], prefixed.deps), 0);
  assert.equal(new URL(prefixed.mt.last().url).pathname, "/bfs/ogc/opendata/ows");
});

test("--user-agent rejects blank, control-character and non-Latin-1 values before any request", async () => {
  for (const [ua, msg] of [
    ["", /Expected a non-empty value\./],
    ["  ", /Expected a non-empty value\./],
    ["a\r\nX-Evil: 1", /Value contains control characters\./],
    ["odl \u{1F642}", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
  ] as const) {
    const cli = makeCli(() => jsonResponse(fc));
    const code = await run(["--user-agent", ua, "latest", "--max", "1"], cli.deps);
    assert.equal(code, 1, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), msg);
  }
  const cli = makeCli(() => jsonResponse(fc));
  assert.equal(await run(["--user-agent", "odl-t\u00fcv\t1", "latest", "--max", "1"], cli.deps), 0);
  assert.equal(cli.mt.last().headers?.["User-Agent"], "odl-t\u00fcv\t1");
});

test("station on a feature list of non-objects exits 1, not a found station", async () => {
  const cli = makeCli(() => jsonResponse({ type: "FeatureCollection", features: [null] }));
  const code = await run(["station", "091811461"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.out.length, 0);
  assert.match(cli.err.join("\n"), /feature 0 is null\.$/);
});

test("a StrahlValidationError raised in an action is a usage error: exit 1 and an ERROR record", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const client = new StrahlenschutzClient({ transport: makeMockTransport(() => jsonResponse(fc)).transport });
  client.latest = async () => {
    throw new StrahlValidationError("Invalid sortBy: Expected a non-empty value.");
  };
  const code = await run(["latest"], {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () => client,
  });
  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.deepEqual(err.map(untimed), ["ERROR [strahlenschutz.cli] Invalid sortBy: Expected a non-empty value."]);
});

test("a rejected --base-url whose password holds a space and DEL, C1 or bidi is redacted in jsonl too (#6)", async () => {
  for (const pw of ["top secret\u007fx", "top secret\u0085x", "top secret\u202ex"]) {
    for (const format of ["text", "jsonl"]) {
      const cli = makeCli(() => jsonResponse(fc));
      const code = await run(["--log-format", format, "--base-url", `http://alice:${pw}@127.0.0.1:1/?x=1`, "latest"], cli.deps);
      assert.equal(code, 1);
      const all = cli.err.join("\n");
      assert.match(all, /\*\*\*@127\.0\.0\.1/, `${format} ${JSON.stringify(pw)}: ${all}`);
      assert.ok(!all.includes("secret"), `${format} ${JSON.stringify(pw)}: ${all}`);
    }
  }
});

test("an a:b@c argument (a station id, a User-Agent) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const station = makeCli(() => jsonResponse(fc));
  assert.equal(await run(["station", "1:x@y"], station.deps), 1);
  assert.match(station.err.join("\n"), /Invalid station id "1:x@y"/);
  const body = { type: "FeatureCollection", features: [{ type: "Feature", properties: { kenn: "091811461", name: "contact ops:team@bfs.example" } }] };
  const ua = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--user-agent", "ops:team@bfs.example", "--compact", "latest"], ua.deps), 0);
  assert.equal(ua.mt.last().headers?.["User-Agent"], "ops:team@bfs.example");
  assert.match(ua.out.join("\n"), /"name":"contact ops:team@bfs\.example"/);
  assert.deepEqual(credentialsIn("ops:team@bfs.example"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
  // A base URL typed without its scheme is still read as one: its password is never echoed.
  const bare = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--base-url", "alice:hunter2-pw@mirror.example", "latest"], bare.deps), 1);
  assert.ok(!bare.err.join("\n").includes("hunter2-pw"), bare.err.join("\n"));
});
