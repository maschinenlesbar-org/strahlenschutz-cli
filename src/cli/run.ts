// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  StrahlApiError,
  StrahlError,
  StrahlNotFoundError,
  StrahlValidationError,
  credentialsIn,
  redactCredentials,
} from "../client/errors.js";

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

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also covers
 * a URL that does not parse; a backstop behind the exact-string redaction below.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * `deps` with an `io` that redacts the credentials of every argument from everything it
 * prints. Commander echoes rejected values in its errors (`--base-url`, an option given a
 * URL), and the CLI's own messages name unknown commands: whatever path a credential takes
 * to stdout or stderr, the exact userinfo (as `credentialsIn` finds it, plus its
 * JSON-escaped form) is replaced by `***`. A pattern alone can't delimit a password with
 * spaces, quotes, `#`, `?` or `/`; the exact strings can. Without credentials the output
 * passes through unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  for (const source of [...argv, ...values]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  if (secrets.size === 0) return deps;
  const list = [...secrets];
  const redact = (text: string): string => redactUserinfo(redactCredentials(text, list));
  return { ...deps, io: { out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) } };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
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
