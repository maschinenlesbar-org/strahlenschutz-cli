#!/usr/bin/env node
// Binary entry point. Thin shim around run(); all logic lives in run.ts/program.ts.

import { handleOutputErrors } from "./io.js";
import { installWarningLog } from "./log.js";
import { processLogger, run } from "./run.js";

const argv = process.argv.slice(2);
// What happens outside run() is logged too, in the format argv asks for.
const log = processLogger(argv);
// Node's own process warnings are records too, not plain lines.
installWarningLog(process, log);
// Before run(): a reader that closes the pipe early (`| head`) must end the run quietly
// with exit 0, not an unhandled EPIPE stack trace and exit 1.
handleOutputErrors(process, undefined, log);
const exitCode = await run(argv);
process.exitCode = exitCode;
