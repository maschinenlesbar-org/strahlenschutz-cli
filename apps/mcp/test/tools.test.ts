// This server's tools against a mock of the ODL-Info WFS (the client's live answers of
// 2026-11-19), with the skills' traps as cases: each tool answers through the protocol (its
// structuredContent checked by the SDK against its output schema), stations without a value are
// counted and never ranked, a place several regions share is ambiguous, the trend is read newest
// first and names the station's request as its source, broken coordinates never reach the map,
// the daily series is Flensburg's only, and every result carries the source and the dl-de/by-2-0
// attribution. The rules every server follows are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { SIZE_HINT, TOOLS } from "../src/mcp/tools.js";
import { limitTransport } from "../src/mcp/limiter.js";
import { connect } from "./harness.js";
import { makeMockTransport, odlAnswer, odlApi, stationRow } from "./helpers.js";
import { StrahlNetworkError } from "@maschinenlesbar.org/strahlenschutz-client";

const OWS = "https://www.imis.bfs.de/ogc/opendata/ows";
const LATEST = `${OWS}?service=WFS&request=GetFeature&typeName=opendata%3Aodlinfo_odl_1h_latest&outputFormat=application%2Fjson&sortBy=kenn`;

test("five tools: the three use cases, then the station search and the raw series", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["getDoseSnapshot", "getStationTrend", "getStationsMap", "findStations", "getTimeseries"]);
});

test("getDoseSnapshot: the verdict, the skipped stations counted, the ranking made here; the source and the attribution", async () => {
  const connection = await connect({ transport: odlApi() });
  const result = await connection.call("getDoseSnapshot", { limit: 3 });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.equal(content["verdict"], "normal");
  assert.deepEqual(content["skipped"], { total: 3, byStatus: { defekt: 2, Testbetrieb: 1 } });
  assert.deepEqual((content["ranking"] as { kenn: string }[]).map((s) => s.kenn), ["083370490", "082370020", "092721221"]);
  assert.equal(content["mainHour"], "2026-11-19T19:00:00Z");
  assert.equal(content["source"], LATEST);
  assert.match(String(content["licence"]), /^Datenquelle: Bundesamt für Strahlenschutz \(BfS\), ODL-Info — Datenlizenz Deutschland – Namensnennung – Version 2\.0 \(dl-de\/by-2-0\), https:\/\/www\.govdata\.de\/dl-de\/by-2-0/);
  await connection.close();
});

test("getDoseSnapshot: a place in several regions is ambiguous with candidates; two kinds of area are a tool error before any request", async () => {
  const transport = odlApi();
  const connection = await connect({ transport });
  const bergen = (await connection.call("getDoseSnapshot", { place: "Bergen" })).structuredContent ?? {};
  assert.equal(bergen["status"], "ambiguous");
  assert.equal((bergen["candidates"] as unknown[]).length, 2);
  const before = transport.calls.length;
  const both = await connection.call("getDoseSnapshot", { state: "Bayern", place: "München" });
  assert.equal(both.isError, true);
  assert.match(both.content[0]?.text ?? "", /give one of state, place, lat\/lon or bbox/);
  assert.equal(transport.calls.length, before);
  await connection.close();
});

test("getStationTrend: a name resolves to its station, read newest first; the source is that station's series request", async () => {
  const connection = await connect({ transport: odlApi() });
  const result = await connection.call("getStationTrend", { station: "Herrischried", hours: 24 });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.deepEqual(content["latest"], { value: 0.239, hourEnding: "2026-11-19T19:00:00Z", validated: true });
  assert.equal(content["verdict"], "steady");
  assert.equal(content["source"], `${OWS}?service=WFS&request=GetFeature&typeName=opendata%3Aodlinfo_timeseries_odl_1h&outputFormat=application%2Fjson&CQL_FILTER=kenn%3D%27083370490%27&sortBy=end_measure%20D&count=30`, "24 hours and 24 before the newest 6, for the baseline");
  const unknown = (await connection.call("getStationTrend", { station: "099999999" })).structuredContent ?? {};
  assert.equal(unknown["status"], "empty");
  assert.match(String(unknown["reason"]), /No station with kenn 099999999/);
  const several = (await connection.call("getStationTrend", { station: "Bergen" })).structuredContent ?? {};
  assert.equal(several["status"], "ambiguous");
  await connection.close();
});

test("getStationsMap: a page of points with nextOffset; with the dead sensors the broken coordinates are left off and named", async () => {
  const connection = await connect({ transport: odlApi() });
  const page = (await connection.call("getStationsMap", { limit: 10 })).structuredContent ?? {};
  assert.equal(page["status"], "ok");
  assert.equal(page["type"], "FeatureCollection");
  assert.equal((page["features"] as unknown[]).length, 10);
  assert.deepEqual([page["total"], page["nextOffset"]], [21, 10]);
  const coverage = (await connection.call("getStationsMap", { includeDead: true, offset: 20 })).structuredContent ?? {};
  assert.deepEqual((coverage["leftOff"] as { kenn: string }[]).map((s) => s.kenn), ["130711451"]);
  assert.equal(coverage["source"], LATEST);
  await connection.close();
});

test("findStations: the nearest to a point, with distances", async () => {
  const connection = await connect({ transport: odlApi() });
  const content = (await connection.call("findStations", { lat: 52.52, lon: 13.4, limit: 1 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.deepEqual((content["stations"] as { name: string; distanceKm: number }[]).map((s) => s.name), ["Berlin-Buch"]);
  assert.equal(content["nextOffset"], 1);
  await connection.close();
});

test("getTimeseries: Flensburg's daily series; another station's daily series is empty and says why; a name is no kenn", async () => {
  const connection = await connect({ transport: odlApi() });
  const daily = (await connection.call("getTimeseries", { station: "010010001", resolution: "daily", limit: 2 })).structuredContent ?? {};
  assert.equal(daily["status"], "ok");
  assert.deepEqual((daily["points"] as { value: number }[]).map((p) => p.value), [0.098, 0.099]);
  assert.equal(daily["nextOffset"], 2);
  assert.equal(daily["source"], `${OWS}?service=WFS&request=GetFeature&typeName=opendata%3Aodlinfo_timeseries_odl_24h&outputFormat=application%2Fjson&CQL_FILTER=kenn%3D%27010010001%27&sortBy=end_measure%20D&count=2`);
  const other = (await connection.call("getTimeseries", { station: "083370490", resolution: "daily" })).structuredContent ?? {};
  assert.match(String(other["reason"]), /Flensburg \(010010001\) only/);
  const name = await connection.call("getTimeseries", { station: "Herrischried" });
  assert.equal(name.isError, true);
  await connection.close();
});

test("the BfS service down or slow (a 502 or 504, a request timeout) is a tool error that says to try again shortly", async () => {
  // A 502 and a timeout are not retried, so no test waits for a backoff; a 503 ends the same way after its retries.
  const down = await connect({ transport: makeMockTransport(() => ({ status: 502, headers: { "content-type": "text/html" }, body: Buffer.from("<html>bad gateway</html>") })) });
  const busy = await down.call("findStations", { query: "Flensburg" });
  assert.equal(busy.isError, true);
  assert.match(busy.content[0]?.text ?? "", /HTTP 502/);
  assert.match(busy.content[0]?.text ?? "", /try again shortly/);
  await down.close();
  const slow = await connect({ transport: makeMockTransport(() => { throw new StrahlNetworkError("Request timed out after 2000ms"); }) });
  const late = await slow.call("getDoseSnapshot", {});
  assert.equal(late.isError, true);
  assert.match(late.content[0]?.text ?? "", /timed out after 2000ms.*try again shortly/);
  await slow.close();
  const asked = await connect({ transport: makeMockTransport(() => ({ status: 503, headers: { "content-type": "text/plain", "retry-after": "120" }, body: Buffer.from("busy") })) });
  const wait = await asked.call("findStations", { query: "Flensburg" });
  assert.match(wait.content[0]?.text ?? "", /asked to wait 120 s/);
  assert.doesNotMatch(wait.content[0]?.text ?? "", /try again shortly/, "a wait the server asked for is not contradicted");
  await asked.close();
  const wrong = await connect({ transport: makeMockTransport(() => ({ status: 400, headers: { "content-type": "text/plain" }, body: Buffer.from("bad request") })) });
  const refused = await wrong.call("findStations", { query: "Flensburg" });
  assert.doesNotMatch(refused.content[0]?.text ?? "", /try again/, "a 400 is no outage");
  await wrong.close();
});

test("the deadline's and the size cap's advice fit every tool: each option named with the tools that take it", async () => {
  const hanging = { transport: (): Promise<never> => new Promise<never>(() => {}) };
  const connection = await connect({ transport: hanging, config: { callTimeoutMs: 30 } });
  const deadline = (await connection.call("findStations", {})).content[0]?.text ?? "";
  await connection.close();
  assert.match(deadline, /took longer than .* and was stopped/);
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  for (const text of [deadline, SIZE_HINT]) {
    const pairs = [...text.matchAll(/(\w+(?: or \w+)*) \((\w+(?:, \w+)*)\)/g)];
    assert.ok(pairs.length >= 2, text);
    for (const [, options, tools] of pairs) {
      for (const tool of (tools as string).split(", ")) {
        assert.ok(schemas.has(tool), `no tool ${tool}: ${text}`);
        for (const option of (options as string).split(" or ")) assert.ok(schemas.get(tool)?.includes(option), `${tool} takes no ${option}: ${text}`);
      }
    }
    const named = new Set(pairs.flatMap(([, options]) => (options as string).split(" or ")));
    for (const option of new Set([...schemas.values()].flat())) {
      assert.ok(!new RegExp(`\\b${option}\\b`).test(text) || named.has(option), `${option} named without its tools: ${text}`);
    }
    for (const tool of ["getDoseSnapshot", "getStationsMap", "findStations"]) assert.match(text, new RegExp(tool), "the network tools, which read the whole network whatever is asked, are named");
  }
});

test("getStationsMap: a page the size cap cut never claims the features it lost in its notes", async () => {
  const many = Array.from({ length: 80 }, (_, i) => stationRow("064380031", { kenn: `0643800${String(i).padStart(2, "0")}` }));
  const connection = await connect({ transport: odlApi(many), config: { maxResultChars: 8000 } });
  const page = (await connection.call("getStationsMap", { limit: 80 })).structuredContent ?? {};
  await connection.close();
  const kept = (page["features"] as unknown[]).length;
  assert.ok(kept < 80, `the cap cut the page (${kept})`);
  assert.equal(page["truncated"], true);
  assert.equal(page["nextOffset"], kept);
  const notes = (page["notes"] as string[]).join(" ");
  assert.doesNotMatch(notes, /1–80/);
  assert.match(notes, /80 features in all.*nextOffset/);
});

test("getStationTrend fits a small size cap: a short window answers whole, a long one with its days cut, its notes kept", async () => {
  // A 1-hour trend was 1936 characters whole, a size error at every cap below that.
  const connection = await connect({ transport: odlApi(), config: { maxResultChars: 1700 } });
  const short = await connection.call("getStationTrend", { station: "083370490", hours: 1 });
  assert.notEqual(short.isError, true, short.content[0]?.text);
  const one = short.structuredContent ?? {};
  assert.equal(one["status"], "ok");
  assert.equal(one["days"], undefined, "a window under a day has no day means: they would repeat min, max and mean");
  assert.match((one["notes"] as string[]).join(" "), /own flat level/);
  await connection.close();
  const wider = await connect({ transport: odlApi(), config: { maxResultChars: 2100 } });
  const long = await wider.call("getStationTrend", { station: "083370490", hours: 168 });
  assert.notEqual(long.isError, true, long.content[0]?.text);
  const week = long.structuredContent ?? {};
  assert.equal(week["truncated"], true);
  assert.ok((week["days"] as unknown[]).length >= 1);
  assert.match((week["notes"] as string[]).join(" "), /own flat level/);
  assert.match(String(week["reason"]), /days lost entries/);
  await wider.close();
});

test("a verdict from an answer another host gave after a redirect says so first, as unconfirmed", async () => {
  const MIRROR = "https://mirror.example";
  const redirected = makeMockTransport((request) => {
    const url = new URL(request.url);
    if (url.origin !== MIRROR) return { status: 302, headers: { location: `${MIRROR}${url.pathname}${url.search}` }, body: Buffer.alloc(0) };
    return odlAnswer(request);
  });
  // The server's transport is the limited one (run.ts): it notes which origin answered.
  const connection = await connect({ transport: { transport: limitTransport(redirected.transport) } });
  for (const [tool, args] of [["getDoseSnapshot", {}], ["getStationTrend", { station: "083370490" }]] as const) {
    const content = (await connection.call(tool, args)).structuredContent ?? {};
    assert.equal(content["status"], "ok", tool);
    assert.match(String(content["verdictText"]), /^Unconfirmed: this answer came from https:\/\/mirror\.example after a redirect, not from the BfS's own address/, tool);
    assert.match(String(content["source"]), /answered by https:\/\/mirror\.example after a redirect/);
  }
  await connection.close();
  const direct = await connect({ transport: odlApi() });
  const plain = (await direct.call("getDoseSnapshot", {})).structuredContent ?? {};
  assert.doesNotMatch(String(plain["verdictText"]), /Unconfirmed/);
  await direct.close();
});
