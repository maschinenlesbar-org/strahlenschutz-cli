// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import { StrahlApiError, StrahlError, StrahlNotFoundError, StrahlValidationError } from "../client/errors.js";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A bare invocation with no command is a request for usage, not an error:
  // print help to stdout and exit 0, mirroring `--help`.
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; genuine parse errors carry their own code.
      return err.exitCode;
    }
    if (err instanceof StrahlValidationError) {
      // An input the library rejected before any request: a usage error, the same
      // exit code as commander's own parse errors (1).
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    if (err instanceof StrahlNotFoundError) {
      deps.io.err(`Error: ${err.message}`);
      return 4;
    }
    if (err instanceof StrahlApiError) {
      // Exit 4 means "station not found", which the WFS never answers with a 404
      // (an unknown kenn is an empty collection). Every command requests the one
      // fixed WFS path, so a 404 means that path is missing: exit 1, and say so.
      const note =
        err.status === 404
          ? " (the WFS endpoint itself was not found: a wrong --base-url, or the API moved)"
          : "";
      deps.io.err(`Error: ${err.message}${note}`);
      return 1;
    }
    if (err instanceof StrahlError) {
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
