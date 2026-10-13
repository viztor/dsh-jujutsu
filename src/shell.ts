/**
 * The `ctx.shell` wrapper: how this plugin runs `jj` and `jj-hunk`.
 *
 * Three facts shape it, all read from the installed harness:
 *
 * 1. **`ShellExecRequest` takes a command string, not an argv array.** There is
 *    no `execFile` path, so every argument must be **shell-quoted by us**.
 *    `shellQuote` is load-bearing: a revset, a commit message, or a path
 *    containing a quote must not be able to break out.
 * 2. **`result()` is the only way to get output**, and non-zero exits *resolve*
 *    rather than reject — the caller decides what an exit code means.
 * 3. **A truncated stream means `text` is the tail.** For a JSON parse that must
 *    be a hard error, never a best-effort parse of half a document.
 *
 * @module dsh-jujutsu/shell
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ShellExecRequest, ShellExecutor } from "@deepseek-ai/dsh-shell";

export interface RunOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when either captured stream is a tail, not the whole stream. */
  readonly truncated: boolean;
}

/**
 * Quote one argument for a POSIX shell.
 *
 * Single-quote escaping and nothing clever: wrap in `'…'` and replace each
 * embedded `'` with `'\''`. This is the only form that is correct for arbitrary
 * input, including newlines and `$`.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The shell service is absent, so no process could be started at all. */
export class ShellUnavailableError extends Error {
  constructor() {
    super("no shell service mounted");
    this.name = "ShellUnavailableError";
  }
}

/**
 * Run one command and collect its output.
 *
 * Throws only on a spawn failure or a missing shell service. A non-zero exit is
 * returned, because callers distinguish "jj said no" (a typed error with a hint)
 * from "jj could not start" (an infrastructure failure).
 */
export async function run(
  ctx: Context,
  argv: readonly [string, ...string[]],
  options: RunOptions,
): Promise<RunResult> {
  const shell = ctx.get("shell") as ShellExecutor | undefined;
  // Typed, because a caller has to tell "no process could start" from "the
  // process ran and said no". The hunk bridge offers to install `jj-hunk` when a
  // binary is missing — and without this it read a missing *shell service* the
  // same way, then offered an install that could not have run either.
  if (shell === undefined) throw new ShellUnavailableError();

  const request: ShellExecRequest = {
    command: argv.map(shellQuote).join(" "),
    workdir: options.cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  const result = await (await shell.execute(shell.resolve(request))).result();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
    timedOut: result.timedOut,
    truncated: result.stdout.truncated || result.stderr.truncated,
  };
}

/** Run one binary with arguments, quoting each. */
export function runJj(
  ctx: Context,
  binary: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return run(ctx, [binary, ...args], options);
}
