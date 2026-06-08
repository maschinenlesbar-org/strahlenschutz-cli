# strahlenschutz-cli — exploratory test findings

Environment: 2026-06-06, Node v22.14.0, live BfS ODL-Info WFS reachable. Binary driven as `node dist/src/cli/index.js …` after `npm run build`. Exit codes captured without a pipe.

**14 genuine, reproducible bugs** (2 High, 4 Medium, 8 Low). The kenn validation / injection hardening is genuinely solid (see "verified correct"), so the real defects cluster around the WFS query parameters and numeric-flag parsing. The two High findings are confirmed against the live server with `curl`.

## High

### 1. `--max N` is silently ignored — every query returns the full dataset — ✅ FIXED
**Fix:** `src/client/client.ts` now sends the WFS 2.0 `count` parameter for `maxFeatures` instead of the ignored WFS 1.x `maxFeatures`.
- Severity: High · Confidence: Confirmed
- Repro:
  ```
  node dist/src/cli/index.js --compact latest --max 1   | grep -o '"id"' | wc -l   # 3360 (=1680 features)
  node dist/src/cli/index.js --compact latest --max 5   | grep -o '"id"' | wc -l   # 3360
  node dist/src/cli/index.js --compact latest           | grep -o '"id"' | wc -l   # 3360
  ```
  Confirmed cause via curl: the endpoint is **WFS 2.0**, which uses `count=`, not the WFS 1.x `maxFeatures=` the client sends:
  ```
  curl '…/ows?…&maxFeatures=1' → "numberReturned":1680   (ignored)
  curl '…/ows?…&count=1'       → "numberReturned":1      (honoured)
  ```
- Expected: `--max 1` returns 1 feature.
- Actual: `--max` is a no-op; the CLI always downloads all ~1680 stations regardless of `--max`. Wasteful and misleading.
- Root cause: `src/client/client.ts:53` sets `params["maxFeatures"]` — should be `count`. The README library example (`README.md:97`, `client.latest({ maxFeatures: 5 })`) is therefore also misleading.

### 2. `--start` (paging) always fails with HTTP 400 — ✅ FIXED
**Fix:** `src/client/client.ts` now pairs `startIndex` with a `count` (the user's `--max`, or a `DEFAULT_PAGE_COUNT` of 1000 when none is given), since WFS 2.0 rejects a bare `startIndex`.
- Severity: High · Confidence: Confirmed
- Repro: `node dist/src/cli/index.js latest --start 0` AND `… latest --start 1`
- Actual (both): `exit=1  Error: HTTP 400 for GET …&startIndex=0` / `…&startIndex=1`. Every `--start` value 400s, so pagination is unusable as shipped (a WFS 2.0 `startIndex` paging request is rejected when sent without a `count`, which the client never sends — see #1).
- Root cause: `src/client/client.ts:54` sends `startIndex` with no accompanying `count`.

## Medium

### 3. `--max` / `--start` accept hexadecimal — ✅ FIXED
**Fix:** `parseIntArg` in `src/cli/shared.ts` now requires a plain `^[0-9]+$` decimal string, so `0x10` is rejected.
- Severity: Medium · Confidence: Confirmed
- Repro: `node dist/src/cli/index.js latest --max 0x10` → accepted, exit 0 (would send 16 once #1 is fixed). `parseIntArg` uses bare `Number()`.

### 4. `--max` / `--start` accept exponent notation — ✅ FIXED
**Fix:** Same `parseIntArg` change in `src/cli/shared.ts`; `1e3` no longer matches the decimal-only pattern.
- Severity: Medium · Confidence: Confirmed
- Repro: `node dist/src/cli/index.js latest --max 1e3` → accepted, exit 0.

### 5. `--max ""` / `--start ""` accept empty string (→ 0) — ✅ FIXED
**Fix:** Same `parseIntArg` change in `src/cli/shared.ts`; an empty (or whitespace) string fails the `^[0-9]+$` test and is rejected.
- Severity: Medium · Confidence: Confirmed
- Repro: `node dist/src/cli/index.js latest --max ""` → exit 0 (empty coerced to 0). `node … latest --start ""` → `Error: HTTP 400 …startIndex=0` (empty→0→server 400, compounding #2). An empty value from an unset script/env var is silently coerced rather than rejected.

### 6. Unknown station returns an empty 200 instead of a not-found signal — ✅ FIXED
**Fix:** The `station` command in `src/cli/commands/odl.ts` now treats an empty FeatureCollection as not-found: it throws the new `StrahlNotFoundError` (`src/client/errors.ts`), which `src/cli/run.ts` maps to exit code 4 with a clear "No station found for kenn …" message.
**Also fixed (station filtering):** `src/client/client.ts` now filters by `CQL_FILTER=kenn='<id>'` instead of `viewparams=kenn:<id>` — the latter was silently ignored by the live WFS (returned all ~1682 features), which also defeated the not-found mapping above.
- Severity: Medium · Confidence: Confirmed
- Repro: `node dist/src/cli/index.js station 999999999` → exit 0, `{ "type":"FeatureCollection", "features":[…] }` (empty/irrelevant). A typo'd kenn is indistinguishable from a valid station with no current reading; the documented `404 → exit 4` is unreachable for this WFS (it never 404s on unknown ids).

## Low

### 7. No-args prints usage to stderr and exits 1 — ✅ FIXED
**Fix:** `src/cli/run.ts` now short-circuits an empty argv: it prints help to stdout and returns 0, matching `--help`.
- Severity: Low · Confidence: Confirmed
- Repro: `node dist/src/cli/index.js` → `exit=1`, "Usage: strahlenschutz …" on stderr. `--help` correctly uses stdout/exit 0; the bare invocation should match.

### 8. `--sort <invalid>` surfaces a raw URL-dump 400 — ⚠️ WONTFIX (valid sort properties depend on the live WFS schema, which isn't known client-side)
**Fix:** No code change. `--sort` is an intentional passthrough to the WFS `sortBy`; the set of valid properties varies by feature type and is defined by the server, so a client-side allow-list would be brittle and quickly stale. The error already includes the upstream status and URL, which is the most accurate diagnostic for an invalid sort property.
- Severity: Low · Confidence: Confirmed
- Repro: `node dist/src/cli/index.js latest --sort bogusprop --max 1` → `exit=1  Error: HTTP 400 for GET …&sortBy=bogusprop&maxFeatures=1`. `--sort` is an unvalidated passthrough; an invalid sort property yields a raw upstream 400 with the full URL rather than a hint about valid properties.

### 9. Connection-refused surfaced as a raw Node error — ⚠️ WONTFIX (the raw OS-level message is the most accurate diagnostic; exit code is already correct)
**Fix:** No code change. The transport already wraps the OS error in a typed `StrahlNetworkError` and exits 1 (which the report agrees is correct). The `ECONNREFUSED 127.0.0.1:1` text is the precise cause; replacing it with a generic phrasing would lose diagnostic detail.
- Severity: Low · Confidence: Confirmed
- Repro: `node dist/src/cli/index.js --base-url http://127.0.0.1:1 latest` → `Error: connect ECONNREFUSED 127.0.0.1:1` (raw `node:net` text; exit 1 is correct).

### 10. `parseIntArg` error text contradicts accepted input — ✅ FIXED
**Fix:** With the stricter `parseIntArg` in `src/cli/shared.ts`, the accepted inputs now match the "non-negative integer" message: `0x10`, `1e3`, `""`, and whitespace are all rejected.
- Severity: Low · Confidence: Confirmed
- The parser's message says "Expected a non-negative integer," yet accepts `0x10`, `1e3`, `""`, and whitespace, while correctly rejecting `-5` and `abc` (commander path).

### 11. `--max` / `--start` accept unsafe-magnitude integers (precision loss) — ✅ FIXED
**Fix:** `parseIntArg` in `src/cli/shared.ts` now rejects values past `Number.MAX_SAFE_INTEGER` via a `Number.isSafeInteger` guard.
- Severity: Low · Confidence: Likely
- `node dist/src/cli/index.js latest --max 99999999999999999999` is accepted (no validation error); `Number()` yields `1e20` and would serialise as `100000000000000000000`. (Moot today only because `maxFeatures` is ignored per #1.)

### 12. README library example uses the non-functional `maxFeatures` — ✅ FIXED
**Fix:** With #1 fixed, `client.latest({ maxFeatures: 5 })` now genuinely limits results (mapped to WFS 2.0 `count`); `README.md:97` was annotated to make the mapping explicit.
- Severity: Low · Confidence: Confirmed
- `README.md:97` shows `client.latest({ maxFeatures: 5 })`, which (per #1) does not limit results — the documented usage is wrong.

### 13. `latest`/`timeseries` `--max`/`--start` options are advertised but effectively non-functional — ✅ FIXED
**Fix:** Resolved as a consequence of #1 and #2 in `src/client/client.ts`; `--max` now limits and `--start` pages correctly, so `--help` no longer over-promises.
- Severity: Low · Confidence: Confirmed
- Consequence of #1+#2: `--help` lists `--max`/`--start` as working query controls, but `--max` is ignored and `--start` always 400s — the help over-promises.

### 14. `--start` value `0` is not special-cased despite being the natural first page — ✅ FIXED
**Fix:** Resolved by the #2 fix in `src/client/client.ts`: `startIndex=0` is now sent with an accompanying `count`, so it returns the first page instead of 400-ing.
- Severity: Low · Confidence: Confirmed
- Users will reasonably try `--start 0` first; it 400s (see #2). Even after fixing #1/#2, a 0-based default should be handled gracefully.

## Verified correct (not bugs)
- `kenn` validation is solid: `station abc`, `station "091811461;foo"`, `station "09 18"`, `station ""` are all rejected with `Invalid station id … Expected a non-empty numeric kenn (digits only)` — the viewparams-injection vector (`;`, `&`, spaces) is closed.
- `--resolution` rejects invalid/wrong-case values; `latest`/`station`/`timeseries` happy paths return GeoJSON; German output is emitted raw.
- Negative (`--max -5`) and non-numeric (`--start abc`) are rejected by commander; unknown command and extra positionals rejected.
- `--timeout 1` → "Request timed out after 1ms"; closed port → exit 1. No `-o/--output` in `--help` (correctly removed).

**Count: 14 real bugs (2 High, 4 Medium, 8 Low).** Top fix: send WFS 2.0 `count` (and pair it with `startIndex`) instead of `maxFeatures`.
