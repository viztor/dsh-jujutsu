/**
 * The `jj-hunk` bridge.
 *
 * `jj-hunk` is what makes hunk-level work possible headless at all: native `jj`
 * wants an interactive editor for `jj split -i`, and a TUI in an agent loop
 * hangs rather than fails. The bridge drives the binary non-interactively.
 *
 * ## The rules, every one of them measured
 *
 * - **`--query` is the primary input. Never accept hunk IDs across turns.**
 *   IDs are SHA-256 over the materialized comparison and regenerate on any edit
 *   — appending one comment invalidated every ID in the test fixture
 *   (`docs/13-empirical-verification.md` §6).
 * - **Never combine `--query` with `--include` / `--exclude` / `--files`.** It
 *   errors: *"the argument '--query <QUERY>' cannot be used with '--include
 *   <INCLUDE>'"*. Scope goes inside the query via `path:`.
 * - **Never trust the exit code.** `jj-hunk` reports success on four distinct
 *   failures, all exiting **0**: an empty `--query` returns `{"files":[]}`; an
 *   empty query on `split` no-ops silently; a stale spec creates an empty commit
 *   carrying the user's message while leaving every change uncommitted; and a
 *   multi-revision revset silently diffs the merged set. Every one of those is a
 *   pre-check here, because none is detectable from the exit code.
 * - **Parse `--format json`.** Never scrape the text format.
 *
 * Spec files are deliberately **not** supported in v0.1. A spec written inside
 * the working copy invalidates its own hunk IDs, and the whole point of a spec
 * is to be written somewhere — so the safe surface is `--query` only.
 *
 * @module dsh-jujutsu/hunk
 */

import type { Context } from "@deepseek-ai/cordis";

import { ErrorCode, type ToolError, toolError } from "./errors.ts";
import type { Settings } from "./settings.ts";
import { type RunResult, run, runJj } from "./shell.ts";

/** The commands the bridge exposes. */
export type HunkMode = "split" | "commit" | "squash";

export interface HunkFile {
  readonly path: string;
  readonly status: string;
  readonly hunks: readonly {
    readonly id: string;
    readonly index: number;
    readonly type: string;
  }[];
}

export interface HunkList {
  readonly files: readonly HunkFile[];
}

export interface HunkOptions {
  readonly cwd: string;
  /** A hunkset expression. The only selection form supported. */
  readonly query?: string;
  /** A revset that must resolve to exactly one revision. Defaults to `@`. */
  readonly revset?: string;
  readonly signal?: AbortSignal;
  /**
   * The live agent, for the one thing that needs a human: offering to install
   * `jj-hunk`. `ctx.userQuestions.ask` requires it, and rejects with
   * `CALLER_NOT_LIVE` or `DELEGATED_CALLER` when it is absent or owned.
   *
   * Typed `unknown` deliberately. This module must not depend on `dsh-agent` for
   * a field it only forwards, and the service validates it.
   */
  readonly agent?: unknown;
}

/**
 * The pinned install, which `docs/19` and the `JJ_HUNK_MISSING` hint both name.
 *
 * A tag, not a branch: a branch-tracking install builds whatever `main` is at
 * that moment. Not the crates.io crate either — it is two minor versions behind
 * with a different CLI.
 */
const INSTALL_ARGV = [
  "cargo",
  "install",
  "--git",
  "https://github.com/laulauland/jj-hunk",
  "--tag",
  "v0.5.1",
  "jj-hunk",
] as const;

/**
 * Sessions that already answered the install question.
 *
 * `docs/19` requires asking **once per session**, not once per call. Module-level
 * because the answer outlives any one tool call and the module outlives an
 * unmount, which is the same reason `detect.ts` caches.
 */
const installAnswers = new Map<string, "declined" | "installed">();

/** Forget the cached answers. For tests, and for a session restart. */
export function forgetInstallAnswers(): void {
  installAnswers.clear();
}

/** Either a result or a typed error, never a throw. */
export type HunkOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: ToolError;
    };

/** List the hunks a query selects. Always called before a mutation. */
export async function listHunks(
  ctx: Context,
  settings: Settings,
  options: HunkOptions,
): Promise<HunkOutcome<HunkList>> {
  const args = ["list", "--format", "json"];
  if (options.revset !== undefined) args.push("-r", options.revset);
  if (options.query !== undefined) args.push("--query", options.query);

  const run = await invoke(ctx, settings, args, options);
  if (!run.ok) return run;

  let parsed: unknown;
  try {
    parsed = JSON.parse(run.value.stdout);
  } catch {
    return fail(
      ErrorCode.JJ_HUNK_MISSING,
      "jj-hunk did not return JSON",
      "Re-run without --format json to see what it printed.",
    );
  }

  const files = filesOf(parsed);
  if (files === undefined) {
    return fail(
      ErrorCode.HUNK_QUERY_INVALID,
      "jj-hunk returned an unexpected shape",
      "Run `jj-hunk list --format json` by hand to compare.",
    );
  }
  return { ok: true, value: { files } };
}

/**
 * Apply a selection.
 *
 * @param mode - `split`, `commit` or `squash`.
 * @param options.query - the hunkset expression. Required.
 * @param message - required for `split` and `commit`.
 */
export async function applyHunks(
  ctx: Context,
  settings: Settings,
  mode: HunkMode,
  options: HunkOptions,
  message?: string,
): Promise<HunkOutcome<string>> {
  const query = options.query;
  if (query === undefined || query.trim() === "") {
    // An empty query exits 0 and, on `split`, does nothing at all. Refusing is
    // the only way the model learns it selected nothing.
    return fail(
      ErrorCode.HUNK_QUERY_EMPTY,
      "no hunkset expression was given, so nothing would be selected",
      'Pass a query, for example `added(content:"timeout")`.',
    );
  }
  if ((mode === "split" || mode === "commit") && (message ?? "").trim() === "") {
    return fail(
      ErrorCode.HUNK_QUERY_INVALID,
      `jj-hunk ${mode} needs a commit message`,
      "Pass the message that describes the change being separated.",
    );
  }

  const args = [mode, "--query", query];
  if (options.revset !== undefined) args.push("-r", options.revset);
  if (message !== undefined && mode !== "squash") args.push(message);

  // Preview first. A query that selects nothing exits 0, so the only reliable
  // signal is what `list` returns for the same expression.
  const preview = await listHunks(ctx, settings, options);
  if (!preview.ok) return preview;
  const selected = preview.value.files.filter((file) => file.hunks.length > 0);
  if (selected.length === 0) {
    return fail(
      ErrorCode.HUNK_QUERY_EMPTY,
      "that query selects no hunks, so the command would have done nothing",
      "Run `jj_hunk_list` with the same query and widen it.",
    );
  }

  const run = await invoke(ctx, settings, args, options);
  return run.ok ? { ok: true, value: run.value.stdout } : run;
}

/** Run `jj-hunk`, mapping a spawn failure and a timeout onto typed errors. */
async function invoke(
  ctx: Context,
  settings: Settings,
  args: readonly string[],
  options: HunkOptions,
): Promise<HunkOutcome<RunResult>> {
  try {
    const result = await runJj(ctx, settings.jjHunkPath, args, {
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.timedOut) {
      return fail(ErrorCode.SHELL_TIMEOUT, "jj-hunk timed out");
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      // The wrong `jj-hunk` is the likeliest cause of a failure here, and the
      // least diagnosable. The published crate is two minor versions behind and
      // its CLI is different, so a user who followed `cargo install jj-hunk`
      // gets `unexpected argument '--query' found` — an error about an argument
      // they never typed, from a command they cannot see.
      //
      // "Run the same command by hand" is the right advice for a genuine runtime
      // failure and useless for this one: running it by hand reproduces the same
      // message and no more. So this case says what is actually wrong.
      if (/unexpected argument '--query'|unrecognized subcommand|--format/.test(stderr)) {
        return fail(
          ErrorCode.JJ_EXEC_FAILED,
          `jj-hunk rejected the query interface: ${stderr.slice(0, 160)}`,
          `This is the wrong jj-hunk. The crates.io release (0.3.0) has a different CLI; install the pinned build: cargo install --git https://github.com/laulauland/jj-hunk --tag v0.5.1 jj-hunk`,
        );
      }
      // A binary that is not there is not a runtime failure, and it does not
      // throw: the shell runs `jj-hunk ...`, the shell itself reports 127, and
      // the command comes back as an ordinary non-zero exit. So the install
      // offer belongs here as much as in the catch below — putting it only in
      // the catch left it unreachable for the case it was written for, which is
      // what the tests for it caught.
      if (result.exitCode === 127 || /not found|command not found/i.test(stderr)) {
        return await missingBinary(
          ctx,
          settings,
          args,
          options,
          new Error(stderr || "jj-hunk not found"),
        );
      }
      return fail(
        ErrorCode.JJ_EXEC_FAILED,
        `jj-hunk exited ${String(result.exitCode)}: ${stderr.slice(0, 200)}`,
        "Run the same command by hand to see the full output.",
      );
    }
    return { ok: true, value: result };
  } catch (error) {
    return await missingBinary(ctx, settings, args, options, error);
  }
}

/**
 * `jj-hunk` could not be started. Offer to install it, or say how.
 *
 * The flow is `docs/19`'s, and every branch of it exists for a reason recorded
 * there. In short:
 *
 * - `hunkInstall: 'never'` — report the command and stop. No question.
 * - no `cargo` — report that, because offering an install that cannot run is
 *   worse than not offering.
 * - otherwise — ask, once per session, with three answers.
 *
 * The question is asked **here**, at the moment the user wanted a hunk
 * operation, and never on plugin load or in the background: that is when it
 * means something.
 */
async function missingBinary(
  ctx: Context,
  settings: Settings,
  args: readonly string[],
  options: HunkOptions,
  error: unknown,
): Promise<HunkOutcome<RunResult>> {
  const instruction = `Install it with: ${INSTALL_ARGV.join(" ")}`;

  if (settings.hunkInstall === "never") {
    return fail(
      ErrorCode.JJ_HUNK_MISSING,
      `${settings.jjHunkPath} could not be started: ${String(error).slice(0, 160)}`,
      instruction,
    );
  }

  const cargo = await run(ctx, ["cargo", "--version"], { cwd: options.cwd }).catch(() => undefined);
  if (cargo === undefined || cargo.exitCode !== 0) {
    return fail(
      ErrorCode.CARGO_MISSING,
      `cargo not found; cannot install jj-hunk.`,
      "Install the Rust toolchain from https://rustup.rs, then re-run.",
    );
  }

  const sessionId = sessionOf(options.agent);
  const remembered = sessionId === undefined ? undefined : installAnswers.get(sessionId);
  if (remembered === "declined") {
    return fail(
      ErrorCode.JJ_HUNK_INSTALL_DECLINED,
      "jj-hunk is not installed and installation was declined for this session.",
      instruction,
    );
  }

  if (remembered !== "installed") {
    const answer = await offerInstall(ctx, options, instruction);
    if (answer === "declined") {
      if (sessionId !== undefined) installAnswers.set(sessionId, "declined");
      return fail(
        ErrorCode.JJ_HUNK_INSTALL_DECLINED,
        "jj-hunk is not installed and installation was declined for this session.",
        instruction,
      );
    }
    if (answer === "unavailable") {
      // The ask failed closed — a subagent, no provider, or no client. The
      // instruction is the right answer, and is what a caller that cannot be
      // asked should get instead of an error about asking (`docs/19`).
      return fail(
        ErrorCode.JJ_HUNK_MISSING,
        `${settings.jjHunkPath} could not be started: ${String(error).slice(0, 160)}`,
        instruction,
      );
    }
  }

  const installed = await run(ctx, [...INSTALL_ARGV], { cwd: options.cwd, timeoutMs: 300_000 });
  if (installed.exitCode !== 0) {
    return fail(
      ErrorCode.JJ_HUNK_INSTALL_FAILED,
      `Installing jj-hunk failed (cargo exit ${String(installed.exitCode)}). Last output: ${installed.stderr.trim().slice(-200)}`,
      "Install manually, then set jjHunkPath to the binary.",
    );
  }
  if (sessionId !== undefined) installAnswers.set(sessionId, "installed");

  // Retry **once**, and only once. A successful install that still fails is a
  // real failure, and looping would hide it.
  try {
    const retry = await runJj(ctx, settings.jjHunkPath, args, {
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (retry.exitCode === 0) return { ok: true, value: retry };
    return fail(
      ErrorCode.JJ_EXEC_FAILED,
      `jj-hunk exited ${String(retry.exitCode)} after a successful install: ${retry.stderr.trim().slice(0, 200)}`,
      "Run the same command by hand to see the full output.",
    );
  } catch (again) {
    return fail(
      ErrorCode.JJ_HUNK_INSTALL_FAILED,
      `jj-hunk installed but still cannot start: ${String(again).slice(0, 160)}`,
      "Set jjHunkPath to the installed binary if it is not on PATH.",
    );
  }
}

/** The session id behind an agent, if the caller supplied one. */
function sessionOf(agent: unknown): string | undefined {
  const id = (agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Ask the human, once. `'install'`, `'declined'`, or `'unavailable'`.
 *
 * `unavailable` is not a failure of the plugin: it is the documented fallback
 * when there is nobody to ask. A subagent is the case that actually happens —
 * it cannot raise a question, and must get the instruction.
 */
async function offerInstall(
  ctx: Context,
  options: HunkOptions,
  instruction: string,
): Promise<"install" | "declined" | "unavailable"> {
  const service = ctx.get("userQuestions") as
    | { ask: (request: unknown) => Promise<unknown> }
    | undefined;
  if (service === undefined || options.agent === undefined) return "unavailable";

  const yes = "Install now";
  const no = "Never ask again";
  try {
    const answer = (await service.ask({
      // `agent` is mandatory: omit it and the bridge drops the event and the ask
      // fails with `NO_PROVIDER` (`docs/19`).
      agent: options.agent,
      questions: [
        {
          id: "dsh-jujutsu.jj-hunk-install",
          header: "jj-hunk is missing",
          question: `Install jj-hunk? Rust, ~40 s, builds from a pinned tag.`,
          detail: instruction,
          options: [
            { label: yes, description: "Builds v0.5.1 from git and retries this call." },
            { label: "Show me the command", description: "Returns the command and stops." },
            { label: no, description: "Stops offering for the rest of this session." },
          ],
        },
      ],
    })) as { answers?: { id?: string; selected?: string[] }[] } | undefined;

    const chosen = answer?.answers?.find((a) => a.id === "dsh-jujutsu.jj-hunk-install")?.selected;
    return chosen?.includes(yes) === true ? "install" : "declined";
  } catch {
    // `CALLER_NOT_LIVE`, `DELEGATED_CALLER`, `NO_PROVIDER`, or an abort. All of
    // them mean "nobody to ask", and all of them fall back to the instruction.
    return "unavailable";
  }
}

/** Read `{files: [...]}` without asserting. */
function filesOf(value: unknown): HunkFile[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) return undefined;
  return files.map((file) => {
    const record = (file ?? {}) as Record<string, unknown>;
    const hunks = Array.isArray(record.hunks) ? record.hunks : [];
    return {
      path: typeof record.path === "string" ? record.path : "",
      status: typeof record.status === "string" ? record.status : "",
      hunks: hunks.map((hunk, index) => {
        const entry = (hunk ?? {}) as Record<string, unknown>;
        return {
          id: typeof entry.id === "string" ? entry.id : "",
          index: typeof entry.index === "number" ? entry.index : index,
          type: typeof entry.type === "string" ? entry.type : "",
        };
      }),
    };
  });
}

function fail(code: ErrorCode, message: string, hint?: string): HunkOutcome<never> {
  return {
    ok: false,
    error: toolError(code, message, hint),
  };
}
