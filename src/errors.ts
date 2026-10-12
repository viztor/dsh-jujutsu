/**
 * Error codes and the shapes the model sees.
 *
 * Two channels, and the difference matters (`docs/26-preflight-and-error-taxonomy.md` §0):
 *
 * - **Tool channel** — the eleven `jj` tools return
 *   `{ error: { code, message, hint? } }` as their value. `info.code` on a guard
 *   `deny` is **not model-visible**; only `reason` is, so every guard message
 *   must be self-contained.
 * - **Guard channel** — `reason` on the `PreToolDecision`, plus the explanation
 *   attached from `post-execute`.
 *
 * @module dsh-jujutsu/errors
 */

/** Every code this plugin can produce. Values match `docs/26` Part B. */
export const ErrorCode = {
  NOT_JJ_WORKSPACE: "NOT_JJ_WORKSPACE",
  JJ_MISSING: "JJ_MISSING",
  JJ_VERSION_TOO_OLD: "JJ_VERSION_TOO_OLD",
  JJ_IDENTITY_UNCONFIGURED: "JJ_IDENTITY_UNCONFIGURED",
  JJ_REPO_UNREADABLE: "JJ_REPO_UNREADABLE",
  JJ_REPO_BROKEN: "JJ_REPO_BROKEN",
  JJ_CONFLICTS_PRESENT: "JJ_CONFLICTS_PRESENT",
  JJ_EXEC_FAILED: "JJ_EXEC_FAILED",
  /**
   * A multi-revision `jj` query returned something that is not the
   * newline-delimited JSON its template promised.
   *
   * This was emitted and asserted in a test without ever being declared — a code
   * that existed only as a string literal, outside the vocabulary meant to hold
   * every one of them. `tools.ts` explains why it matters: `json(self)` emits no
   * separator, so a template that forgets `++ "\n"` produces output no parser
   * can split, and the failure is silent at the `jj` end.
   */
  JJ_OUTPUT_NOT_JSON: "JJ_OUTPUT_NOT_JSON",
  JJ_HUNK_MISSING: "JJ_HUNK_MISSING",
  JJ_HUNK_VERSION_TOO_OLD: "JJ_HUNK_VERSION_TOO_OLD",
  JJ_HUNK_INSTALL_DECLINED: "JJ_HUNK_INSTALL_DECLINED",
  JJ_HUNK_INSTALL_FAILED: "JJ_HUNK_INSTALL_FAILED",
  CARGO_MISSING: "CARGO_MISSING",
  WORKSPACE_ROOT_UNRESOLVED: "WORKSPACE_ROOT_UNRESOLVED",
  REVSET_INVALID: "REVSET_INVALID",
  REVSET_NOT_SINGLE: "REVSET_NOT_SINGLE",
  HUNK_QUERY_EMPTY: "HUNK_QUERY_EMPTY",
  HUNK_QUERY_INVALID: "HUNK_QUERY_INVALID",
  HUNK_SPEC_INVALID: "HUNK_SPEC_INVALID",
  HUNK_SPEC_STALE: "HUNK_SPEC_STALE",
  SHELL_EXEC_FAILED: "SHELL_EXEC_FAILED",
  SHELL_TIMEOUT: "SHELL_TIMEOUT",
  FS_ERROR: "FS_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** The value shape a `jj` tool returns on failure. */
export interface ToolError {
  readonly error: {
    readonly code: ErrorCode;
    /** What happened, in one sentence. */
    readonly message: string;
    /** The next command to run, where one exists. */
    readonly hint?: string;
  };
}

/**
 * Build a tool error.
 *
 * `hint` is not optional decoration: every failure the plugin reports should
 * name the next command, the same way every guard denial does.
 */
export function toolError(code: ErrorCode, message: string, hint?: string): ToolError {
  return { error: { code, message, ...(hint === undefined ? {} : { hint }) } };
}

/*
 * There is deliberately no `FAIL_OPEN` set here.
 *
 * One existed and nothing consumed it. The fail-open policy is real, but it is
 * implemented as a **blanket** `try { … } catch { return next(); }` in
 * `guard.ts`, not as a decision per code: the guard cannot distinguish a benign
 * failure from a serious one at the point it catches, because the failure may
 * have come from anywhere in the detection path. A set naming seven codes read
 * as though that selective handling existed, which made the code look more
 * careful than it was. The discriminator is recorded in `docs/26` §C.
 */
