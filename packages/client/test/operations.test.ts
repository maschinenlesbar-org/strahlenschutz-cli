// The use cases (operations.ts) against a mock of the ODL-Info WFS with live answers of 2026-11-19
// (fixtures.ts), with the skills' traps as cases: stations without a value are counted and never
// ranked (the server's sort puts their nulls first), `latest` is not one common hour, a reading is
// judged against the usual background, broken coordinates never reach a map, the hourly series is
// read newest first and judged against the station's own baseline, an empty series is told apart
// (unknown id, a dead station, the daily series that only Flensburg has), and a name several
// stations or regions fit is ambiguous.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StrahlenschutzClient } from "../src/client.js";
import { StrahlParseError, StrahlValidationError } from "../src/errors.js";
import { findStations, fold, getDoseSnapshot, getStationsMap, getStationTrend, getTimeseries, landOf, resolveLand } from "../src/operations.js";
import { hourly, odlAnswer, odlApi, SERIES, STATIONS, stationRow } from "./fixtures.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";

const clientOf = (mock: ReturnType<typeof odlApi>) => new StrahlenschutzClient({ transport: mock.transport });
const params = (mock: ReturnType<typeof odlApi>, i = 0) => new URL(mock.calls[i]?.url ?? "http://x").searchParams;

// --- shared ------------------------------------------------------------------------------------

test("a kenn's first two digits are its Land; Länder resolve by name, English name, abbreviation, NRW or code", () => {
  assert.equal(landOf("083370490"), "Baden-Württemberg");
  assert.equal(landOf("010020003"), "Schleswig-Holstein", "the offshore platforms are filed under SH");
  for (const name of ["Bayern", "bavaria", "BY", "09", " bayern "]) assert.equal(resolveLand(name)[0], "09", name);
  assert.equal(resolveLand("NRW")[2], "Nordrhein-Westfalen");
  assert.equal(resolveLand("Thueringen")[2], "Thüringen");
  assert.throws(() => resolveLand("Tirol"), StrahlValidationError);
});

test("names fold case, accents and ae/oe/ue", () => {
  assert.equal(fold("MÜNCHEN"), fold("Muenchen"));
  assert.equal(fold("Großherrischwand"), "grossherrischwand");
});

// --- getDoseSnapshot ---------------------------------------------------------------------------

test("snapshot: stations without a value are counted by status and never ranked; the ranking is made here, not by the server's sort", async () => {
  const mock = odlApi();
  const snap = await getDoseSnapshot(clientOf(mock));
  assert.equal(snap.status, "ok");
  if (snap.status !== "ok") return;
  assert.equal(mock.calls.length, 1);
  assert.equal(params(mock).get("sortBy"), "kenn", "no value sort: the WFS puts nulls first");
  assert.equal(snap.stationCount, STATIONS.length);
  assert.deepEqual(snap.skipped, { total: 3, byStatus: { defekt: 2, Testbetrieb: 1 } });
  assert.equal(snap.reporting, STATIONS.length - 3);
  assert.deepEqual(snap.ranking.slice(0, 3).map((s) => [s.rank, s.kenn, s.value]), [[1, "083370490", 0.239], [2, "082370020", 0.202], [3, "092721221", 0.201]]);
  assert.ok(snap.ranking.every((s) => typeof s.value === "number"));
  assert.match(snap.notes.join(" "), /3 stations have no value \(2 defekt, 1 Testbetrieb\) and are not ranked: say so/);
});

test("snapshot: the verdict is normal at background; a reading above 0.3 µSv/h is named as notable, with what to check", async () => {
  const snap = await getDoseSnapshot(clientOf(odlApi()));
  assert.equal(snap.status === "ok" && snap.verdict, "normal");
  assert.match(snap.status === "ok" ? snap.verdictText : "", /^All 21 readings are at normal background \(max 0\.239 µSv\/h at Herrischried OT Großherrischwand, 083370490\)\. Nothing elevated\.$/);
  const high = await getDoseSnapshot(clientOf(odlApi([...STATIONS, stationRow("064380031", { kenn: "064380099", name: "Teststadt", value: 0.45 })])));
  assert.equal(high.status, "ok");
  if (high.status !== "ok") return;
  assert.equal(high.verdict, "notable");
  assert.deepEqual(high.notable.map((s) => [s.name, s.value]), [["Teststadt", 0.45]]);
  assert.match(high.verdictText, /Teststadt 0\.45.*getStationTrend.*rain/);
});

test("snapshot: latest is not one common hour: the main hour, the older readings counted and marked", async () => {
  const snap = await getDoseSnapshot(clientOf(odlApi()), { order: "lowest", limit: 25 });
  assert.equal(snap.status, "ok");
  if (snap.status !== "ok") return;
  assert.equal(snap.mainHour, "2026-11-19T19:00:00Z");
  assert.equal(snap.olderReadings, 2);
  assert.deepEqual(snap.hours, [{ hourEnding: "2026-11-19T19:00:00Z", stations: 19 }, { hourEnding: "2026-11-19T18:00:00Z", stations: 1 }, { hourEnding: "2026-11-19T05:00:00Z", stations: 1 }]);
  assert.equal(snap.ranking.find((s) => s.kenn === "031550121")?.olderReading, true, "Uslar's reading is from 05:00");
  assert.match(snap.notes.join(" "), /back to 2026-11-19T05:00:00Z, Uslar OT Schoningen/);
  assert.deepEqual(snap.ranking.slice(0, 3).map((s) => [s.name, s.rank]), [["FINO 3 - Forschungsplattform", 21], ["FINO 1 - Forschungsplattform", 20], ["FINO 2 - Forschungsplattform", 19]], "lowest first keeps the rank from the top");
  assert.equal(snap.notValidated, 1, "Usedom is not marked validated");
  assert.equal(snap.ranking.find((s) => s.kenn === "130590972")?.validated, false);
});

test("snapshot: a Land by name or abbreviation narrows by the kenn's Land code", async () => {
  const snap = await getDoseSnapshot(clientOf(odlApi()), { state: "BY" });
  assert.equal(snap.status, "ok");
  if (snap.status !== "ok") return;
  assert.equal(snap.area, "in Bayern");
  assert.match(snap.verdictText, /^All 8 readings in Bayern are at normal background/);
  assert.ok(snap.ranking.every((s) => s.kenn.startsWith("09")));
  assert.equal(snap.stationCount, 8);
});

test("snapshot: a place is a circle around the stations named after it; Waldmünchen is not München", async () => {
  const snap = await getDoseSnapshot(clientOf(odlApi()), { place: "muenchen", radiusKm: 30, limit: 20 });
  assert.equal(snap.status, "ok");
  if (snap.status !== "ok") return;
  assert.deepEqual(snap.ranking.map((s) => s.kenn).sort(), ["091620001", "091620002", "091620003", "091620004", "091841192"]);
  assert.ok(snap.ranking.every((s) => typeof s.distanceKm === "number" && s.distanceKm < 30));
  assert.deepEqual(snap.searched, { place: "muenchen", radiusKm: 30, order: "highest" });
  assert.match(snap.notes[0] ?? "", /30 km around the stations named München-Neuhausen/);
});

test("snapshot: a place several regions share is ambiguous; an unknown place is empty and says what to give", async () => {
  const bergen = await getDoseSnapshot(clientOf(odlApi()), { place: "Bergen" });
  assert.equal(bergen.status, "ambiguous");
  assert.deepEqual(bergen.status === "ambiguous" ? bergen.candidates.map((c) => [c.kenn, c.land]) : [], [["033510041", "Niedersachsen"], ["097711121", "Bayern"]]);
  const none = await getDoseSnapshot(clientOf(odlApi()), { place: "Atlantis" });
  assert.equal(none.status, "empty");
  assert.match(none.status === "empty" ? none.reason : "", /No station's name starts with "Atlantis".*lat and lon/);
});

test("snapshot: a point with a radius and a bbox; a station with broken coordinates is named, never placed", async () => {
  const live = stationRow("130711451", { site_status: 1, site_status_text: "in Betrieb", value: 0.1, end_measure: "2026-11-19T19:00:00Z", validated: 1 });
  const stations = [...STATIONS.filter(([, p]) => p["kenn"] !== "130711451"), live];
  const near = await getDoseSnapshot(clientOf(odlApi(stations)), { lat: 52.52, lon: 13.4, radiusKm: 50 });
  assert.equal(near.status, "ok");
  if (near.status !== "ok") return;
  assert.deepEqual(near.ranking.map((s) => s.name), ["Berlin-Buch"]);
  assert.match(near.notes.join(" "), /1 station has no usable coordinates.*Trollenhagen, 130711451/);
  const box = await getDoseSnapshot(clientOf(odlApi()), { bbox: [5.5, 47, 9, 49] });
  assert.equal(box.status === "ok" && box.ranking.map((s) => s.kenn).join(), "083370490,082370020");
});

test("snapshot: wrong inputs are refused before any request", async () => {
  const mock = odlApi();
  for (const input of [{ state: "BY", place: "München" }, { lat: 52 }, { radiusKm: 10 }, { place: "x", radiusKm: 500 }, { bbox: [10, 50, 9, 49] }, { limit: 0 }, { order: "top" as never }, { place: " " }, { state: "Tirol" }]) {
    await assert.rejects(getDoseSnapshot(clientOf(mock), input), StrahlValidationError, JSON.stringify(input));
  }
  assert.equal(mock.calls.length, 0);
});

// --- getStationsMap ----------------------------------------------------------------------------

test("map: [lon, lat] points with the value promoted and a popup; dead sensors dropped and counted; broken coordinates left off and named", async () => {
  const map = await getStationsMap(clientOf(odlApi()));
  assert.equal(map.status, "ok");
  if (map.status !== "ok") return;
  assert.equal(map.total, 21);
  assert.deepEqual(map.withoutValue, { count: 3, kept: false });
  assert.deepEqual(map.leftOff, [], "Trollenhagen is defekt: dropped with the dead sensors");
  const flensburg = map.features.find((f) => f.id === "010010001");
  assert.deepEqual(flensburg?.geometry.coordinates, [9.38, 54.78], "never flipped");
  assert.equal(flensburg?.properties.popup, "Flensburg: 0.092 µSv/h");
  assert.deepEqual(map.valueRange, { min: 0.05, max: 0.239 });
  assert.match(map.notes.join(" "), /3 stations without a value \(defekt, Testbetrieb\) are dropped/);
  const coverage = await getStationsMap(clientOf(odlApi()), { includeDead: true });
  assert.equal(coverage.status, "ok");
  if (coverage.status !== "ok") return;
  assert.equal(coverage.total, 23);
  assert.deepEqual(coverage.leftOff, [{ kenn: "130711451", name: "Trollenhagen", status: "defekt", coordinates: [589.28, 3007.11] }]);
  assert.equal(coverage.features.find((f) => f.id === "010020001")?.properties.value, null);
});

test("map: paged with nextOffset; a Land narrows it", async () => {
  const first = await getStationsMap(clientOf(odlApi()), { limit: 5 });
  assert.equal(first.status === "ok" && first.features.length, 5);
  assert.equal(first.status === "ok" && first.nextOffset, 5);
  const last = await getStationsMap(clientOf(odlApi()), { offset: 20, limit: 5 });
  assert.equal(last.status === "ok" && last.features.length, 1);
  assert.equal(last.status === "ok" && last.nextOffset, undefined);
  const many = Array.from({ length: 80 }, (_, i) => stationRow("064380031", { kenn: `0643800${String(i).padStart(2, "0")}` }));
  const page = await getStationsMap(clientOf(odlApi(many)));
  assert.deepEqual(page.status === "ok" ? [page.features.length, page.nextOffset] : [], [60, 60], "the default page fits one tool result");
  const sh = await getStationsMap(clientOf(odlApi()), { state: "Schleswig-Holstein" });
  assert.equal(sh.status === "ok" && sh.features.map((f) => f.id).join(), "010010001,010020002,010020003,010020004");
});

// --- getStationTrend ---------------------------------------------------------------------------

test("trend: read newest first (the series comes oldest first), summarised, steady at the station's own high level", async () => {
  const mock = odlApi();
  const trend = await getStationTrend(clientOf(mock), { station: "083370490", hours: 48, points: true });
  assert.equal(trend.status, "ok");
  if (trend.status !== "ok") return;
  assert.equal(params(mock, 1).get("sortBy"), "end_measure D");
  assert.equal(params(mock, 1).get("count"), "48");
  assert.deepEqual(trend.latest, { value: 0.239, hourEnding: "2026-11-19T19:00:00Z", validated: true });
  assert.equal(trend.window.values, 48);
  assert.equal(trend.window.from, "2026-11-17T19:00:00Z");
  assert.equal(trend.verdict, "steady");
  assert.equal(trend.aboveBackground, false);
  assert.ok(trend.baseline > 0.2 && trend.baseline < 0.24);
  assert.equal(trend.points?.[0]?.hourEnding, "2026-11-17T20:00:00Z", "points oldest first, for a chart");
  assert.deepEqual(trend.days.map((d) => [d.day, d.hours]), [["2026-11-17", 5], ["2026-11-18", 24], ["2026-11-19", 19]]);
  assert.match(trend.notes.join(" "), /own flat level/);
});

test("trend: a name resolves to its kenn; a name two stations carry is ambiguous; an unknown kenn and a dead station are told apart", async () => {
  const mock = odlApi();
  const byName = await getStationTrend(clientOf(mock), { station: "Herrischried" });
  assert.equal(byName.status === "ok" && byName.station.kenn, "083370490");
  assert.equal(params(mock, 1).get("CQL_FILTER"), "kenn='083370490'");
  const bergen = await getStationTrend(clientOf(odlApi()), { station: "bergen" });
  assert.equal(bergen.status, "ambiguous");
  assert.equal(bergen.status === "ambiguous" && bergen.total, 2);
  const unknown = await getStationTrend(clientOf(odlApi()), { station: "099999999" });
  assert.equal(unknown.status, "empty");
  assert.match(unknown.status === "empty" ? unknown.reason : "", /No station with kenn 099999999 in the BfS network/);
  const dead = await getStationTrend(clientOf(odlApi()), { station: "010020001" });
  assert.match(dead.status === "empty" ? dead.reason : "", /^Leuchtturm Kiel \(010020001, defekt\) has no hourly readings in the last week: the station is defekt/);
  const short = await getStationTrend(clientOf(odlApi()), { station: "12345" });
  assert.match(short.status === "empty" ? short.reason : "", /a kenn has 9 digits/);
});

test("trend: a sustained rise is rising, one bump a spike (with its validation), a few hundredths noise", async () => {
  const base = Array.from({ length: 42 }, (_, i) => [0.1, 0.102, 0.098][i % 3] as number);
  const run = async (values: number[], validated?: (i: number) => number) => {
    const t = await getStationTrend(clientOf(odlApi(STATIONS, { ...SERIES, "064380031": { hourly: hourly(values, undefined, validated) } })), { station: "064380031" });
    assert.equal(t.status, "ok");
    return t.status === "ok" ? t : undefined;
  };
  assert.equal((await run([...base, 0.14, 0.15, 0.15, 0.16, 0.15, 0.15]))?.verdict, "rising");
  const spike = await run([...base, 0.1, 0.17, 0.11, 0.1, 0.1, 0.1], (i) => (i === 43 ? 2 : 1));
  assert.equal(spike?.verdict, "spike");
  assert.match(spike?.verdictText ?? "", /short spike to 0\.17 µSv\/h \(hour ending 2026-11-19T15:00:00Z, not validated\)/);
  assert.match(spike?.notes.join(" ") ?? "", /1 hour is not marked validated, the highest among them/);
  assert.equal((await run([...base, 0.11, 0.12, 0.11, 0.12, 0.11, 0.11]))?.verdict, "steady");
  const gap = await run([...base.slice(0, 40), null as unknown as number, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
  assert.equal(gap?.window.gaps, 1);
  assert.equal(gap?.window.values, 47);
});

test("trend: wrong inputs are refused before any request", async () => {
  const mock = odlApi();
  for (const input of [{ station: "" }, { station: "083370490", hours: 0 }, { station: "083370490", hours: 169 }]) {
    await assert.rejects(getStationTrend(clientOf(mock), input), StrahlValidationError, JSON.stringify(input));
  }
  assert.equal(mock.calls.length, 0);
});

// --- findStations ------------------------------------------------------------------------------

test("findStations: a name's words, a postal code, a kenn, a Land, a status, or the nearest to a point", async () => {
  const client = clientOf(odlApi());
  const munich = await findStations(client, { query: "München" });
  assert.deepEqual(munich.status === "ok" ? munich.stations.map((s) => s.name) : [], ["Garching b. München", "München-Neuhausen", "München-Neuperlach", "München-Obersendling", "München-Pasing"]);
  const part = await findStations(client, { query: "chen OT" });
  assert.equal(part.status === "ok" && part.stations[0]?.name, "Waldmünchen OT Hocha", "any part of a name when no word starts with it");
  const plz = await findStations(client, { query: "81" });
  assert.equal(plz.status === "ok" && plz.total, 3);
  const kenn = await findStations(client, { query: "083370490" });
  assert.equal(kenn.status === "ok" && kenn.stations[0]?.valueTerrestrial, 0.185);
  const dead = await findStations(client, { status: "defekt" });
  assert.equal(dead.status === "ok" && dead.total, 2);
  const near = await findStations(client, { lat: 48.14, lon: 11.58, limit: 2 });
  assert.equal(near.status, "ok");
  if (near.status !== "ok") return;
  assert.deepEqual(near.stations.map((s) => s.kenn), ["091620001", "091620004"]);
  assert.ok((near.stations[0]?.distanceKm ?? 99) < 5);
  assert.equal(near.nextOffset, 2);
  const none = await findStations(client, { query: "Atlantis", state: "BY" });
  assert.equal(none.status, "empty");
  assert.match(none.status === "empty" ? none.reason : "", /query "Atlantis", state "Bayern"/);
  await assert.rejects(findStations(client, { status: "kaputt" }), StrahlValidationError);
});

// --- getTimeseries -----------------------------------------------------------------------------

test("getTimeseries: Flensburg's daily series newest first and paged; any other station's daily series is empty and says why", async () => {
  const mock = odlApi();
  const daily = await getTimeseries(clientOf(mock), { station: "010010001", resolution: "daily", limit: 3 });
  assert.equal(daily.status, "ok");
  if (daily.status !== "ok") return;
  assert.equal(params(mock).get("typeName"), "opendata:odlinfo_timeseries_odl_24h");
  assert.deepEqual(daily.points.map((p) => [p.end, p.value]), [["2026-11-19T00:00:00Z", 0.098], ["2026-11-18T00:00:00Z", 0.099], ["2026-11-17T00:00:00Z", 0.098]]);
  assert.equal(daily.total, 40);
  assert.equal(daily.nextOffset, 3);
  const other = await getTimeseries(clientOf(odlApi()), { station: "083370490", resolution: "daily" });
  assert.match(other.status === "empty" ? other.reason : "", /Flensburg \(010010001\) only/);
  const oldest = await getTimeseries(clientOf(odlApi()), { station: "083370490", order: "oldest", limit: 1 });
  assert.equal(oldest.status === "ok" && oldest.points[0]?.end, "2026-11-12T21:00:00Z");
  const past = await getTimeseries(clientOf(odlApi()), { station: "083370490", offset: 500 });
  assert.match(past.status === "empty" ? past.reason : "", /167 values; offset 500 is past its end/);
  await assert.rejects(getTimeseries(clientOf(odlApi()), { station: "Herrischried" }), StrahlValidationError);
});

test("map and findStations: an offset past the end is empty and says so, as for a series", async () => {
  const map = await getStationsMap(clientOf(odlApi()), { offset: 5000 });
  assert.equal(map.status, "empty");
  assert.match(map.status === "empty" ? map.reason : "", /21 features; offset 5000 is past its end \(offsets 0–20\)/);
  const found = await findStations(clientOf(odlApi()), { offset: 99999 });
  assert.equal(found.status, "empty");
  assert.match(found.status === "empty" ? found.reason : "", /24 stations match; offset 99999 is past the end \(offsets 0–23\)/);
  const last = await getStationsMap(clientOf(odlApi()), { offset: 20 });
  assert.equal(last.status === "ok" && last.features.length, 1, "the last entry's offset is still a page");
});

test("getTimeseries: a totalFeatures that is no count is replaced by numberMatched; without either, a full page has a nextOffset", async () => {
  const rewritten = (change: (body: Record<string, unknown>) => void) =>
    new StrahlenschutzClient({
      transport: makeMockTransport((request) => {
        const body = JSON.parse(odlAnswer(request).body.toString("utf8")) as Record<string, unknown>;
        change(body);
        return jsonResponse(body);
      }).transport,
    });
  const unknown = await getTimeseries(rewritten((b) => (b["totalFeatures"] = "unknown")), { station: "083370490", limit: 5 });
  assert.deepEqual(unknown.status === "ok" ? [unknown.total, unknown.nextOffset] : [], [167, 5]);
  const neither = await getTimeseries(rewritten((b) => { delete b["totalFeatures"]; delete b["numberMatched"]; }), { station: "083370490", limit: 5 });
  assert.equal(neither.status, "ok");
  if (neither.status !== "ok") return;
  assert.equal(neither.total, undefined, "no count is claimed");
  assert.equal(neither.nextOffset, 5, "a full page may have more after it");
  assert.match(neither.notes.join(" "), /did not say how many values the series has/);
  const short = await getTimeseries(rewritten((b) => { delete b["totalFeatures"]; delete b["numberMatched"]; }), { station: "083370490", offset: 165, limit: 5 });
  assert.equal(short.status === "ok" && short.nextOffset, undefined, "a short page is the last");
  const fewer = await getTimeseries(rewritten((b) => (b["totalFeatures"] = 3)), { station: "083370490", limit: 5 });
  assert.equal(fewer.status === "ok" && fewer.total, 167, "a count below what came back is not believed: numberMatched");
});

test("trend: a station given by kenn carries its own status, name and postal code from the network, like one given by name", async () => {
  const series = { ...SERIES, "010020001": { hourly: hourly(Array.from({ length: 48 }, () => 0.1)) } };
  const mock = odlApi(STATIONS, series);
  const byKenn = await getStationTrend(clientOf(mock), { station: "010020001" });
  assert.equal(byKenn.status, "ok");
  if (byKenn.status !== "ok") return;
  assert.deepEqual(byKenn.station, { kenn: "010020001", name: "Leuchtturm Kiel", plz: "24159", land: "Schleswig-Holstein", status: "defekt" });
  assert.equal(params(mock, 0).get("CQL_FILTER"), "kenn='010020001'");
  assert.equal(params(mock, 0).get("typeName"), "opendata:odlinfo_odl_1h_latest", "the station first, then its series");
  assert.equal(mock.calls.length, 2);
  const byName = await getStationTrend(clientOf(odlApi(STATIONS, series)), { station: "Leuchtturm Kiel" });
  assert.deepEqual(byName.status === "ok" && byName.station, byKenn.station);
  const unknown = odlApi();
  await getStationTrend(clientOf(unknown), { station: "099999999" });
  assert.equal(unknown.calls.length, 1, "an unknown kenn needs no series request");
});

test("trend: a series that stopped days before the BfS's answer says so, in the verdict and a note", async () => {
  const series = { ...SERIES, "064380031": { hourly: hourly(Array.from({ length: 48 }, () => 0.11), "2026-11-15T19:00:00Z") } };
  const stale = await getStationTrend(clientOf(odlApi(STATIONS, series)), { station: "064380031" });
  assert.equal(stale.status, "ok");
  if (stale.status !== "ok") return;
  assert.match(stale.verdictText, /^As of the hour ending 2026-11-15T19:00:00Z, 4 days before the BfS's answer \(2026-11-19T19:15:00\.000Z\): the station has not reported since\. Steady/);
  assert.match(stale.notes.join(" "), /newest reading is for the hour ending 2026-11-15T19:00:00Z, 4 days before/);
  const current = await getStationTrend(clientOf(odlApi()), { station: "083370490" });
  assert.doesNotMatch(current.status === "ok" ? `${current.verdictText} ${current.notes.join(" ")}` : "", /not reported since/);
});

test("trend: a short window is judged against the hours before it, read for the baseline, never against itself", async () => {
  const run = async (values: number[], hours: number) => {
    const mock = odlApi(STATIONS, { ...SERIES, "064380031": { hourly: hourly(values) } });
    const t = await getStationTrend(clientOf(mock), { station: "064380031", hours });
    assert.equal(t.status, "ok");
    return { t: t.status === "ok" ? t : undefined, count: params(mock, 1).get("count") };
  };
  const jump = [...Array.from({ length: 45 }, () => 0.1), 0.5, 0.5, 0.5];
  const three = await run(jump, 3);
  assert.equal(three.t?.verdict, "rising", three.t?.verdictText);
  assert.equal(three.t?.baseline, 0.1);
  assert.equal(three.count, "27", "3 hours and 24 before them");
  assert.deepEqual([three.t?.window.hours, three.t?.window.values, three.t?.min.value], [3, 3, 0.5], "the window is still the 3 hours asked");
  assert.match(three.t?.notes.join(" ") ?? "", /compares the newest 3 hours with the station's median over the 24 hours before them/);
  const six = await run(jump, 6);
  assert.equal(six.t?.verdict, "rising", six.t?.verdictText);
  const step = [...Array.from({ length: 42 }, () => 0.1), ...Array.from({ length: 6 }, () => 0.2)];
  for (const hours of [6, 11, 12]) assert.equal((await run(step, hours)).t?.verdict, "rising", `hours ${hours}`);
  assert.equal((await run(step, 48)).count, "48", "a long window reads only itself");
});

test("trend: a spike in the newest hour is still on, never called back down; one that is over says the latest value", async () => {
  const run = async (values: number[], validated?: (i: number) => number) => {
    const t = await getStationTrend(clientOf(odlApi(STATIONS, { ...SERIES, "064380031": { hourly: hourly(values, undefined, validated) } })), { station: "064380031" });
    return t.status === "ok" ? t : undefined;
  };
  const now = await run([...Array.from({ length: 47 }, () => 0.1), 0.18]);
  assert.equal(now?.verdict, "spike");
  assert.doesNotMatch(now?.verdictText ?? "", /back to|benign/);
  assert.match(now?.verdictText ?? "", /The newest hour \(ending 2026-11-19T19:00:00Z\) reads 0\.18 µSv\/h, 0\.08 above the station's baseline of 0\.1: a jump in the latest hour, not over/);
  const unvalidated = await run([...Array.from({ length: 47 }, () => 0.1), 0.18], (i) => (i === 47 ? 2 : 1));
  assert.match(unvalidated?.verdictText ?? "", /reads 0\.18 µSv\/h \(not validated\)/);
  const over = await run([...Array.from({ length: 44 }, () => 0.1), 0.18, 0.1, 0.1, 0.11]);
  assert.match(over?.verdictText ?? "", /short spike to 0\.18 µSv\/h \(hour ending 2026-11-19T16:00:00Z\) over a baseline of 0\.1, back to 0\.11 now/);
});

test("readings in another unit: nSv/h and mSv/h are converted to µSv/h; an unknown unit is never judged as µSv/h", async () => {
  const nano = [
    ...STATIONS.filter(([, p]) => p["kenn"] !== "083370490" && p["kenn"] !== "010010001" && p["kenn"] !== "064380031"),
    stationRow("083370490", { value: 239, value_cosmic: 54, value_terrestrial: 185, unit: "nSv/h" }),
    stationRow("010010001", { value: 92, unit: "nSv/h" }),
    stationRow("064380031", { value: 0.114, unit: "µGy/h" }),
  ];
  const snap = await getDoseSnapshot(clientOf(odlApi(nano)), { limit: 3 });
  assert.equal(snap.status, "ok");
  if (snap.status !== "ok") return;
  assert.equal(snap.verdict, "normal", snap.verdictText);
  assert.deepEqual(snap.ranking.map((s) => [s.kenn, s.value, s.unit]), [["083370490", 0.239, "µSv/h"], ["082370020", 0.202, "µSv/h"], ["092721221", 0.201, "µSv/h"]]);
  assert.deepEqual([snap.ranking[0]?.valueCosmic, snap.ranking[0]?.valueTerrestrial], [0.054, 0.185]);
  assert.deepEqual(snap.skipped, { total: 4, byStatus: { defekt: 2, Testbetrieb: 1, "unit µGy/h": 1 } });
  assert.match(snap.notes.join(" "), /2 readings came in nSv\/h and are converted to µSv\/h/);
  assert.match(snap.notes.join(" "), /1 station reports in a unit that is no dose rate in µSv\/h \(µGy\/h: Egelsbach, 064380031\) and is left out/);
  const map = await getStationsMap(clientOf(odlApi(nano)));
  assert.deepEqual(map.status === "ok" ? map.valueRange : undefined, { min: 0.05, max: 0.239 });
  const greek = await getDoseSnapshot(clientOf(odlApi([...STATIONS.filter(([, p]) => p["kenn"] !== "083370490"), stationRow("083370490", { unit: "μSv/h" })])), { limit: 1 });
  assert.equal(greek.status === "ok" && greek.ranking[0]?.kenn, "083370490", "the Greek mu is the micro sign");
  const series = { ...SERIES, "064380031": { hourly: hourly(Array.from({ length: 48 }, () => 110)) } };
  const transport = makeMockTransport((request) => {
    const body = JSON.parse(odlAnswer(request, STATIONS, series).body.toString("utf8")) as { features: { properties: Record<string, unknown> }[] };
    if (/timeseries/.test(request.url)) for (const f of body.features) f.properties["unit"] = "nSv/h";
    return jsonResponse(body);
  });
  const trend = await getStationTrend(new StrahlenschutzClient({ transport: transport.transport }), { station: "064380031" });
  assert.deepEqual(trend.status === "ok" ? [trend.latest.value, trend.verdict] : [], [0.11, "steady"]);
});

test("a network answer that drifted or came back empty is an error that says so, never an empty answer with advice that sends the caller elsewhere", async () => {
  const drifted = (change: (feature: { geometry: { coordinates: unknown } | null; properties: Record<string, unknown> }) => void, keep?: (i: number) => boolean) =>
    new StrahlenschutzClient({
      transport: makeMockTransport((request) => {
        const body = JSON.parse(odlAnswer(request).body.toString("utf8")) as { features: { geometry: { coordinates: unknown } | null; properties: Record<string, unknown> }[] };
        body.features = body.features.filter((_, i) => keep?.(i) ?? true);
        body.features.forEach(change);
        return jsonResponse(body);
      }).transport,
    });
  const rename = (from: string, to: string) => (f: { properties: Record<string, unknown> }) => {
    f.properties[to] = f.properties[from];
    delete f.properties[from];
  };
  const cases: [string, () => Promise<unknown>, RegExp][] = [
    ["empty", () => getDoseSnapshot(drifted(() => {}, () => false)), /holds no stations at all/],
    ["value renamed", () => getDoseSnapshot(drifted(rename("value", "wert"))), /21 of 21 stations in Betrieb have no value in µSv\/h/],
    ["value as a string", () => getDoseSnapshot(drifted((f) => (f.properties["value"] = String(f.properties["value"])))), /have no value in µSv\/h/],
    ["kenn renamed", () => getDoseSnapshot(drifted(rename("kenn", "id_kenn")), { state: "BY" }), /24 of 24 stations have no 9-digit kenn/],
    ["coordinates swapped", () => getStationsMap(drifted((f) => f.geometry !== null && (f.geometry.coordinates = [...(f.geometry.coordinates as number[])].reverse()))), /stations have no coordinates in Germany/],
    ["geometry null", () => getDoseSnapshot(drifted((f) => (f.geometry = null)), { place: "München" }), /24 of 24 stations have no coordinates in Germany/],
    ["end_measure renamed", () => findStations(drifted(rename("end_measure", "ende")), { query: "Bergen" }), /21 of 21 readings carry no end_measure/],
  ];
  for (const [name, call, message] of cases) {
    await assert.rejects(call(), (err) => err instanceof StrahlParseError && message.test(err.message) && /unexpected shape/.test(err.message), name);
  }
  const fine = await getDoseSnapshot(drifted(() => {}, (i) => i < 3));
  assert.equal(fine.status, "ok", "a small network that holds what a network holds is no drift");
});
