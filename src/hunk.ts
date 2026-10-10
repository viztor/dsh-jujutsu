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
import { type RunResult, runJj } from "./shell.ts";

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
}

/** Either a result or a typed error, never a throw. */
export type HunkOutcome<T> = { readonly ok: true; readonly value: T } | {
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
      return fail(
        ErrorCode.JJ_EXEC_FAILED,
        `jj-hunk exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 200)}`,
        "Run the same command by hand to see the full output.",
      );
    }
    return { ok: true, value: result };
  } catch (error) {
    return fail(
      ErrorCode.JJ_HUNK_MISSING,
      `${settings.jjHunkPath} could not be started: ${String(error).slice(0, 160)}`,
      `Install it with: cargo install --git https://github.com/laulauland/jj-hunk jj-hunk`,
    );
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
