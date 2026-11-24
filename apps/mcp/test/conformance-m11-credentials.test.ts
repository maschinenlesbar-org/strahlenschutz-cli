// Conformance test M11 (MCP kit, rollout plan 2026-11-19): credentials, for an API that needs
// them (src/mcp/credentials.ts, api.ts's `findCredentials`).
// - Nothing is looked up before the first tool call: the handshake and the tool list make no
//   request and read no environment.
// - The environment's credential is sent; one INFO record of `<program>.config` says where it
//   came from, never the value.
// - The lookup is shared by the calls waiting for it, and runs on no call's signal: cancelling the
//   call that started it (or its deadline) fails none of the others.
// - The value never appears in a log record, a result or an error message, even when the
//   upstream echoes it.
// - A credential the server obtains (a public key) is obtained once, at the first call; a lookup
//   that fails is that call's tool error and is tried again at the next call.
// - The secrets are replaced in every string of a result (keys too), in a tool error's message
//   and in the ERROR record of a bug; very short values are no secrets.
// The tests run in process with their own environment (never the real one, never a credentials
// file). Those that need credentials are skipped for an API without them. Shared across the repos with an MCP server; only
// the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { apiBase, Client, ClientError, type HttpRequest, type HttpResponse } from "../src/mcp/api.js";
import { redactingLog, Secrets } from "../src/mcp/credentials.js";
import { callScope, limitTransport } from "../src/mcp/limiter.js";
import { callTool, shareLookup, type ToolDefinition } from "../src/mcp/server.js";
import { TOOLS } from "../src/mcp/tools.js";
import { PROGRAM } from "../src/mcp/version.js";
import { config, connect, noUpstream, recorder } from "./harness.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { makeMockTransport } from "./helpers.js";
/** The API's credentials, or undefined when it needs none (every test here is skipped). */
const CREDENTIALS = undefined as
  | {
      /** The environment that gives the credential, and its secret value. */
      env: Record<string, string>;
      secret: string;
      /** True when `request` carries `value` as the credential. */
      sent: (request: HttpRequest, value: string) => boolean;
      /** A tool call that sends the credential. */
      call: { name: string; arguments: Record<string, unknown> };
      /** A good answer to the call's requests, with `echo` in a string the result keeps. */
      answer: (request: HttpRequest, echo: string) => HttpResponse;
      /** An error answer (HTTP 500) to the call's requests that quotes `echo`. */
      failure: (request: HttpRequest, echo: string) => HttpResponse;
      /**
       * For a credential obtained at the first call: its request, the answer that gives `value`, and
       * the value obtained (default "obtained-public-credential"; one the repository's key format
       * accepts where it refuses that).
       */
      obtained?: { isRequest: (request: HttpRequest) => boolean; answer: (value: string) => HttpResponse; value?: string };
    }
  | undefined;
// --------------------------------------------------------------------------------------

// A client for a test (harness.ts: with the repository's test login, where its client needs one).
const { newClient } = await import("./harness.js");

const skip = CREDENTIALS === undefined ? "the API needs no credentials" : false;
/** The value the adapter's key source gives (an adapter without `value` gets the default). */
const obtainedValueOf = (obtained: object): string => (obtained as { value?: string }).value ?? "obtained-public-credential";
const records = (lines: string[]) => lines.join("\n");

test("nothing is looked up before the first tool call: the handshake and the tool list make no request", { skip }, async () => {
  const upstream = makeMockTransport(() => {
    throw new Error("no request expected");
  });
  const connection = await connect({ transport: upstream, env: {} });
  await connection.request("tools/list");
  assert.equal(upstream.calls.length, 0);
  await connection.close();
});

test("the environment's credential is sent; one INFO record names where it came from, never the value", { skip }, async () => {
  if (CREDENTIALS === undefined) return;
  const { log, lines } = recorder();
  const upstream = makeMockTransport((request) => CREDENTIALS.answer(request, "ok"));
  const connection = await connect({ transport: upstream, env: CREDENTIALS.env, log });
  const result = await connection.call(CREDENTIALS.call.name, CREDENTIALS.call.arguments);
  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.ok(upstream.calls.length > 0 && upstream.calls.every((request) => CREDENTIALS.sent(request, CREDENTIALS.secret)), "every request carries the credential");
  const info = lines.filter((line) => line.includes(` INFO  [${PROGRAM}.config] `));
  assert.equal(info.length, 1, records(lines));
  assert.ok(!records(lines).includes(CREDENTIALS.secret), records(lines));
  await connection.call(CREDENTIALS.call.name, CREDENTIALS.call.arguments);
  assert.equal(lines.filter((line) => line.includes(` INFO  [${PROGRAM}.config] `)).length, 1, "looked up once");
  await connection.close();
});

test("the credential never appears in a result, an error or a record, even when the upstream echoes it", { skip }, async () => {
  if (CREDENTIALS === undefined) return;
  const { log, lines } = recorder();
  let fail = false;
  const upstream = makeMockTransport((request) => (fail ? CREDENTIALS.failure(request, CREDENTIALS.secret) : CREDENTIALS.answer(request, `echo ${CREDENTIALS.secret} echo`)));
  const connection = await connect({ transport: upstream, env: CREDENTIALS.env, log });
  const ok = await connection.call(CREDENTIALS.call.name, CREDENTIALS.call.arguments);
  assert.notEqual(ok.isError, true, ok.content[0]?.text);
  assert.ok(!JSON.stringify(ok).includes(CREDENTIALS.secret), "not in the result");
  assert.ok(JSON.stringify(ok).includes("echo *** echo"), "the echo is kept, the value replaced");
  fail = true;
  const failed = await connection.call(CREDENTIALS.call.name, CREDENTIALS.call.arguments);
  assert.equal(failed.isError, true);
  assert.ok(!JSON.stringify(failed).includes(CREDENTIALS.secret), "not in the error");
  assert.ok(!records(lines).includes(CREDENTIALS.secret), "not in a record");
  await connection.close();
});

test("an obtained credential is obtained once, at the first call, and sent; it is a secret too", { skip: skip || (CREDENTIALS?.obtained === undefined ? "nothing is obtained" : false) }, async () => {
  const c = CREDENTIALS;
  if (c?.obtained === undefined) return;
  const obtainedValue = obtainedValueOf(c.obtained);
  const { log, lines } = recorder();
  const upstream = makeMockTransport((request) => (c.obtained?.isRequest(request) ? c.obtained.answer(obtainedValue) : c.answer(request, `echo ${obtainedValue}`)));
  const connection = await connect({ transport: upstream, env: {}, log });
  for (let i = 0; i < 2; i++) {
    const result = await connection.call(c.call.name, c.call.arguments);
    assert.notEqual(result.isError, true, result.content[0]?.text);
    assert.ok(!JSON.stringify(result).includes(obtainedValue), "not in the result");
  }
  assert.equal(upstream.calls.filter((request) => c.obtained?.isRequest(request)).length, 1, "obtained once");
  const api = upstream.calls.filter((request) => !c.obtained?.isRequest(request));
  assert.ok(api.length > 0 && api.every((request) => c.sent(request, obtainedValue)), "sent with every request");
  assert.equal(lines.filter((line) => line.includes(` INFO  [${PROGRAM}.config] `)).length, 1, records(lines));
  assert.ok(!records(lines).includes(obtainedValue), records(lines));
  await connection.close();
});

test("a lookup that fails is the call's tool error, and the next call tries again", { skip: skip || (CREDENTIALS?.obtained === undefined ? "nothing is obtained" : false) }, async () => {
  const c = CREDENTIALS;
  if (c?.obtained === undefined) return;
  let down = true;
  const upstream = makeMockTransport((request) => {
    if (c.obtained?.isRequest(request)) return down ? { status: 500, headers: { "content-type": "text/plain" }, body: Buffer.from("down") } : c.obtained.answer(obtainedValueOf(c.obtained));
    return c.answer(request, "ok");
  });
  const connection = await connect({ transport: upstream, env: {}, config: { callTimeoutMs: 4000 } });
  const first = await connection.call(c.call.name, c.call.arguments);
  assert.equal(first.isError, true);
  assert.ok((first.content[0]?.text ?? "").length > 0);
  down = false;
  const second = await connection.call(c.call.name, c.call.arguments);
  assert.notEqual(second.isError, true, second.content[0]?.text);
  await connection.close();
});

test("a shared lookup runs on no call's signal: cancelling the call that started it fails none of the others waiting", async () => {
  let release: () => void = () => {};
  const answered = new Promise<void>((resolve) => (release = resolve));
  // A key source that answers late and, like the real transport, ends a request when its signal aborts.
  const source = limitTransport((request) =>
    new Promise<HttpResponse>((resolve, reject) => {
      if (request.signal?.aborted === true) return reject(new Error("aborted"));
      request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      void answered.then(() => resolve({ status: 200, headers: {}, body: Buffer.from("key") }));
    }),
  );
  let looked = 0;
  const lookup = shareLookup(async () => {
    looked += 1;
    return (await source({ method: "GET", url: "https://keys.example/", headers: {} } as HttpRequest)).body.toString();
  });
  const first = new AbortController();
  const waiting = [first, new AbortController()].map((call) => callScope.run({ signal: call.signal }, () => lookup()));
  first.abort();
  release();
  const [a, b] = await Promise.allSettled(waiting);
  assert.deepEqual(b, { status: "fulfilled", value: "key" }, "the other call gets the key");
  assert.deepEqual(a, { status: "fulfilled", value: "key" }, "the lookup itself went on; the cancelled call stops waiting in callTool");
  assert.equal(looked, 1, "looked up once");
});

test("Secrets: every occurrence replaced, the longest value first, keys too; blank and very short values are none", () => {
  const secrets = new Secrets();
  assert.equal(secrets.redact("abc"), "abc");
  secrets.add(["s3cret", "s3cret-longer", "abc", "  "]);
  assert.equal(secrets.redact("x s3cret-longer y s3cret z abc"), "x *** y *** z abc");
  assert.deepEqual(secrets.redactAll({ list: ["s3cret", 1, null], "s3cret key": { deep: "a s3cret" } }), { list: ["***", 1, null], "*** key": { deep: "a ***" } });
});

test("a tool error and a bug's record (the server's log) never carry a secret", async () => {
  const secrets = new Secrets();
  secrets.add(["s3cret-value"]);
  const { log, lines } = recorder();
  const tool = TOOLS[0] as ToolDefinition;
  // The server's log, as the factory builds it.
  const env = { client: newClient({ transport: noUpstream }) as Client, apiBase: apiBase(undefined), config: config(), log: redactingLog(log, secrets), secrets };
  const refused = await callTool({ ...tool, run: () => Promise.reject(new ClientError("refused with s3cret-value")) }, {}, new AbortController().signal, env);
  assert.equal(refused.content[0]?.text, "refused with ***");
  const bug = await callTool({ ...tool, run: () => Promise.reject(new Error("crashed on s3cret-value")) }, {}, new AbortController().signal, env);
  assert.equal(bug.isError, true);
  assert.ok(lines.length > 0 && !records(lines).includes("s3cret-value"), records(lines));
  assert.match(records(lines), /crashed on \*\*\*/);
});
