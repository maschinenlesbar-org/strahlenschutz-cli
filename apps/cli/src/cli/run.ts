// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { OutputError } from "./shared.js";
import { DEFAULT_LOG_FORMAT, createLogger, logFormatFromArgv, type LogFormat, type Logger } from "./log.js";
import {
  StrahlApiError,
  StrahlError,
  StrahlNetworkError,
  StrahlNotFoundError,
  StrahlParseError,
  StrahlValidationError,
  credentialsIn,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
} from "@maschinenlesbar.org/strahlenschutz-client/internal/errors";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps, state: { errorLogged: boolean } = { errorLogged: false }): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => writeCommanderErr(command, deps, state, str),
  });
  for (const child of command.commands) configureTree(child, deps, state);
}

/** `strahlenschutz station`: the command's name with its parents'. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/**
 * commander's stderr output as log records, one per line. Its `error: …` is an ERROR of
 * `cli`, with a following `(Did you mean …?)` line appended to that same record; the
 * help it shows after an error is one INFO record per non-blank line. `help` for an
 * unknown command makes commander show the help as an error (exit 1) with no `error:` line: an ERROR record
 * "missing command: `strahlenschutz <subcommand>`" comes first, so every failed run has one.
 */
function writeCommanderErr(command: Command, deps: CliDeps, state: { errorLogged: boolean }, str: string): void {
  const log = logOf(deps);
  const text = str.replace(/\n$/, "");
  // The blank line commander writes between an error and the help it shows after.
  if (text.trim() === "") return;
  if (text.startsWith("error: ")) {
    state.errorLogged = true;
    log.error("cli", escapeCommanderError(text.slice("error: ".length)).replace(/\n(\(Did you mean .*\?\))$/, " $1"));
    return;
  }
  if (!state.errorLogged) {
    state.errorLogged = true;
    log.error("cli", `missing command: \`${commandPath(command)} <subcommand>\``);
  }
  for (const line of text.split("\n")) if (line.trim() !== "") log.info("cli", line.trimEnd());
}

/**
 * Escape the characters a terminal acts on in one commander error message: CR and LF
 * become `\r` and `\n` (as a log record writes them, `escapeForRecord`), the other C0
 * controls (tab excepted), DEL, C1 and Unicode format characters (bidi overrides,
 * zero-width characters, a soft hyphen) `\uXXXX`. Commander repeats a rejected argument raw
 * ("option '--max <n>' argument '<value>' is invalid"), and a value can come from a
 * pipeline: a newline in it could forge a record, an override reorder the line, a zero-width
 * space hide why the value was refused. The record escapes the controls too; this keeps the
 * invisible format characters visible. The library escapes the values it echoes itself
 * (`quoteValue`).
 */
export function escapeTerminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]|\p{Cf}/gu, (ch) =>
    ch === "\n"
      ? "\\n"
      : ch === "\r"
        ? "\\r"
        : Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
}

/**
 * escapeTerminalText for one commander error message, except for the
 * `\n(Did you mean …?)` line commander appends after an unknown command or option.
 * That hint is built from this CLI's own command and option names, and it can only
 * end the message: commander quotes the user's value (`unknown command '<value>'`), so
 * a value that contains the same text is followed by its closing quote and stays
 * escaped.
 */
export function escapeCommanderError(message: string): string {
  const hint = /\n\(Did you mean [^\n]*\?\)$/.exec(message);
  if (hint === null) return escapeTerminalText(message);
  return escapeTerminalText(message.slice(0, hint.index)) + hint[0];
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
 * The names (long and short) of the program's own options that require a value
 * (`--user-agent`, `--timeout`). Only the program's: commander takes them out of argv
 * wherever they stand, before a subcommand sees the rest.
 */
function valueOptionsOf(program: Command): Set<string> {
  const names = new Set<string>();
  for (const option of program.options) {
    if (!option.required) continue;
    if (option.long !== undefined) names.add(option.long);
    if (option.short !== undefined) names.add(option.short);
  }
  return names;
}

/**
 * True when `argv` holds only options the program itself knows and no command (and no
 * help or version request): `strahlenschutz --compact`. That is a request for usage like
 * the bare program, not a failed run. Anything else (a command, an unknown option, `--`,
 * an option that takes a value given last without one) is left to commander: with `--help`
 * appended, `strahlenschutz --timeout` took `--help` as the timeout ("argument '--help' is
 * invalid"), where commander alone says "argument missing".
 */
function onlyKnownGlobalOptions(program: Command, argv: readonly string[]): boolean {
  const known = new Map<string, boolean>();
  for (const option of program.options) {
    for (const name of [option.long, option.short]) if (name !== undefined) known.set(name, option.required);
  }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--help" || token === "-h" || token === "--version" || token === "-V") return false;
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const takesValue = known.get(name);
    if (takesValue === undefined) return false;
    if (takesValue && eq < 0) {
      if (i + 1 >= argv.length) return false;
      i++;
    }
  }
  return true;
}

/**
 * The options whose value is a base URL: a `user:password@host` given there without its
 * scheme is still a credential (anywhere else a bare `a:b@c` is not).
 */
const BASE_URL_FLAGS = ["--base-url"];

/** The values of the `flags` in `argv`, in both forms (`--flag value`, `--flag=value`). */
function flagValues(argv: readonly string[], flags: readonly string[]): string[] {
  const found: string[] = [];
  argv.forEach((token, i) => {
    const next = argv[i + 1];
    if (flags.includes(token) && next !== undefined) found.push(next);
    const eq = token.indexOf("=");
    if (eq > 0 && flags.includes(token.slice(0, eq))) found.push(token.slice(eq + 1));
  });
  return found;
}

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /**
   * stdout text: the userinfo of every URL-like argument replaced (`***@`), and the forms a
   * server echoes it back in (the Basic value, the decoded `user:password`).
   */
  out(text: string): string;
  /** stderr text, a record's message: the same, and the password alone (4+ characters). */
  err(text: string): string;
}

/**
 * The secrets of the run in `argv`. Commander echoes rejected values in its errors
 * (`--base-url`, an option given a URL), and the CLI's own messages name unknown commands:
 * whatever path a credential takes to stdout or stderr, the exact userinfo of every URL (as
 * `credentialsIn` finds it, plus its JSON-escaped form) is replaced by `***`. Only a value
 * with a scheme is a URL (a bare `a:b@c` is a station id, a User-Agent or a sort key as
 * often as a credential), except as the `--base-url` value. A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the exact strings
 * can (`redactUserinfo` is the backstop behind them). Without credentials the text passes
 * through unchanged. (This CLI reads no environment variable, so the arguments are the
 * only source.)
 */
export function redactionFor(argv: readonly string[]): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  const echoed = new Set<string>();
  const passwords = new Set<string>();
  // A base URL typed without its scheme is read as if it had one.
  const baseUrls = flagValues(argv, BASE_URL_FLAGS).map((value) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`));
  for (const source of [...values.flatMap(withDecoded).flatMap(urlsWithin), ...baseUrls]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      // As commander's echo shows it (escapeCommanderError), and as a JSON string.
      secrets.add(escapeTerminalText(secret));
      secrets.add(JSON.stringify(secret).slice(1, -1));
      // What a server echoes back: the Basic value and the decoded user:password on
      // stdout and stderr, the password alone (it may well occur in the data) on stderr.
      // Percent-encoded, as a request URL or an encoded argument carries it.
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) echoed.add(encoded);
      const [basic, pair, password] = echoedCredentialForms(secret);
      if (basic !== undefined) echoed.add(basic);
      if (pair !== undefined) echoed.add(pair);
      if (password !== undefined) passwords.add(password);
    }
  }
  if (secrets.size === 0) return { out: (text) => text, err: (text) => text };
  const list = [...secrets];
  // Longest first, so a password never leaves half of the user:password around it.
  const echoedList = [...echoed].sort((a, b) => b.length - a.length);
  const passwordList = [...passwords].sort((a, b) => b.length - a.length);
  const out = (text: string): string => redactSecrets(redactUserinfo(redactCredentials(text, list)), echoedList);
  return { out, err: (text) => redactSecrets(out(text), passwordList) };
}

/** Where a scheme (`https://`) starts inside a value: anywhere, not only at its start. */
const SCHEME_START = /[A-Za-z][A-Za-z0-9+.-]*:\/\//g;

/**
 * `value` and the rest of it from each place a URL starts inside it, for `credentialsIn`
 * (which reads a URL at the start of its input only). A kenn is sent trimmed, and every
 * refusal quotes the value as typed, so a padded `" https://user:pw@host"`, one after a dash
 * (`" -https://…"`) or inside a phrase reached the messages that quote it, and commander's echo.
 */
function urlsWithin(value: string): string[] {
  const found = [value];
  for (const match of value.matchAll(SCHEME_START)) if (match.index > 0) found.push(value.slice(match.index));
  return found;
}

/** `value`, and its percent-decoded form when it has one (an argument typed encoded). */
function withDecoded(value: string): string[] {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value ? [value] : [value, decoded];
  } catch {
    return [value];
  }
}

/**
 * `deps` that keep the secrets of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the raw `io.err`, so the frame is never
 * touched and a password holding DEL, C1 or bidi characters is matched before the record
 * escapes it. `io.err` itself is redacted too, for anything that writes to stderr without
 * the log.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const redaction = redactionFor(argv);
  const { out, err } = deps.io;
  return {
    ...deps,
    io: { ...deps.io, out: (text) => out(redaction.out(text)), err: (text) => err(redaction.err(text)) },
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

/**
 * The log area of a `StrahlError` that is neither an API error nor a usage error: the
 * connection (`http`), a malformed answer (`api`: bad JSON, an unknown charset, a 2xx body
 * that is no FeatureCollection, an answer for another station than the one asked for —
 * the API's answer as much as an error status is), an answer too deep to print (`output`),
 * else `cli`.
 */
function areaOf(err: StrahlError): string {
  if (err instanceof OutputError) return "output";
  if (err instanceof StrahlNetworkError) return "http";
  if (err instanceof StrahlParseError) return "api";
  return "cli";
}

/**
 * The log for what happens outside `run()`, in the bin shim: a stdout write error
 * (`handleOutputErrors`). Its format is the one argv asks for (`logFormatFromArgv`), and
 * it replaces the secrets of argv like the run's own log; it writes to the raw stderr.
 */
export function processLogger(argv: readonly string[]): Logger {
  return createLogger({
    format: logFormatFromArgv(argv),
    write: (line) => process.stderr.write(line + "\n"),
    redact: redactionFor(argv).err,
  });
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the secrets of the run in every message, in either format.
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);
  // For the records of a parse error: the scan of argv, now knowing which of the
  // program's options take a value, as commander reads them.
  if (deps.log !== undefined) deps.log.format = logFormatFromArgv(argv, valueOptionsOf(program));
  // One source for the format once commander has parsed argv: its value, not the scan
  // of argv (an option's value can look like --log-format; `--` ends the scan, not
  // commander's parse of a value). Ancestors' hooks run first, so this precedes every
  // other preAction check.
  const log = deps.log;
  program.hook("preAction", (_program, actionCommand) => {
    const format = (actionCommand.optsWithGlobals() as { logFormat?: LogFormat }).logFormat;
    if (log !== undefined) log.format = format ?? DEFAULT_LOG_FORMAT;
  });

  // A bare invocation with no command is a request for usage, not an error:
  // print help to stdout and exit 0, mirroring `--help`.
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  // Global options with no command are the bare program too: parsed with `--help` added,
  // so a rejected option value is still a usage error and the rest prints the help (exit 0).
  const parseArgv = onlyKnownGlobalOptions(program, argv) ? [...argv, "--help"] : argv;

  try {
    await program.parseAsync(parseArgv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; genuine parse errors carry their own code.
      return err.exitCode;
    }
    const log = logOf(deps);
    if (err instanceof StrahlValidationError) {
      // An input the library rejected before any request: a usage error, the same
      // exit code as commander's own parse errors (1).
      log.error("cli", err.message);
      return 1;
    }
    if (err instanceof StrahlNotFoundError) {
      // The API's answer: an empty collection for the station asked for.
      log.error("api", err.message);
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
      log.error("api", `${err.message}${note}`);
      return 1;
    }
    if (err instanceof StrahlError) {
      log.error(areaOf(err), err.message);
      return 1;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
