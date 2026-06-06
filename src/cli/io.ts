// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr.

import type { StrahlenschutzClient } from "../client/client.js";
import type { EngineOptions } from "../client/engine.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: EngineOptions): StrahlenschutzClient;
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
};
