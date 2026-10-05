#!/usr/bin/env node
// Binary entry point. Thin shim around run(); all logic lives in run.ts/program.ts.

import { handleOutputErrors } from "./io.js";
import { run } from "./run.js";

// Before run(): a reader that closes the pipe early (`| head`) must end the run quietly
// with exit 0, not an unhandled EPIPE stack trace and exit 1.
handleOutputErrors();
const exitCode = await run(process.argv.slice(2));
process.exitCode = exitCode;
