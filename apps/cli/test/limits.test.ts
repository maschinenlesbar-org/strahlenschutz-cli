// Container limits (cgroup v2 and v1) and what the CLI does with them: in a memory-limited
// container the default response cap follows the memory, so an oversized answer meets the cap's
// error before the kernel's OOM kill (exit 137, nothing said); under a pids limit Node can't work
// with, a request is refused with one ERROR record. And the program name before the command
// (`docker run <image> strahlenschutz latest --max 1`) is dropped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readContainerLimits, responseCapFor } from "../src/cli/limits.js";
import { run } from "../src/cli/run.js";
import { exitOnSignalsAsPid1, type CliDeps } from "../src/cli/io.js";
import { EventEmitter } from "node:events";
import { StrahlenschutzClient } from "@maschinenlesbar.org/strahlenschutz-client/internal/client";
import { odlApi } from "@maschinenlesbar.org/strahlenschutz-client/test/fixtures";
import type { ContainerLimits } from "../src/cli/limits.js";

const MiB = 1024 * 1024;
const COMMAND = ["latest", "--max", "1"];
const files = (map: Record<string, string>) => (path: string) => {
  const text = map[path];
  if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return text;
};

test("cgroup v2 limits are read; 'max' and missing files mean no limit", () => {
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory.max": "134217728\n", "/sys/fs/cgroup/pids.max": "64\n" })), { memoryBytes: 128 * MiB, pids: 64 });
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/pids.max": "max\n" })), {});
  assert.deepEqual(readContainerLimits(files({})), {});
});

test("cgroup v1 limits are read; its 'unlimited' (a huge number) means no limit", () => {
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "268435456\n", "/sys/fs/cgroup/pids/pids.max": "8\n" })), { memoryBytes: 256 * MiB, pids: 8 });
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" })), {});
});

test("the response cap is an eighth of the memory, at least 1 MiB, at most the 100 MiB default", () => {
  assert.equal(responseCapFor(128 * MiB), 16 * MiB);
  assert.equal(responseCapFor(4 * MiB), 1 * MiB);
  assert.equal(responseCapFor(64 * 1024 * MiB), 100 * MiB);
});

/** Run `argv` with a client whose API answers like the WFS; what the CLI gave the client and said. */
async function under(limits: ContainerLimits, argv: string[]) {
  const err: string[] = [];
  let seen: number | undefined;
  let created = false;
  const deps: CliDeps = {
    io: { out: () => {}, err: (text) => void err.push(text) },
    createClient: (options) => {
      created = true;
      seen = options.maxResponseBytes;
      return new StrahlenschutzClient({ ...options, transport: odlApi().transport });
    },
    limits: () => limits,
  };
  const code = await run(argv, deps);
  return { code, err: err.join(""), created, cap: seen };
}

test("in a memory-limited container the default cap follows the memory; --max-response-bytes still wins", async () => {
  assert.equal((await under({ memoryBytes: 128 * MiB }, COMMAND)).cap, 16 * MiB);
  assert.equal((await under({}, COMMAND)).cap, undefined, "no limit: the client's default (100 MiB)");
  assert.equal((await under({ memoryBytes: 128 * MiB }, ["--max-response-bytes", "5000", ...COMMAND])).cap, 5000);
});

test("under a pids limit below 12 a request is refused with one ERROR record and exit 1, not a crash", async () => {
  const tight = await under({ pids: 8 }, COMMAND);
  assert.equal(tight.code, 1);
  assert.equal(tight.created, false, "no request is attempted");
  assert.match(tight.err, /ERROR \[strahlenschutz\.cli\] the container allows only 8 processes and threads \(--pids-limit 8\); the CLI needs at least 12\. Run it with --pids-limit 12 or more\./);
  assert.equal(tight.err.trim().split("\n").length, 1);
  const enough = await under({ pids: 12 }, COMMAND);
  assert.equal(enough.code, 0, enough.err);
});

test("the program name before the command is dropped: `strahlenschutz latest --max 1` works as `latest --max 1`", async () => {
  const named = await under({}, ["strahlenschutz", ...COMMAND]);
  assert.equal(named.code, 0, named.err);
  assert.equal(named.created, true);
  const twice = await under({}, ["strahlenschutz", "strahlenschutz", ...COMMAND]);
  assert.notEqual(twice.code, 0, "only one leading name is dropped");
  assert.equal(twice.created, false);
});

/** A process stand-in with a pid: records its signal listeners and exits. */
function fakeProcess(pid: number) {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  return { emitter, exits, proc: { pid, once: (event: string, listener: () => void) => emitter.once(event, listener), exit: (code: number) => void exits.push(code) } };
}

test("as PID 1 (a container's first process), SIGINT, SIGTERM and SIGHUP exit 130, 143 and 129: the kernel drops a default-action signal sent to PID 1", () => {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    const { emitter, exits, proc } = fakeProcess(1);
    exitOnSignalsAsPid1(proc);
    emitter.emit(signal);
    assert.deepEqual(exits, [code], signal);
  }
});

test("not PID 1, no signal listener is installed: Node's default action stays", () => {
  const { emitter, proc } = fakeProcess(4242);
  exitOnSignalsAsPid1(proc);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(emitter.listenerCount(signal), 0, signal);
});
