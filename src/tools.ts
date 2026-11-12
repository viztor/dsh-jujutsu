/**
 * The eleven first-class `jj` tools.
 *
 * **No tool returns prose.** `jj` is a graph-and-prose CLI by default, and an
 * agent that parses `jj log`'s graph output is an agent that will mis-parse it.
 * `jj` supports structured output natively — verified on 0.46.0:
 *
 * ```
 * $ jj log --no-graph -T 'json(self)' -r @
 * {"commit_id":"23ddaf17…","parents":["3c02384c…"],"change_id":"zwtutzwn…", …}
 * ```
 *
 * The full specification — arguments, return shapes, backing commands — is
 * `docs/18-tool-surface.md`; the descriptions are `docs/25-prompt-copy.md` §3.
 *
 * Two conventions that are not optional:
 *
 * - **Tools return `changeId` and `commitId`, and accept `changeId`.** Change IDs
 *   survive rewrites; commit IDs do not.
 * - **Every mutating tool echoes the resulting state**, so the model never has to
 *   re-read to chain a step.
 *
 * ## The output schema is `{ type: 'json' }`, deliberately
 *
 * A per-tool typed output schema would be better, and it is the obvious next
 * refinement. It is not here yet because the value of a typed schema is that it
 * constrains the *renderer*, and the renderer is already a pure
 * `JSON.stringify` — so the cost is real and the benefit is deferred until a
 * presenter exists. `docs/18` §"The schema budget" explains why the input
 * schemas, which the model pays for on every request, are typed and tight.
 *
 * @module dsh-jujutsu/tools
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { basename, resolve as resolvePath } from "node:path";

import { ErrorCode, type ToolError, toolError } from "./errors.ts";
import { applyHunks, listHunks } from "./hunk.ts";
import type { Settings } from "./settings.ts";
import { ShellUnavailableError, readOnly, run, runJj, shellQuote } from "./shell.ts";
import { currentWorkspaceNameFrom } from "./workspace.ts";

/**
 * The tool set, in registration order. The tier lists below decide which subset
 * a given `toolset` setting actually mounts; `TOOL_NAMES` is the full surface.
 */
export const MINIMAL_TOOL_NAMES = [
  "jj_status",
  "jj_log",
  "jj_diff",
  "jj_new",
  "jj_hunk_apply",
] as const;

export const CORE_TOOL_NAMES = [
  "jj_status",
  "jj_log",
  "jj_diff",
  "jj_op_log",
  "jj_new",
  "jj_describe",
  "jj_squash",
  "jj_bookmark",
  "jj_op_restore",
  "jj_hunk_list",
  "jj_hunk_apply",
  "jj_workspace",
  "jj_test",
  "jj_repair",
] as const;

export const TOOL_NAMES = [
  ...CORE_TOOL_NAMES,
  "jj_show",
  "jj_file",
  "jj_evolog",
  "jj_commit",
  "jj_edit",
  "jj_history",
  "jj_op",
  "jj_publish",
  "jj_fix",
  "jj_sparse",
  "jj_doctor",
  "jj_coordinate",
  "jj_group",
  "jj_sign",
] as const;

/**
 * The shared output projection: a lossless JSON value rendered as JSON text.
 *
 * The model gets parseable structure, not a prose summary — which is the whole
 * reason these tools exist rather than the model shelling out.
 */
const JSON_OUTPUT = {
  schema: { type: "json" as const },
  render: (_args: unknown, value: unknown) => [
    { type: "text" as const, text: JSON.stringify(value, null, 2) },
  ],
};

/**
 * The validated arguments, as an untyped bag.
 *
 * `defineTool` would infer these precisely if each tool were defined inline.
 * Through the shared factory it cannot, so each handler reads the fields it
 * needs and checks their types — which is what a tool handler should do anyway,
 * because a raw patch row can skip schema validation.
 */
type ToolArgs = Record<string, unknown>;

/** The directory a tool call runs in. */
function cwdOf(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: { header?: { cwd?: string } } } }).agent;
  return agent?.session?.header?.cwd;
}

/**
 * The live agent behind a tool call, forwarded opaquely.
 *
 * Only one thing needs it: `ctx.userQuestions.ask` refuses to run without it, and
 * the offer to install `jj-hunk` is the only human interaction this plugin has.
 * Typed `unknown` on purpose — `hunk.ts` forwards it and the service validates
 * it, so neither module depends on `dsh-agent` for a field it does not read.
 */
function agentOf(exec: unknown): { agent?: unknown } {
  const agent = (exec as { agent?: unknown }).agent;
  return agent === undefined ? {} : { agent };
}

/** The `execute` every tool definition exposes: arguments in, a JSON value out. */
type ToolHandler = (args: ToolArgs, exec: unknown) => Promise<unknown>;

/**
 * Wrap a handler so it runs against the session's workspace root.
 *
 * All eleven tools refuse an unresolved root identically, and the refusal is the
 * bare code — no `message`, no `hint` — which makes the shape model-visible and
 * not an implementation detail. Eleven hand-written copies of that two-line
 * preamble were eleven chances for one tool to drift from it.
 */
function onWorkspaceRoot(
  run: (args: ToolArgs, cwd: string, exec: unknown) => Promise<unknown>,
): ToolHandler {
  return async (args, exec) => {
    const cwd = cwdOf(exec);
    if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
    return run(args, cwd, exec);
  };
}

/**
 * The oldest `jj` whose templates this plugin's output can rely on.
 *
 * `json(self)` emits no separator, so `parseJsonLines` splits on newlines the
 * plugin adds itself; the conflict query and `--summary` shapes were verified
 * against 0.46.0 and not before it.
 */
const MINIMUM_JJ = [0, 46, 0] as const;

/**
 * Whether the running `jj` is new enough — cached, because it cannot change
 * within a process and a probe per tool call would be waste.
 *
 * `docs/26` asks for a version **and** a capability probe: a version string alone
 * can be wrong (a wrapper, a shim, a vendored build). The capability is the thing
 * actually relied on, so a version below the floor is confirmed by running the
 * template once before it is reported.
 */
let versionChecked: Promise<string | undefined> | undefined;

function checkJjVersion(
  ctx: Context,
  settings: Settings,
  cwd: string,
): Promise<string | undefined> {
  versionChecked ??= (async () => {
    let result;
    try {
      result = await runJj(ctx, settings.jjPath, ["--version"], { cwd });
    } catch {
      return undefined;
    }
    if (result.exitCode !== 0) return undefined;

    const match = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
    if (match === null) return undefined;
    const found = [Number(match[1]), Number(match[2]), Number(match[3])];
    const older = found.findIndex((part, i) => part !== MINIMUM_JJ[i]);
    if (older === -1 || found[older]! > MINIMUM_JJ[older]!) return undefined;

    // Below the floor: confirm the capability is actually missing before blaming
    // the version, so a shim that reports an odd version but works is not refused.
    try {
      // `json(self)` with no separator is exactly the trap the rest of this file
      // documents, and the test for it caught this line: the template must end
      // with `++ "\n"` even when it emits one object.
      const probe = await runJj(
        ctx,
        settings.jjPath,
        ["log", "--no-graph", "-r", "@", "-T", 'json(self) ++ "\\n"'],
        { cwd },
      );
      if (probe.exitCode === 0) return undefined;
    } catch {
      return undefined;
    }
    return `${match[0]}`;
  })();
  return versionChecked;
}

/** Forget the cached version. For tests. */
export function forgetJjVersion(): void {
  versionChecked = undefined;
}

/** Run `jj` and return its raw stdout, or a typed error object. */
async function jj(
  ctx: Context,
  settings: Settings,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<unknown> {
  const broken = await repoRefusal(ctx, cwd);
  if (broken !== undefined) return broken;

  const tooOld = await checkJjVersion(ctx, settings, cwd);
  if (tooOld !== undefined) {
    return {
      error: {
        code: ErrorCode.JJ_VERSION_TOO_OLD,
        message: `jj ${tooOld} is older than the supported floor 0.46.0; the required template features are missing.`,
        hint: "Upgrade jj. The Git guard still works; only the jj_* tools are unavailable.",
      },
    };
  }

  try {
    const result = await runJj(ctx, settings.jjPath, args, {
      cwd,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      // Two of `jj`'s own failures have declared codes, and reporting them as
      // `JJ_EXEC_FAILED` made a caller unable to tell them apart from a crash.
      // Both messages are `jj`'s own, verified against 0.46.0.
      if (/There is no jj repo|not a Jujutsu/i.test(stderr)) {
        return {
          error: {
            code: ErrorCode.NOT_JJ_WORKSPACE,
            message: `Not a Jujutsu workspace: ${stderr.slice(0, 200)}`,
            hint: "Initialise one with `jj git init`, or `jj git init --colocate` to keep Git tooling working.",
          },
        };
      }
      if (/Failed to parse revset/i.test(stderr)) {
        return {
          error: {
            code: ErrorCode.REVSET_INVALID,
            message: `Invalid revset: ${stderr.slice(0, 200)}`,
            hint: "Run `jj log -r <revset>` to check it, or see `jj help revsets`.",
          },
        };
      }
      return {
        error: {
          code: ErrorCode.JJ_EXEC_FAILED,
          message: `jj exited ${String(result.exitCode)}: ${stderr.slice(0, 300)}`,
          hint: `Run \`jj ${args.join(" ")}\` by hand to see the full output.`,
        },
      };
    }
    return result.stdout;
  } catch (error) {
    // "No process could start" and "jj is not installed" are different failures
    // with different advice, and only one of them is about `jj`.
    if (error instanceof ShellUnavailableError) {
      return {
        error: {
          code: ErrorCode.SHELL_EXEC_FAILED,
          message: "No shell service is mounted, so no command could run.",
          hint: "Enable the harness shell service; the jj tools need it to execute anything.",
        },
      };
    }
    return {
      error: {
        code: ErrorCode.JJ_MISSING,
        message: `${settings.jjPath} could not be started: ${String(error).slice(0, 160)}`,
        hint: "Install jj: brew install jj",
      },
    };
  }
}

/**
 * Run `jj` and parse its output as one JSON object per line.
 *
 * **`json(self)` does NOT separate its objects.** Verified against 0.46.0: with
 * `-T 'json(self)'` over two revisions, `jj log --no-graph` writes both objects
 * back to back with **no newline and no trailing newline** — `wc -l` reports 0.
 * Splitting that on `\n` yields one line holding two concatenated objects, and
 * `JSON.parse` fails with "Unexpected non-whitespace character after JSON".
 *
 * Every template that can emit more than one revision therefore ends with
 * `++ "\n"`, which is what makes the output newline-delimited. An earlier
 * revision of this file asserted the opposite in this comment and omitted the
 * newline, so `jj_log`, `jj_status` and `jj_op_log` returned
 * `JJ_OUTPUT_NOT_JSON` for every multi-revision query. Unit tests could not see
 * it: they fed `parseJsonLines` strings that already had newlines. The
 * end-to-end test, which runs real `jj`, found it immediately.
 */
export function parseJsonLines(
  raw: string,
  command: string,
): { ok: true; values: unknown[] } | { ok: false; error: unknown } {
  const values: unknown[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      values.push(JSON.parse(text));
    } catch {
      return {
        ok: false,
        error: {
          code: ErrorCode.JJ_OUTPUT_NOT_JSON,
          message: `jj returned a line that is not JSON: ${text.slice(0, 120)}`,
          hint: `Run \`${command}\` by hand to see the raw output.`,
        },
      };
    }
  }
  return { ok: true, values };
}

async function jjJson(
  ctx: Context,
  settings: Settings,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<unknown> {
  const raw = await jj(ctx, settings, cwd, args, signal);
  if (typeof raw !== "string") return raw; // already an error object
  const parsed = parseJsonLines(raw, `jj ${args.join(" ")}`);
  return parsed.ok ? parsed.values : parsed.error;
}

/**
 * Parse `jj diff --summary` into structured entries.
 *
 * The output is one `<status> <path>` line per file — `M src/a.ts`,
 * `A new.txt`, `D gone.txt`. Under an output schema that promises a JSON value,
 * returning that prose would break the promise the same way raw NDJSON did.
 *
 * A rename renders as `R {old => new}`; the whole remainder is kept as `path`
 * rather than parsed, because the brace form is a display format and splitting
 * it would invent structure jj did not provide.
 */
export function parseSummary(raw: string): { status: string; path: string }[] {
  const entries: { status: string; path: string }[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    const space = text.indexOf(" ");
    if (space === -1) entries.push({ status: text, path: "" });
    else entries.push({ status: text.slice(0, space), path: text.slice(space + 1) });
  }
  return entries;
}

/**
 * Parse `jj config list user` for a complete identity.
 *
 * Measured on 0.46.0: with nothing configured the command prints
 * `Warning: No matching config key for: user` and exits **0**, so the exit code
 * is not a signal. A configured identity prints `user.name = "…"` and
 * `user.email = "…"`. Both must be present and non-empty — `jj` accepts a name
 * without an email and still refuses to push.
 */
export function parseIdentity(raw: string): boolean {
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const match = /^\s*(user\.(?:name|email))\s*=\s*"?([^"]*)"?\s*$/.exec(line);
    if (match === null) continue;
    if ((match[2] ?? "").trim() !== "") seen.add(match[1] ?? "");
  }
  return seen.has("user.name") && seen.has("user.email");
}

/**
 * Is a `jj` identity configured?
 *
 * An empty identity is not a warning, it is a trap: `jj` creates the commit and
 * the commit cannot be pushed —
 *
 * > Warning: Name and email not configured. Until configured, your commits will
 * > be created with the empty identity, and can't be pushed to remotes.
 *
 * — so every command that **mints** a commit is refused rather than run. The
 * commands that *preserve* an author (`jj describe`, `jj squash`) are unaffected
 * and are not checked.
 */
async function identityConfigured(
  ctx: Context,
  settings: Settings,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const raw = await jj(ctx, settings, cwd, readOnly(["config", "list", "user"]), signal);
  return typeof raw === "string" ? parseIdentity(raw) : undefined;
}

/** The refusal every commit-creating tool returns when the identity is unset. */
function identityRefusal(): ToolError {
  return {
    error: {
      code: ErrorCode.JJ_IDENTITY_UNCONFIGURED,
      message:
        "jj user.name/user.email are not configured, so this would create a commit with the empty identity that cannot be pushed.",
      hint: 'Configure it first: jj config set --user user.name "Your Name" && jj config set --user user.email "you@example.com"',
    },
  };
}

/**
 * The working copy's conflict flag.
 *
 * **`json(self)` does not carry it** — verified against 0.46.0, where the object
 * has exactly `commit_id`, `parents`, `change_id`, `description`, `author` and
 * `committer`. `jj resolve --list` is not a substitute either: it exits **0**
 * whether or not a conflict exists. The only reliable signal is the `conflict`
 * template keyword, so it is a second query.
 *
 * This matters because `jj new` **propagates** a conflict rather than escaping
 * it, so an agent that does not know it is conflicted will build on top of one.
 */
async function conflictOf(
  ctx: Context,
  settings: Settings,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const raw = await jj(
    ctx,
    settings,
    cwd,
    readOnly(["log", "--no-graph", "-T", "conflict", "-r", "@"]),
    signal,
  );
  return typeof raw === "string" ? raw.trim() === "true" : undefined;
}

/** The latest operation id, read without creating one. */
async function latestOpId(
  ctx: Context,
  settings: Settings,
  cwd: string,
): Promise<string | undefined> {
  const raw = await jj(
    ctx,
    settings,
    cwd,
    readOnly(["op", "log", "--limit", "1", "--no-graph", "-T", "id.short()"]),
  );
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  return id.length > 0 ? id : undefined;
}

/** Change ids that are divergent, read without snapshotting. */
async function divergentOf(
  ctx: Context,
  settings: Settings,
  cwd: string,
): Promise<string[] | undefined> {
  const raw = await jj(
    ctx,
    settings,
    cwd,
    readOnly(["log", "--no-graph", "-T", 'change_id.short() ++ "\\n"', "-r", "divergent()"]),
  );
  if (typeof raw !== "string") return undefined;
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Bookmarks, read without snapshotting. */
async function bookmarkRows(
  ctx: Context,
  settings: Settings,
  cwd: string,
): Promise<{ name: string; target: string[] }[] | undefined> {
  const rows = await jjJson(
    ctx,
    settings,
    cwd,
    readOnly(["bookmark", "list", "-T", 'json(self) ++ "\\n"']),
  );
  if (!Array.isArray(rows)) return undefined;
  return rows as { name: string; target: string[] }[];
}

/** The current workspace's name, parsed from the plain `workspace list` output. */
async function currentWorkspaceName(
  ctx: Context,
  settings: Settings,
  cwd: string,
): Promise<string | undefined> {
  const raw = await jj(ctx, settings, cwd, readOnly(["workspace", "list"]));
  return typeof raw === "string" ? currentWorkspaceNameFrom(raw) : undefined;
}

/**
 * Which other workspace has this change as its working copy?
 *
 * `jj_edit` is the dangerous case: entering another agent's `@` would make two
 * workspaces amend the same change. The check compares against every
 * workspace's target, not a bookmark that may be stale.
 */
async function workspaceOwningChange(
  ctx: Context,
  settings: Settings,
  cwd: string,
  changeId: string,
): Promise<string | undefined> {
  const rows = await jjJson(
    ctx,
    settings,
    cwd,
    readOnly(["workspace", "list", "-T", 'json(self) ++ "\\n"']),
  );
  if (!Array.isArray(rows)) return undefined;
  const current = await currentWorkspaceName(ctx, settings, cwd);
  for (const row of rows as { name: string; target: { change_id: string } }[]) {
    if (row.name === current) continue;
    if (row.target.change_id === changeId) return row.name;
  }
  return undefined;
}

/**
 * Do any of these revsets resolve to another workspace's working copy?
 *
 * Used by the history-rewriting tools. `advise` returns a warning the model
 * sees; `enforce` returns a typed refusal. The check is per exact change id, so
 * a broad revset that merely contains a shared ancestor is not refused — only
 * targeting the workspace's own `@` is.
 */
async function ownershipIssue(
  ctx: Context,
  settings: Settings,
  cwd: string,
  revsets: readonly string[],
): Promise<{ error?: ToolError; warning?: string }> {
  if (settings.coordination === "off") return {};
  const owners = new Set<string>();
  for (const revset of revsets) {
    if (revset.length === 0) continue;
    const rows = await jjJson(
      ctx,
      settings,
      cwd,
      readOnly(["log", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", revset]),
    );
    if (!Array.isArray(rows)) continue;
    for (const row of rows as { change_id?: string }[]) {
      if (typeof row.change_id !== "string") continue;
      const owner = await workspaceOwningChange(ctx, settings, cwd, row.change_id);
      if (owner !== undefined) owners.add(owner);
    }
  }
  if (owners.size === 0) return {};
  const message = `Target touches workspace(s) ${[...owners].join(", ")}'s working copy.`;
  if (settings.coordination === "enforce") {
    return {
      error: toolError(
        ErrorCode.JJ_CHANGE_OWNED_BY_WORKSPACE,
        message,
        "Work in that workspace, or set coordination to advise/off to override.",
      ),
    };
  }
  return { warning: message };
}

/**
 * Conflicted paths, when there are any.
 *
 * `jj resolve --list` exits **2** with "No conflicts found at this revision"
 * (measured on 0.46.0), so a non-zero exit is not automatically an error. Any
 * other failure returns `undefined` and the status tool reports `null`.
 */
async function conflictedPaths(
  ctx: Context,
  settings: Settings,
  cwd: string,
): Promise<string[] | undefined> {
  const result = await runJj(ctx, settings.jjPath, readOnly(["resolve", "--list"]), {
    cwd,
    timeoutMs: 15_000,
  });
  if (result.exitCode === 0) {
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  if (/No conflicts found/i.test(result.stderr)) return [];
  return undefined;
}

/**
 * Refuse to build on a conflicted working copy.
 *
 * `jj new` **propagates** a conflict rather than escaping it, and a squash or a
 * hunk split rewrites the conflicted tree. An agent that does not know it is
 * conflicted will build on top of one and hand back a change nobody can review,
 * which is what `docs/26`'s P12 is for.
 *
 * Only the tools that rewrite `@` check this. `jj_describe` edits a message and
 * `jj_bookmark` moves a ref; neither touches the conflicted tree, and refusing
 * them would block work that is safe.
 */
async function conflictRefusal(
  ctx: Context,
  settings: Settings,
  cwd: string,
): Promise<ToolError | undefined> {
  if ((await conflictOf(ctx, settings, cwd)) !== true) return undefined;
  return {
    error: {
      code: ErrorCode.JJ_CONFLICTS_PRESENT,
      message: "The working copy has unresolved conflicts, so this would build on top of them.",
      hint: "Resolve them first (`jj resolve --list`, then `jj resolve <path>`), or start from a clean revision.",
    },
  };
}

/**
 * Whether the repository's own layout is intact — `docs/26`'s P9.
 *
 * A colocated repository records where its Git directory is in
 * `.jj/repo/store/git_target`. When that path no longer exists, `jj` itself fails
 * with something generic, and the useful statement is the specific one.
 *
 * Two rules from `docs/26`, both load-bearing:
 *
 * - `git_target` containing the literal `git` means a **native** repo, which has
 *   no Git directory to check. Nothing to report.
 * - A missing or unparseable `git_target` is **unknown, not broken**. The file is
 *   an internal layout detail, verified on 0.46.0 and no other version, so
 *   refusing on its absence would refuse repositories that are fine.
 */
const repoChecks = new Map<string, ToolError | undefined>();

/** Forget the cached repository probes. For tests. */
export function forgetRepoChecks(): void {
  repoChecks.clear();
}

async function repoRefusal(ctx: Context, cwd: string): Promise<ToolError | undefined> {
  // Once per directory per process. The layout cannot change under a running
  // tool call, and an fs probe on every `jj_*` call would be waste.
  if (repoChecks.has(cwd)) return repoChecks.get(cwd);
  const result = await probeRepo(ctx, cwd);
  repoChecks.set(cwd, result);
  return result;
}

async function probeRepo(ctx: Context, cwd: string): Promise<ToolError | undefined> {
  const fs = ctx.get("fs") as
    | {
        resolve: (p: string) => Promise<unknown>;
        readText: (t: unknown) => Promise<string>;
        stat: (t: unknown) => Promise<{ type?: string } | undefined>;
      }
    | undefined;
  if (fs === undefined) return undefined;

  const root = cwd.replace(/\/+$/, "") || "/";
  const repoDir = `${root}/.jj/repo`;

  let target: unknown;
  let text: string;
  try {
    target = await fs.resolve(`${repoDir}/store/git_target`);
    const info = await fs.stat(target);
    // Absent means native, or a layout this plugin does not know. Either way it
    // is not evidence of breakage.
    if (info === undefined) return undefined;
    text = (await fs.readText(target)).trim();
  } catch {
    // `.jj` is there but cannot be read. That IS reportable, and different from
    // "the file is not there".
    return {
      error: {
        code: ErrorCode.JJ_REPO_UNREADABLE,
        message: `The jj repo at ${repoDir} exists but could not be read.`,
        hint: "Check permissions on the .jj directory.",
      },
    };
  }

  if (text === "git") return undefined;
  if (text === "") return undefined;

  // A relative path from `.jj/repo/store` to the Git directory.
  const resolved = text.startsWith("/") ? text : `${repoDir}/store/${text}`;
  try {
    const gitInfo = await fs.stat(await fs.resolve(resolved));
    if (gitInfo !== undefined) return undefined;
  } catch {
    return undefined;
  }

  return {
    error: {
      code: ErrorCode.JJ_REPO_BROKEN,
      message: `The jj repo at ${root} points at a Git directory that does not exist (${text}).`,
      hint: "The Git directory was probably deleted. Re-create it, or re-init the repo with `jj git init --colocate`.",
    },
  };
}

/**
 * Build the eleven definitions.
 *
 * Separate from registration so a test can validate every definition against the
 * real `defineTool` without a live registry — which is exactly the check that
 * would have caught a schema the registry refuses.
 */
export function buildToolDefinitions(
  ctx: Context,
  settings: Settings,
): readonly Record<string, unknown>[] {
  /**
   * One shared factory for eleven definitions whose output schema is identical.
   *
   * `defineTool` is generic over the parameter and output specs, and that
   * inference does not survive being funnelled through one helper: the value
   * type collapses to `never`, and the parameter schema alone trips TS2321
   * ("excessive stack depth"). The schema here is a fixed `{ type: 'json' }`
   * for every tool, so the erased type carries no information worth keeping —
   * which is why a single `any` at this boundary is honest rather than lazy.
   * Every handler is still written against its own literal definition.
   */
  const definitions: Record<string, unknown>[] = [];
  const register = (definition: Record<string, unknown>) => {
    definitions.push(definition);
  };

  register({
    name: "jj_status",
    description:
      "Show the Jujutsu working copy: the current revision, its parent, conflicts, divergence, and the latest operation id. By default it does not snapshot disk edits; pass snapshot:true to capture them and get a fresh checkpoint.",
    parameters: {
      snapshot: {
        type: "boolean",
        description:
          "Capture disk edits into @ first (jj util snapshot), then read. Default false: a read never mutates the repository.",
      },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const snapshot = args.snapshot === true;
      if (snapshot) {
        const result = await runJj(ctx, settings.jjPath, ["util", "snapshot"], { cwd });
        if (result.exitCode !== 0) {
          return toolError(
            ErrorCode.JJ_SNAPSHOT_FAILED,
            `jj util snapshot exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 200)}`,
            "Run `jj util snapshot` by hand to see the full output.",
          );
        }
      }
      const revisions = await jjJson(
        ctx,
        settings,
        cwd,
        readOnly(["log", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", "@|@-"]),
      );
      if (!Array.isArray(revisions)) return revisions; // error object
      const [conflict, opId, divergent, conflicts, workspaceName, bookmarks] = await Promise.all([
        conflictOf(ctx, settings, cwd),
        latestOpId(ctx, settings, cwd),
        divergentOf(ctx, settings, cwd),
        conflictedPaths(ctx, settings, cwd),
        currentWorkspaceName(ctx, settings, cwd),
        bookmarkRows(ctx, settings, cwd),
      ]);
      const owner =
        workspaceName === undefined || settings.agentBookmarkPrefix === ""
          ? undefined
          : (bookmarks ?? []).find(
              (entry) => entry.name === `${settings.agentBookmarkPrefix}${workspaceName}`,
            )?.name;
      return {
        conflict: conflict ?? null,
        revisions,
        ...(opId === undefined ? {} : { opId }),
        divergent: divergent ?? [],
        conflicts: conflicts ?? [],
        workspace:
          workspaceName === undefined ? null : { name: workspaceName, owner: owner ?? null },
        snapshot,
      };
    }),
  });

  register({
    name: "jj_log",
    description: "Show revision history as JSON, newest first.",
    parameters: {
      revset: { type: "string", description: "A revset, e.g. `::@` or `all()`." },
      limit: { type: "integer", description: "Maximum revisions to return." },
      atOp: {
        type: "string",
        description:
          "Read the repository as it was at this operation id (implies a read-only view).",
      },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const revset = typeof args.revset === "string" ? args.revset : "::@";
      const argv =
        typeof args.atOp === "string"
          ? ["--at-op", args.atOp, "log", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", revset]
          : ["log", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", revset];
      if (typeof args.limit === "number") argv.push("--limit", String(args.limit));
      return jjJson(ctx, settings, cwd, readOnly(argv));
    }),
  });

  register({
    name: "jj_diff",
    description:
      "Show the changes in a revision as JSON. `@` always has a diff; that is normal in Jujutsu. Set interdiff:true to compare two patches instead of two trees.",
    parameters: {
      revset: { type: "string", description: "Defaults to `@`." },
      from: { type: "string", description: "Compare from this revision (with `to`)." },
      to: { type: "string", description: "Compare to this revision (with `from`)." },
      interdiff: {
        type: "boolean",
        description:
          "Compare the patches introduced by `from` and `to` rather than their trees. Useful for review and for “what changed since the last push”.",
      },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const revset = typeof args.revset === "string" ? args.revset : "@";
      const from = typeof args.from === "string" ? args.from : undefined;
      const to = typeof args.to === "string" ? args.to : undefined;
      const interdiff = args.interdiff === true;
      const interdiffFrom = from ?? "@-";
      const interdiffTo = to ?? "@";
      const argv = interdiff
        ? ["interdiff", "--summary", "--from", interdiffFrom, "--to", interdiffTo]
        : from !== undefined || to !== undefined
          ? [
              "diff",
              "--summary",
              ...(from === undefined ? [] : ["--from", from]),
              ...(to === undefined ? [] : ["--to", to]),
            ]
          : ["diff", "--summary", "-r", revset];
      const raw = await jj(ctx, settings, cwd, readOnly(argv));
      if (typeof raw !== "string") return raw; // error object
      return { files: parseSummary(raw) };
    }),
  });

  register({
    name: "jj_op_log",
    description:
      "Show the operation log. Every mutation is recorded and reversible with jj_op_restore — this is the recovery path.",
    parameters: {
      limit: { type: "integer", description: "Maximum operations to return." },
      atOp: {
        type: "string",
        description: "Read the operation log as it was at this operation id.",
      },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const argv =
        typeof args.atOp === "string"
          ? ["--at-op", args.atOp, "op", "log", "--no-graph", "-T", 'json(self) ++ "\\n"']
          : ["op", "log", "--no-graph", "-T", 'json(self) ++ "\\n"'];
      if (typeof args.limit === "number") argv.push("--limit", String(args.limit));
      return jjJson(ctx, settings, cwd, readOnly(argv));
    }),
  });

  register({
    name: "jj_new",
    description:
      "Start a new change on top of a revision. This is how a change is finalised — not `git commit`. Omitting a message creates a change that cannot be pushed.",
    parameters: {
      revset: { type: "string", description: "Parent revision. Defaults to `@`." },
      message: {
        type: "string",
        description: "Description for the new change.",
      },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      // `jj new` mints a commit, so an unconfigured identity makes it a trap.
      if ((await identityConfigured(ctx, settings, cwd)) === false) {
        return identityRefusal();
      }
      const conflicted = await conflictRefusal(ctx, settings, cwd);
      if (conflicted !== undefined) return conflicted;
      const argv = ["new"];
      if (typeof args.revset === "string") argv.push(args.revset);
      if (typeof args.message === "string") argv.push("-m", args.message);
      const raw = await jj(ctx, settings, cwd, argv);
      if (typeof raw !== "string") return raw;
      const opId = await latestOpId(ctx, settings, cwd);
      return { stdout: raw, ...(opId === undefined ? {} : { opId }) };
    }),
  });

  register({
    name: "jj_describe",
    description:
      "Set the description of a change. Preserves the author, so it is safe when the identity is unconfigured.",
    parameters: {
      message: { type: "string", description: "The new description.", required: true },
      revset: { type: "string", description: "Defaults to `@`." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const argv = ["describe", "-m", String(args.message)];
      if (typeof args.revset === "string") argv.push("-r", args.revset);
      const raw = await jj(ctx, settings, cwd, argv);
      if (typeof raw !== "string") return raw;
      const opId = await latestOpId(ctx, settings, cwd);
      return { stdout: raw, ...(opId === undefined ? {} : { opId }) };
    }),
  });

  register({
    name: "jj_squash",
    description:
      "Move changes from one revision into another. Replaces interactive rebase and fixup commits.",
    parameters: {
      from: {
        type: "string",
        description: "Source revision(s) to squash from. Defaults to `@`.",
      },
      into: {
        type: "string",
        description:
          "Revision to squash into. Defaults to `@`, so a bare `jj squash` folds the working copy into its parent.",
      },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const conflicted = await conflictRefusal(ctx, settings, cwd);
      if (conflicted !== undefined) return conflicted;
      const owned = await ownershipIssue(ctx, settings, cwd, [
        ...(typeof args.from === "string" ? [args.from] : []),
        ...(typeof args.into === "string" ? [args.into] : []),
      ]);
      if (owned.error !== undefined) return owned.error;
      const argv = ["squash"];
      if (typeof args.from === "string") argv.push("--from", args.from);
      if (typeof args.into === "string") argv.push("--into", args.into);
      const raw = await jj(ctx, settings, cwd, argv);
      if (typeof raw !== "string") return raw;
      const opId = await latestOpId(ctx, settings, cwd);
      return {
        stdout: raw,
        ...(opId === undefined ? {} : { opId }),
        ...(owned.warning === undefined ? {} : { warning: owned.warning }),
      };
    }),
  });

  register({
    name: "jj_bookmark",
    description: "Manage bookmarks — Jujutsu's named branches, and the only thing GitHub can see.",
    parameters: {
      action: {
        type: "string",
        enum: ["list", "create", "set", "move", "delete", "forget", "rename", "track", "untrack"],
        description: "What to do.",
        required: true,
      },
      name: {
        type: "string",
        description: "Bookmark name. For `rename`, the old name.",
      },
      newName: {
        type: "string",
        description: "The new name. Required by `rename` and ignored by every other action.",
      },
      revset: {
        type: "string",
        description: "Target revision. Used by `create`, `set` and `move`; ignored by the rest.",
      },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const action = String(args.action);
      const raw = await jj(
        ctx,
        settings,
        cwd,
        bookmarkArgv(
          action,
          typeof args.name === "string" ? args.name : undefined,
          typeof args.revset === "string" ? args.revset : undefined,
          typeof args.newName === "string" ? args.newName : undefined,
        ),
      );
      if (typeof raw !== "string") return raw;
      if (action === "list") return raw;
      const opId = await latestOpId(ctx, settings, cwd);
      return { stdout: raw, ...(opId === undefined ? {} : { opId }) };
    }),
  });

  register({
    name: "jj_op_restore",
    description:
      "Restore the repository to an earlier operation. This is the undo for everything except a deleted .git or .jj.",
    parameters: {
      opId: { type: "string", description: "Operation id from jj_op_log.", required: true },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const raw = await jj(ctx, settings, cwd, ["op", "restore", String(args.opId)]);
      if (typeof raw !== "string") return raw;
      const opId = await latestOpId(ctx, settings, cwd);
      return { stdout: raw, ...(opId === undefined ? {} : { opId }) };
    }),
  });

  register({
    name: "jj_hunk_list",
    description:
      "List the hunks a selection would touch, so a selection can be inspected before it is applied.",
    parameters: {
      query: {
        type: "string",
        description: 'A hunkset expression, e.g. `added(content:"timeout")`.',
      },
      revset: { type: "string", description: "Defaults to `@`." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd, exec) => {
      const outcome = await listHunks(ctx, settings, {
        cwd,
        // The live agent: `ctx.userQuestions.ask` requires it, and the offer to
        // install jj-hunk is the only thing here that needs a human.
        ...agentOf(exec),
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        ...(typeof args.revset === "string" ? { revset: args.revset } : {}),
      });
      return outcome.ok ? outcome.value : outcome.error;
    }),
  });

  register({
    name: "jj_hunk_apply",
    description: "Split, commit or squash a selected set of hunks without an interactive editor.",
    parameters: {
      mode: {
        type: "string",
        enum: ["split", "commit", "squash"],
        description:
          "split: put the selection in the first commit. commit: commit it. squash: move it into the parent.",
        required: true,
      },
      query: {
        type: "string",
        description:
          'A hunkset expression, e.g. `added(content:"timeout")`. Pass the expression rather than saved hunk IDs: IDs change whenever the revision or the working copy changes, so selecting by query is the only stable way.',
        required: true,
      },
      message: { type: "string", description: "Commit message. Required for split and commit." },
      revset: { type: "string", description: "Defaults to `@`." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd, exec) => {
      const mode = String(args.mode) as "split" | "commit" | "squash";
      // `squash` moves changes into an existing commit and preserves its author;
      // `split` and `commit` create one, so they are the modes that mint the
      // empty identity.
      if (mode !== "squash" && (await identityConfigured(ctx, settings, cwd)) === false) {
        return identityRefusal();
      }
      // A hunk operation rewrites the tree it selects from, so a conflicted
      // working copy is not a safe base for any of the three modes.
      const conflicted = await conflictRefusal(ctx, settings, cwd);
      if (conflicted !== undefined) return conflicted;
      const outcome = await applyHunks(
        ctx,
        settings,
        mode,
        {
          cwd,
          query: String(args.query),
          // Same reason as `jj_hunk_list`: the install offer needs the live agent.
          ...agentOf(exec),
          ...(typeof args.revset === "string" ? { revset: args.revset } : {}),
        },
        typeof args.message === "string" ? args.message : undefined,
      );
      if (!outcome.ok) return outcome.error;
      const opId = await latestOpId(ctx, settings, cwd);
      return { stdout: outcome.value, ...(opId === undefined ? {} : { opId }) };
    }),
  });

  /* ── agent-surface additions (docs/39) ─────────────────────────────────── */

  register({
    name: "jj_show",
    description:
      "Show one revision's metadata and changed files in a single read. Use `patch:true` for the diff text; the default summary keeps the payload small.",
    parameters: {
      revset: { type: "string", description: "Defaults to `@`." },
      patch: { type: "boolean", description: "Include the diff text. Default false." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const revset = typeof args.revset === "string" ? args.revset : "@";
      const commits = await jjJson(
        ctx,
        settings,
        cwd,
        readOnly(["log", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", revset, "--limit", "1"]),
      );
      if (!Array.isArray(commits)) return commits;
      const summary = await jj(ctx, settings, cwd, readOnly(["show", "--summary", "-r", revset]));
      if (typeof summary !== "string") return summary;
      const fileLines = summary
        .split("\n")
        .filter((line) => /^[MADRC] /.test(line))
        .join("\n");
      const result: Record<string, unknown> = {
        commit: commits[0] ?? null,
        files: parseSummary(fileLines),
      };
      if (args.patch === true) {
        const patch = await jj(ctx, settings, cwd, readOnly(["diff", "--git", "-r", revset]));
        if (typeof patch === "string") result.patch = patch;
      }
      return result;
    }),
  });

  register({
    name: "jj_file",
    description:
      "Read or modify files at a revision: list paths, show contents, search, annotate, chmod the executable bit, or delete files. Read actions do not check out the revision.",
    parameters: {
      action: {
        type: "string",
        enum: ["list", "show", "search", "annotate", "chmod", "delete"],
        required: true,
        description: "What to do.",
      },
      revision: { type: "string", description: "Defaults to `@`." },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Files or path prefixes. Required for show, annotate, chmod and delete.",
      },
      mode: {
        type: "string",
        enum: ["n", "x"],
        description: "chmod only: n makes a path non-executable, x makes it executable.",
      },
      pattern: {
        type: "string",
        description: "Required for search; a jj string pattern (regex by default).",
      },
      nameOnly: { type: "boolean", description: "Search only: return paths, not matching lines." },
      lineNumbers: { type: "boolean", description: "Search only: prefix lines with line numbers." },
      maxBytes: {
        type: "integer",
        description: "Show only: cap the returned content per file. Default 65536.",
      },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const action = String(args.action);
      const rev = typeof args.revision === "string" ? args.revision : "@";
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((p): p is string => typeof p === "string")
        : [];
      if (action === "list") {
        const raw = await jj(
          ctx,
          settings,
          cwd,
          readOnly(["file", "list", "-r", rev, "-T", 'path ++ "\\n"', ...paths]),
        );
        if (typeof raw !== "string") return raw;
        return {
          paths: raw
            .split("\n")
            .map((p) => p.trim())
            .filter((p) => p.length > 0),
        };
      }
      if (action === "show") {
        if (paths.length === 0) {
          return toolError(
            ErrorCode.JJ_EXEC_FAILED,
            "jj_file show needs at least one path.",
            "Pass paths:[...] or use jj_file list first.",
          );
        }
        const raw = await jj(ctx, settings, cwd, readOnly(["file", "show", "-r", rev, ...paths]));
        if (typeof raw !== "string") return raw;
        const limit =
          typeof args.maxBytes === "number" && args.maxBytes > 0
            ? Math.min(args.maxBytes, 1_000_000)
            : 65_536;
        const truncated = raw.length > limit;
        return { revision: rev, content: truncated ? raw.slice(0, limit) : raw, truncated };
      }
      if (action === "search") {
        if (typeof args.pattern !== "string" || args.pattern.length === 0) {
          return toolError(
            ErrorCode.JJ_EXEC_FAILED,
            "jj_file search needs a pattern.",
            "Pass pattern:'regex-or-glob'.",
          );
        }
        const argv = [
          "file",
          "search",
          "-r",
          rev,
          "--pattern",
          args.pattern,
          ...(args.nameOnly === true ? ["--name-only"] : []),
          ...(args.lineNumbers === true ? ["--line-number"] : []),
          ...paths,
        ];
        const raw = await jj(ctx, settings, cwd, readOnly(argv));
        return typeof raw === "string" ? { revision: rev, output: raw } : raw;
      }
      if (action === "chmod") {
        if ((args.mode !== "n" && args.mode !== "x") || paths.length === 0) {
          return toolError(
            ErrorCode.JJ_EXEC_FAILED,
            "jj_file chmod needs mode ('n' or 'x') and at least one path.",
          );
        }
        const beforeOpId = await latestOpId(ctx, settings, cwd);
        const raw = await jj(ctx, settings, cwd, ["file", "chmod", args.mode, "-r", rev, ...paths]);
        if (typeof raw !== "string") return raw;
        return {
          revision: rev,
          paths,
          mode: args.mode,
          stdout: raw,
          beforeOpId,
          opId: (await latestOpId(ctx, settings, cwd)) ?? null,
        };
      }
      if (action === "delete") {
        if (paths.length === 0) {
          return toolError(ErrorCode.JJ_EXEC_FAILED, "jj_file delete needs at least one path.");
        }
        const beforeOpId = await latestOpId(ctx, settings, cwd);
        const raw = await jj(ctx, settings, cwd, ["file", "delete", "-r", rev, ...paths]);
        if (typeof raw !== "string") return raw;
        return {
          revision: rev,
          paths,
          deleted: true,
          stdout: raw,
          beforeOpId,
          opId: (await latestOpId(ctx, settings, cwd)) ?? null,
        };
      }
      if (action === "annotate") {
        if (paths.length !== 1) {
          return toolError(
            ErrorCode.JJ_EXEC_FAILED,
            "jj_file annotate needs exactly one path.",
            "Pass paths:['src/file.ts'].",
          );
        }
        const raw = await jj(
          ctx,
          settings,
          cwd,
          readOnly(["file", "annotate", "-r", rev, paths[0]!]),
        );
        return typeof raw === "string" ? { revision: rev, path: paths[0], output: raw } : raw;
      }
      return toolError(ErrorCode.JJ_EXEC_FAILED, `Unknown jj_file action: ${action}`);
    }),
  });

  register({
    name: "jj_evolog",
    description:
      "Show how a change evolved: its previous commits and the operation that produced each. Use it after a rebase or a squash to see what changed.",
    parameters: {
      revset: { type: "string", description: "Defaults to `@`." },
      limit: { type: "integer", description: "Maximum entries to return." },
      patch: { type: "boolean", description: "Include the patch for each step. Default false." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const revset = typeof args.revset === "string" ? args.revset : "@";
      const argv = ["evolog", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", revset];
      if (typeof args.limit === "number") argv.push("--limit", String(args.limit));
      if (args.patch === true) argv.push("-p");
      return jjJson(ctx, settings, cwd, readOnly(argv));
    }),
  });

  register({
    name: "jj_commit",
    description:
      "Commit the working copy: mode commit describes @ and starts a new change (optionally keeping selected paths); mode split divides an existing revision by path. Both mint commits, so an identity is required.",
    parameters: {
      mode: {
        type: "string",
        enum: ["commit", "split"],
        description: "Default commit.",
      },
      message: { type: "string", required: true, description: "The change description." },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Paths to keep in the commit (commit) or select for the first half (split).",
      },
      revision: { type: "string", description: "Split only: revision to split. Default @." },
      parallel: { type: "boolean", description: "Split only: make the two halves siblings." },
      onto: {
        type: "string",
        description: "Split only: move the selected half onto this revision.",
      },
      insertAfter: {
        type: "string",
        description: "Split only: insert the selected half after this revision.",
      },
      insertBefore: {
        type: "string",
        description: "Split only: insert the selected half before this revision.",
      },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      if ((await identityConfigured(ctx, settings, cwd)) === false) return identityRefusal();
      const conflicted = await conflictRefusal(ctx, settings, cwd);
      if (conflicted !== undefined) return conflicted;
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((p): p is string => typeof p === "string")
        : [];
      const mode = args.mode === "split" ? "split" : "commit";
      const owned = await ownershipIssue(
        ctx,
        settings,
        cwd,
        mode === "split" && typeof args.revision === "string" ? [args.revision] : [],
      );
      if (owned.error !== undefined) return owned.error;
      // `jj split` without filesets opens a diff editor. The tool is
      // non-interactive by contract, so refuse rather than hang the loop.
      if (mode === "split" && paths.length === 0) {
        return toolError(
          ErrorCode.JJ_EXEC_FAILED,
          "jj_commit split needs at least one path.",
          "Pass paths:[...] to select the first half; use jj_hunk_apply for hunk-level splits.",
        );
      }
      const argv =
        mode === "split"
          ? [
              "split",
              "-r",
              typeof args.revision === "string" ? args.revision : "@",
              "-m",
              String(args.message),
              ...(args.parallel === true ? ["--parallel"] : []),
              ...(typeof args.onto === "string" ? ["-o", args.onto] : []),
              ...(typeof args.insertAfter === "string" ? ["-A", args.insertAfter] : []),
              ...(typeof args.insertBefore === "string" ? ["-B", args.insertBefore] : []),
              ...paths,
            ]
          : ["commit", "-m", String(args.message), ...paths];
      const raw = await jj(ctx, settings, cwd, argv);
      if (typeof raw !== "string") return raw;
      const workingCopy = await jjJson(
        ctx,
        settings,
        cwd,
        readOnly(["log", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", "@", "--limit", "1"]),
      );
      return {
        mode,
        stdout: raw,
        workingCopy,
        ...(owned.warning === undefined ? {} : { warning: owned.warning }),
      };
    }),
  });

  register({
    name: "jj_edit",
    description:
      "Set an existing revision as the working-copy revision. Use this to resume work on a change; jj recommends jj_new + jj_squash for most other edits.",
    parameters: {
      revset: { type: "string", required: true, description: "The revision to edit." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const revset = String(args.revset);
      const resolved = await jjJson(
        ctx,
        settings,
        cwd,
        readOnly(["log", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", revset, "--limit", "2"]),
      );
      let warning: string | undefined;
      if (Array.isArray(resolved) && resolved.length === 1) {
        const target = resolved[0] as { change_id?: string };
        if (typeof target.change_id === "string") {
          const owner = await workspaceOwningChange(ctx, settings, cwd, target.change_id);
          if (owner !== undefined) {
            const message = `${target.change_id} is workspace ${owner}'s working copy.`;
            if (settings.coordination === "enforce") {
              return toolError(
                ErrorCode.JJ_CHANGE_OWNED_BY_WORKSPACE,
                message,
                `Work in that workspace, or see jj_coordinate for a grouping plan. Set coordination to advise/off to override.`,
              );
            }
            if (settings.coordination === "advise") warning = message;
          }
        }
      }
      const raw = await jj(ctx, settings, cwd, ["edit", revset]);
      if (typeof raw !== "string") return raw;
      const workingCopy = await jjJson(
        ctx,
        settings,
        cwd,
        readOnly(["log", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", "@", "--limit", "1"]),
      );
      return { stdout: raw, workingCopy, ...(warning === undefined ? {} : { warning }) };
    }),
  });

  register({
    name: "jj_history",
    description:
      "Rewrite history: rebase a stack, duplicate a change, revert it, abandon it, restore paths, or edit metadata. Destructive actions return beforeOpId so they can be restored.",
    parameters: {
      action: {
        type: "string",
        enum: [
          "rebase",
          "duplicate",
          "revert",
          "abandon",
          "restore",
          "metaedit",
          "parallelize",
          "simplify-parents",
        ],
        required: true,
      },
      revsets: { type: "string", description: "The revisions to act on." },
      source: {
        type: "string",
        description: "Rebase: rebase this revision and its descendants (-s).",
      },
      branch: { type: "string", description: "Rebase: rebase this branch (-b)." },
      revisions: {
        type: "string",
        description: "Rebase: rebase these revisions without descendants (-r).",
      },
      onto: { type: "string", description: "Destination (-o)." },
      insertAfter: { type: "string", description: "Insert after this revision (-A)." },
      insertBefore: { type: "string", description: "Insert before this revision (-B)." },
      skipEmptied: { type: "boolean", description: "Rebase: abandon commits that become empty." },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Restore: paths to restore.",
      },
      from: { type: "string", description: "Restore: source revision." },
      into: { type: "string", description: "Restore: destination revision." },
      changesIn: { type: "string", description: "Restore: undo the changes in this revision." },
      message: { type: "string", description: "Metaedit: new description." },
      author: {
        type: "string",
        description: "Metaedit: new author, e.g. 'Name <mail@example.com>'.",
      },
      allowImmutable: {
        type: "boolean",
        description: "Allow rewriting immutable commits. Default false.",
      },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const action = String(args.action);
      const beforeOpId = await latestOpId(ctx, settings, cwd);
      const owned = await ownershipIssue(ctx, settings, cwd, [
        ...(typeof args.revsets === "string" ? [args.revsets] : []),
        ...(typeof args.source === "string" ? [args.source] : []),
        ...(typeof args.branch === "string" ? [args.branch] : []),
        ...(typeof args.revisions === "string" ? [args.revisions] : []),
        ...(action === "restore" && typeof args.into === "string" ? [args.into] : []),
        ...(action === "restore" && typeof args.changesIn === "string" ? [args.changesIn] : []),
      ]);
      if (owned.error !== undefined) return owned.error;
      const immutable = args.allowImmutable === true ? ["--ignore-immutable"] : [];
      const dest =
        typeof args.onto === "string"
          ? ["-o", args.onto]
          : typeof args.insertAfter === "string"
            ? ["-A", args.insertAfter]
            : typeof args.insertBefore === "string"
              ? ["-B", args.insertBefore]
              : [];
      let argv: string[];
      if (action === "parallelize" || action === "simplify-parents") {
        if (typeof args.revsets !== "string") {
          return toolError(ErrorCode.JJ_EXEC_FAILED, `jj_history ${action} needs revsets.`);
        }
        argv = [...immutable, action, args.revsets];
      } else if (action === "rebase") {
        const src =
          typeof args.source === "string"
            ? ["-s", args.source]
            : typeof args.branch === "string"
              ? ["-b", args.branch]
              : typeof args.revisions === "string"
                ? ["-r", args.revisions]
                : [];
        if (src.length === 0) {
          return toolError(
            ErrorCode.JJ_REBASE_SOURCE_AMBIGUOUS,
            "jj_history rebase needs exactly one of source, branch, or revisions.",
            "Pass source:'<rev>', branch:'<bookmark>', or revisions:'<revset>'.",
          );
        }
        if (dest.length === 0) {
          return toolError(
            ErrorCode.JJ_REBASE_DESTINATION_AMBIGUOUS,
            "jj_history rebase needs one of onto, insertAfter, or insertBefore.",
            "Pass onto:'<rev>'.",
          );
        }
        argv = [
          ...immutable,
          "rebase",
          ...src,
          ...dest,
          ...(args.skipEmptied === true ? ["--skip-emptied"] : []),
        ];
      } else if (action === "duplicate") {
        argv = [
          ...immutable,
          "duplicate",
          ...(typeof args.revsets === "string" ? [args.revsets] : []),
          ...dest,
        ];
      } else if (action === "revert") {
        if (typeof args.revsets !== "string") {
          return toolError(ErrorCode.JJ_EXEC_FAILED, "jj_history revert needs revsets.");
        }
        if (dest.length === 0) {
          return toolError(ErrorCode.JJ_EXEC_FAILED, "jj_history revert needs a destination.");
        }
        argv = [...immutable, "revert", "-r", args.revsets, ...dest];
      } else if (action === "abandon") {
        if (typeof args.revsets !== "string") {
          return toolError(ErrorCode.JJ_EXEC_FAILED, "jj_history abandon needs revsets.");
        }
        argv = [...immutable, "abandon", args.revsets];
      } else if (action === "restore") {
        const paths = Array.isArray(args.paths)
          ? args.paths.filter((p): p is string => typeof p === "string")
          : [];
        argv = [
          ...immutable,
          "restore",
          ...(typeof args.from === "string" ? ["-f", args.from] : []),
          ...(typeof args.into === "string" ? ["-t", args.into] : []),
          ...(typeof args.changesIn === "string" ? ["-c", args.changesIn] : []),
          ...paths,
        ];
      } else {
        argv = [
          ...immutable,
          "metaedit",
          ...(typeof args.revsets === "string" ? [args.revsets] : []),
          ...(typeof args.message === "string" ? ["-m", args.message] : []),
          ...(typeof args.author === "string" ? ["--author", args.author] : []),
        ];
      }
      const raw = await jj(ctx, settings, cwd, argv);
      if (typeof raw !== "string") return raw;
      const afterOpId = await latestOpId(ctx, settings, cwd);
      return {
        action,
        stdout: raw,
        beforeOpId,
        afterOpId,
        ...(owned.warning === undefined ? {} : { warning: owned.warning }),
      };
    }),
  });

  register({
    name: "jj_op",
    description:
      "Work with the operation log: log, show, diff, restore, revert, abandon, integrate. Restore is the checkpoint rollback; revert is the surgical undo of one operation.",
    parameters: {
      action: {
        type: "string",
        enum: ["log", "show", "diff", "restore", "revert", "abandon", "integrate"],
        required: true,
      },
      opId: { type: "string", description: "The operation id." },
      from: { type: "string", description: "Diff: first operation." },
      to: { type: "string", description: "Diff: second operation." },
      operation: { type: "string", description: "Abandon: operation or range, e.g. '..<op-id>'." },
      limit: { type: "integer", description: "Log: maximum entries." },
      summary: { type: "boolean", description: "Show/diff: summary only." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const action = String(args.action);
      if (action === "log") {
        const argv = ["op", "log", "--no-graph", "-T", 'json(self) ++ "\\n"'];
        if (typeof args.limit === "number") argv.push("--limit", String(args.limit));
        return jjJson(ctx, settings, cwd, readOnly(argv));
      }
      const opId = typeof args.opId === "string" ? args.opId : undefined;
      if (action === "show") {
        if (opId === undefined)
          return toolError(ErrorCode.JJ_OP_NOT_FOUND, "jj_op show needs opId.");
        const raw = await jj(
          ctx,
          settings,
          cwd,
          readOnly(["op", "show", opId, ...(args.summary === true ? ["--summary"] : [])]),
        );
        return typeof raw === "string" ? { opId, output: raw } : raw;
      }
      if (action === "diff") {
        if (typeof args.from !== "string" || typeof args.to !== "string") {
          return toolError(ErrorCode.JJ_OP_NOT_FOUND, "jj_op diff needs from and to.");
        }
        const raw = await jj(
          ctx,
          settings,
          cwd,
          readOnly([
            "op",
            "diff",
            "--from",
            args.from,
            "--to",
            args.to,
            ...(args.summary === true ? ["--summary"] : []),
          ]),
        );
        return typeof raw === "string" ? { from: args.from, to: args.to, output: raw } : raw;
      }
      const beforeOpId = await latestOpId(ctx, settings, cwd);
      let argv: string[];
      if (action === "restore") {
        if (opId === undefined)
          return toolError(ErrorCode.JJ_OP_NOT_FOUND, "jj_op restore needs opId.");
        argv = ["op", "restore", opId];
      } else if (action === "revert") {
        if (opId === undefined)
          return toolError(ErrorCode.JJ_OP_NOT_FOUND, "jj_op revert needs opId.");
        argv = ["op", "revert", opId];
      } else if (action === "abandon") {
        if (typeof args.operation !== "string") {
          return toolError(ErrorCode.JJ_OP_NOT_FOUND, "jj_op abandon needs operation.");
        }
        argv = ["op", "abandon", args.operation];
      } else if (action === "integrate") {
        if (opId === undefined)
          return toolError(ErrorCode.JJ_OP_NOT_FOUND, "jj_op integrate needs opId.");
        argv = ["op", "integrate", opId];
      } else {
        return toolError(ErrorCode.JJ_OP_NOT_FOUND, `Unknown jj_op action: ${action}`);
      }
      const raw = await jj(ctx, settings, cwd, argv);
      if (typeof raw !== "string") return raw;
      return { action, stdout: raw, beforeOpId, afterOpId: await latestOpId(ctx, settings, cwd) };
    }),
  });

  register({
    name: "jj_repair",
    description:
      "Recover a broken multi-agent state: undo/redo the last operation, absorb edits into their owning ancestors, or converge divergent changes.",
    parameters: {
      action: {
        type: "string",
        enum: ["undo", "redo", "absorb", "converge"],
        required: true,
      },
      allowCrossWorkspace: {
        type: "boolean",
        description: "Undo: allow undoing another workspace's operation. Default false.",
      },
      from: { type: "string", description: "Absorb: source revision." },
      into: { type: "string", description: "Absorb: destination revisions." },
      paths: { type: "array", items: { type: "string" }, description: "Absorb: paths to absorb." },
      revset: { type: "string", description: "Converge: search space. Default divergent()." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const action = String(args.action);
      if (action === "undo") {
        const raw = await jj(ctx, settings, cwd, [
          "undo",
          ...(args.allowCrossWorkspace === true ? ["--allow-cross-workspace"] : []),
        ]);
        return typeof raw === "string" ? { undone: true, stdout: raw } : raw;
      }
      if (action === "redo") {
        const raw = await jj(ctx, settings, cwd, ["redo"]);
        return typeof raw === "string" ? { redone: true, stdout: raw } : raw;
      }
      if (action === "absorb") {
        const paths = Array.isArray(args.paths)
          ? args.paths.filter((p): p is string => typeof p === "string")
          : [];
        const raw = await jj(ctx, settings, cwd, [
          "absorb",
          ...(typeof args.from === "string" ? ["--from", args.from] : []),
          ...(typeof args.into === "string" ? ["--into", args.into] : []),
          ...paths,
        ]);
        return typeof raw === "string" ? { absorbed: true, stdout: raw } : raw;
      }
      const before = await divergentOf(ctx, settings, cwd);
      const revset = typeof args.revset === "string" ? args.revset : "divergent()";
      const raw = await jj(ctx, settings, cwd, ["converge", "--no-interactive", "-r", revset]);
      if (typeof raw !== "string") return raw;
      const after = await divergentOf(ctx, settings, cwd);
      return {
        before: before ?? [],
        after: after ?? [],
        resolved: (after ?? []).length === 0,
        stdout: raw,
      };
    }),
  });

  register({
    name: "jj_workspace",
    description:
      "Manage Jujutsu workspaces. add creates a colocated workspace and returns its path for a subagent cwd; remove snapshots the work before deleting; forget discards it.",
    parameters: {
      action: {
        type: "string",
        enum: ["list", "add", "remove", "forget", "update-stale", "root", "rename"],
        required: true,
      },
      name: { type: "string", description: "Workspace name." },
      path: { type: "string", description: "Add: destination path." },
      revset: { type: "string", description: "Add: base revision." },
      colocate: { type: "boolean", description: "Add: create a Git worktree. Default true." },
      bookmark: {
        type: "string",
        description:
          "Add: ownership bookmark. Defaults to agentBookmarkPrefix + workspace name; pass an empty string to disable.",
      },
      newName: { type: "string", description: "Rename: the new name for the current workspace." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const action = String(args.action);
      if (action === "list") {
        const rows = await jjJson(
          ctx,
          settings,
          cwd,
          readOnly(["workspace", "list", "-T", 'json(self) ++ "\\n"']),
        );
        if (!Array.isArray(rows)) return rows;
        const bookmarks = (await bookmarkRows(ctx, settings, cwd)) ?? [];
        const prefix = settings.agentBookmarkPrefix;
        return (rows as { name: string; target: { commit_id: string } }[]).map((row) => {
          const exact =
            prefix === ""
              ? undefined
              : bookmarks.find((entry) => entry.name === `${prefix}${row.name}`)?.name;
          const names = [
            ...new Set([
              ...bookmarks
                .filter((entry) => entry.target.includes(row.target.commit_id))
                .map((entry) => entry.name),
              ...(exact === undefined ? [] : [exact]),
            ]),
          ];
          // The ownership bookmark is matched by name, not by target: it is
          // created at the workspace's initial @ and does not follow commits.
          const owner =
            exact ?? (prefix === "" ? undefined : names.find((entry) => entry.startsWith(prefix)));
          return { ...row, owner: owner ?? null, bookmarks: names };
        });
      }
      if (action === "root") {
        const raw = await jj(ctx, settings, cwd, readOnly(["workspace", "root"]));
        return typeof raw === "string" ? { root: raw.trim() } : raw;
      }
      if (action === "add") {
        const explicitName = typeof args.name === "string" ? args.name : undefined;
        const name = explicitName ?? `agent-${randomUUID().slice(0, 8)}`;
        const target =
          typeof args.path === "string"
            ? resolvePath(cwd, args.path)
            : resolvePath(cwd, settings.workspaceRoot, explicitName ?? basename(name));
        const finalName = explicitName ?? basename(target);
        const argv = [
          "workspace",
          "add",
          target,
          "--name",
          finalName,
          ...(args.colocate === false ? ["--no-colocate"] : ["--colocate"]),
          ...(typeof args.revset === "string" ? ["-r", args.revset] : []),
        ];
        // `workspace add` must be allowed to update the working copy: jj
        // snapshots the current workspace before creating the new one. Passing
        // --ignore-working-copy creates the workspace and then exits with
        // "This command must be able to update the working copy." Call it at a
        // quiescent boundary, not in the middle of another agent's write.
        const raw = await jj(ctx, settings, cwd, argv);
        if (typeof raw !== "string") return raw;
        // The ownership bookmark is the coordination convention: it names the
        // workspace's working copy so jj_coordinate can group agents without a
        // side database.
        let bookmark: string | null = null;
        let warning: string | undefined;
        if (settings.agentBookmarkPrefix !== "" && args.bookmark !== "") {
          const bookmarkName =
            typeof args.bookmark === "string" && args.bookmark.length > 0
              ? args.bookmark
              : `${settings.agentBookmarkPrefix}${finalName}`;
          const set = await jj(ctx, settings, cwd, [
            "bookmark",
            "set",
            bookmarkName,
            "-r",
            `${finalName}@`,
          ]);
          if (typeof set === "string") bookmark = bookmarkName;
          else warning = `workspace created, but the ownership bookmark was not set`;
        }
        return {
          name: finalName,
          path: target,
          bookmark,
          ...(warning === undefined ? {} : { warning }),
          stdout: raw,
        };
      }
      if (action === "rename") {
        if (typeof args.newName !== "string") {
          return toolError(ErrorCode.JJ_WORKSPACE_NOT_FOUND, "jj_workspace rename needs newName.");
        }
        const raw = await jj(ctx, settings, cwd, ["workspace", "rename", args.newName]);
        return typeof raw === "string" ? { renamed: true, stdout: raw } : raw;
      }
      if (typeof args.name !== "string") {
        return toolError(ErrorCode.JJ_WORKSPACE_NOT_FOUND, `jj_workspace ${action} needs name.`);
      }
      if (action === "remove") {
        const raw = await jj(ctx, settings, cwd, ["workspace", "remove", args.name]);
        return typeof raw === "string" ? { removed: true, stdout: raw } : raw;
      }
      if (action === "forget") {
        const raw = await jj(ctx, settings, cwd, readOnly(["workspace", "forget", args.name]));
        return typeof raw === "string" ? { forgotten: true, stdout: raw } : raw;
      }
      if (action === "update-stale") {
        const raw = await jj(ctx, settings, cwd, ["workspace", "update-stale"]);
        return typeof raw === "string" ? { updated: true, stdout: raw } : raw;
      }
      return toolError(ErrorCode.JJ_WORKSPACE_NOT_FOUND, `Unknown jj_workspace action: ${action}`);
    }),
  });

  register({
    name: "jj_test",
    description:
      "Run a command against a revision in isolation. mode test (default) creates an ephemeral colocated workspace, clones verifyCloneDirs, runs the command, and cleans up. mode run uses jj run --ignore-changes; mode bisect uses jj bisect run in an ephemeral workspace.",
    parameters: {
      mode: { type: "string", enum: ["test", "run", "bisect"], description: "Default test." },
      revision: { type: "string", description: "Test/run: revision to test. Default @." },
      range: { type: "string", description: "Bisect: revision range." },
      command: { type: "string", required: true, description: "Shell command to run." },
      deps: { type: "string", enum: ["clone", "install", "none"], description: "Default clone." },
      timeoutMs: { type: "integer", description: "Command timeout in milliseconds." },
      keep: { type: "boolean", description: "Leave the ephemeral workspace for debugging." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const mode = args.mode === "run" ? "run" : args.mode === "bisect" ? "bisect" : "test";
      const command = String(args.command);
      if (mode === "run") {
        const rev = typeof args.revision === "string" ? args.revision : "@";
        const result = await runJj(
          ctx,
          settings.jjPath,
          [
            "run",
            "--ignore-working-copy",
            "--ignore-changes",
            "-r",
            rev,
            "--",
            "bash",
            "-lc",
            command,
          ],
          { cwd },
        );
        return {
          mode,
          revision: rev,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        };
      }
      const tempResult = await run(ctx, ["mktemp", "-d"] as const, { cwd });
      if (tempResult.exitCode !== 0) {
        return toolError(
          ErrorCode.JJ_TEST_WORKSPACE_FAILED,
          `Could not create a temporary directory: ${tempResult.stderr.trim().slice(0, 200)}`,
        );
      }
      if (mode === "bisect" && typeof args.range !== "string") {
        return toolError(
          ErrorCode.JJ_TEST_WORKSPACE_FAILED,
          "jj_test bisect needs a range.",
          "Pass range:'<good>..<bad>'.",
        );
      }
      const temp = tempResult.stdout.trim();
      const name = `dsh-test-${randomUUID().slice(0, 8)}`;
      const started = Date.now();
      let cleanedUp = false;
      try {
        const add = await runJj(
          ctx,
          settings.jjPath,
          [
            "workspace",
            "add",
            temp,
            "--name",
            name,
            "--colocate",
            // `workspace add` without -r bases the new working copy on the
            // *parent* of @, which silently tests the wrong tree. Pass the
            // revision explicitly, including the default @.
            ...(mode === "test"
              ? ["-r", typeof args.revision === "string" ? args.revision : "@"]
              : []),
          ],
          { cwd },
        );
        if (add.exitCode !== 0) {
          return toolError(
            ErrorCode.JJ_TEST_WORKSPACE_FAILED,
            `Could not create the test workspace: ${add.stderr.trim().slice(0, 300)}`,
            "Run `jj workspace list` to check for a name collision.",
          );
        }
        if (mode === "test" && args.deps === "install") {
          const installed = await run(
            ctx,
            ["bash", "-lc", "pnpm install --frozen-lockfile"] as const,
            {
              cwd: temp,
              ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
            },
          );
          if (installed.exitCode !== 0) {
            await runJj(ctx, settings.jjPath, readOnly(["workspace", "forget", name]), { cwd });
            await run(ctx, ["rm", "-rf", temp] as const, { cwd });
            cleanedUp = true;
            return {
              mode,
              revision: typeof args.revision === "string" ? args.revision : "@",
              workspace: { name, path: temp },
              command,
              phase: "install",
              exitCode: installed.exitCode,
              stdout: installed.stdout,
              stderr: installed.stderr,
              timedOut: installed.timedOut,
              durationMs: Date.now() - started,
              cleanedUp,
            };
          }
        } else if (mode === "test" && args.deps !== "none") {
          for (const dir of settings.verifyCloneDirs) {
            const source = resolvePath(cwd, dir);
            const dest = resolvePath(temp, dir);
            const copied = await run(ctx, ["cp", "-cR", source, dest] as const, { cwd });
            if (copied.exitCode !== 0) {
              await run(ctx, ["cp", "-a", source, dest] as const, { cwd });
            }
          }
        }
        const executed =
          mode === "bisect"
            ? await run(
                ctx,
                [
                  "bash",
                  "-lc",
                  `jj bisect run --range ${shellQuote(typeof args.range === "string" ? args.range : "")} -- bash -lc ${shellQuote(command)}`,
                ] as const,
                {
                  cwd: temp,
                  ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
                },
              )
            : await run(ctx, ["bash", "-lc", command] as const, {
                cwd: temp,
                ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
              });
        if (args.keep !== true) {
          await runJj(ctx, settings.jjPath, readOnly(["workspace", "forget", name]), { cwd });
          await run(ctx, ["rm", "-rf", temp] as const, { cwd });
          cleanedUp = true;
        }
        return {
          mode,
          revision: typeof args.revision === "string" ? args.revision : "@",
          workspace: { name, path: temp },
          command,
          exitCode: executed.exitCode,
          stdout: executed.stdout,
          stderr: executed.stderr,
          timedOut: executed.timedOut,
          durationMs: Date.now() - started,
          cleanedUp,
        };
      } finally {
        if (!cleanedUp && args.keep !== true) {
          try {
            await runJj(ctx, settings.jjPath, readOnly(["workspace", "forget", name]), { cwd });
            await run(ctx, ["rm", "-rf", temp] as const, { cwd });
          } catch {
            /* best-effort cleanup; the workspace path is in the result */
          }
        }
      }
    }),
  });

  register({
    name: "jj_publish",
    description:
      "Publish or fetch. push leaves the machine: with publish=ask it returns a dry-run preview and needs confirm:true; deny refuses; allow pushes. fetch, tag-list, tag-set, tag-delete, tag-track and tag-untrack stay local.",
    parameters: {
      action: {
        type: "string",
        enum: ["push", "fetch", "tag-list", "tag-set", "tag-delete", "tag-track", "tag-untrack"],
        required: true,
      },
      remote: { type: "string", description: "Remote name." },
      bookmark: { type: "string", description: "Push: bookmark to push." },
      change: {
        type: "string",
        description: "Push: create a bookmark for this change and push it.",
      },
      tag: { type: "string", description: "Tag name." },
      revision: { type: "string", description: "Tag-set: target revision." },
      all: { type: "boolean", description: "Push: push all bookmarks and tags." },
      allowMove: { type: "boolean", description: "Tag-set: allow moving an existing tag." },
      dryRun: { type: "boolean", description: "Push: dry run." },
      confirm: { type: "boolean", description: "Push: confirm a real push when publish=ask." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const action = String(args.action);
      if (action === "fetch") {
        const raw = await jj(ctx, settings, cwd, [
          "git",
          "fetch",
          ...(typeof args.remote === "string" ? ["--remote", args.remote] : []),
        ]);
        return typeof raw === "string" ? { fetched: true, stdout: raw } : raw;
      }
      if (action === "tag-list") {
        return jjJson(ctx, settings, cwd, readOnly(["tag", "list", "-T", 'json(self) ++ "\\n"']));
      }
      if (action === "tag-set") {
        if (typeof args.tag !== "string") {
          return toolError(ErrorCode.JJ_EXEC_FAILED, "jj_publish tag-set needs tag.");
        }
        const raw = await jj(ctx, settings, cwd, [
          "tag",
          "set",
          args.tag,
          ...(typeof args.revision === "string" ? ["-r", args.revision] : []),
          ...(args.allowMove === true ? ["--allow-move"] : []),
        ]);
        return typeof raw === "string" ? { tag: args.tag, stdout: raw } : raw;
      }
      if (action === "tag-delete") {
        if (typeof args.tag !== "string") {
          return toolError(ErrorCode.JJ_EXEC_FAILED, "jj_publish tag-delete needs tag.");
        }
        const raw = await jj(ctx, settings, cwd, ["tag", "delete", args.tag]);
        return typeof raw === "string" ? { deleted: true, stdout: raw } : raw;
      }
      if (action === "tag-track" || action === "tag-untrack") {
        if (typeof args.tag !== "string") {
          return toolError(ErrorCode.JJ_EXEC_FAILED, `jj_publish ${action} needs tag.`);
        }
        const raw = await jj(ctx, settings, cwd, [
          "tag",
          action === "tag-track" ? "track" : "untrack",
          args.tag,
          ...(typeof args.remote === "string" ? ["--remote", args.remote] : []),
        ]);
        return typeof raw === "string" ? { tag: args.tag, stdout: raw } : raw;
      }
      if (settings.publish === "deny") {
        return toolError(
          ErrorCode.JJ_PUBLISH_APPROVAL_REQUIRED,
          "Publishing is disabled by the publish setting.",
          "Set publish to ask or allow to enable jj_publish push.",
        );
      }
      const pushArgs = [
        "git",
        "push",
        ...(typeof args.remote === "string" ? ["--remote", args.remote] : []),
        ...(typeof args.bookmark === "string" ? ["--bookmark", args.bookmark] : []),
        ...(typeof args.change === "string" ? ["--change", args.change] : []),
        ...(typeof args.tag === "string" ? ["--tag", args.tag] : []),
        ...(args.all === true ? ["--all"] : []),
      ];
      const dryRun = args.dryRun === true || (settings.publish === "ask" && args.confirm !== true);
      const pushed = await runJj(
        ctx,
        settings.jjPath,
        readOnly([...pushArgs, ...(dryRun ? ["--dry-run"] : [])]),
        { cwd },
      );
      if (pushed.exitCode !== 0) {
        return toolError(
          ErrorCode.JJ_EXEC_FAILED,
          `jj git push exited ${String(pushed.exitCode)}: ${pushed.stderr.trim().slice(0, 300)}`,
          "Run `jj git push --dry-run` by hand to see the full output.",
        );
      }
      // `jj git push` writes its summary to stderr, not stdout; return both so
      // the model sees the same "Changes to push" block a human would.
      return dryRun
        ? {
            action: "push",
            dryRun: true,
            requiresConfirmation: settings.publish === "ask" && args.confirm !== true,
            stdout: pushed.stdout,
            stderr: pushed.stderr,
          }
        : { action: "push", dryRun: false, stdout: pushed.stdout, stderr: pushed.stderr };
    }),
  });

  register({
    name: "jj_fix",
    description:
      "Apply the formatters configured in fix.tools to the mutable stack. Requires jj config fix.tools; without it, configure a formatter first.",
    parameters: {
      revsets: {
        type: "string",
        description: "Revisions to fix. Default reachable(@, mutable()).",
      },
      paths: { type: "array", items: { type: "string" }, description: "Restrict to these paths." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const beforeOpId = await latestOpId(ctx, settings, cwd);
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((p): p is string => typeof p === "string")
        : [];
      const raw = await jj(ctx, settings, cwd, [
        "fix",
        ...(typeof args.revsets === "string" ? ["-s", args.revsets] : []),
        ...paths,
      ]);
      if (typeof raw !== "string") return raw;
      return { stdout: raw, beforeOpId, afterOpId: await latestOpId(ctx, settings, cwd) };
    }),
  });

  register({
    name: "jj_sparse",
    description:
      "Manage sparse checkout patterns for a monorepo. list shows the patterns; set adds/removes/clears; reset includes everything.",
    parameters: {
      action: { type: "string", enum: ["list", "set", "reset"], required: true },
      add: { type: "array", items: { type: "string" }, description: "Set: patterns to add." },
      remove: { type: "array", items: { type: "string" }, description: "Set: patterns to remove." },
      clear: { type: "boolean", description: "Set: start from an empty pattern set." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const action = String(args.action);
      if (action === "list") {
        const raw = await jj(ctx, settings, cwd, readOnly(["sparse", "list"]));
        return typeof raw === "string"
          ? { patterns: raw.split("\n").filter((p) => p.length > 0) }
          : raw;
      }
      if (action === "reset") {
        const raw = await jj(ctx, settings, cwd, ["sparse", "reset"]);
        return typeof raw === "string" ? { reset: true, stdout: raw } : raw;
      }
      const argv = [
        "sparse",
        "set",
        ...(args.clear === true ? ["--clear"] : []),
        ...(Array.isArray(args.add)
          ? args.add.filter((p): p is string => typeof p === "string").flatMap((p) => ["--add", p])
          : []),
        ...(Array.isArray(args.remove)
          ? args.remove
              .filter((p): p is string => typeof p === "string")
              .flatMap((p) => ["--remove", p])
          : []),
      ];
      const raw = await jj(ctx, settings, cwd, argv);
      return typeof raw === "string" ? { stdout: raw } : raw;
    }),
  });

  register({
    name: "jj_doctor",
    description:
      "Report whether this repository is configured for multi-agent work: jj version, workspaces and ownership bookmarks, snapshot settings, divergence, sparse patterns, and the op-log head. Read-only.",
    parameters: {},
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (_args, cwd) => {
      const version = await runJj(ctx, settings.jjPath, ["--version"], { cwd });
      const workspaces = await jjJson(
        ctx,
        settings,
        cwd,
        readOnly(["workspace", "list", "-T", 'json(self) ++ "\\n"']),
      );
      const bookmarks = (await bookmarkRows(ctx, settings, cwd)) ?? [];
      const divergence = (await divergentOf(ctx, settings, cwd)) ?? [];
      const opId = await latestOpId(ctx, settings, cwd);
      const rootRaw = await jj(ctx, settings, cwd, readOnly(["workspace", "root"]));
      const sparseRaw = await jj(ctx, settings, cwd, readOnly(["sparse", "list"]));
      const configRaw = await jj(
        ctx,
        settings,
        cwd,
        readOnly(["config", "list", "--include-defaults"]),
      );
      const wanted = [
        "snapshot.auto-update-stale",
        "snapshot.max-new-file-size",
        "git.colocate",
        "signing.backend",
        "fix.tools",
      ];
      const config: Record<string, string> = {};
      if (typeof configRaw === "string") {
        for (const line of configRaw.split("\n")) {
          const match = /^([^=]+?)\s*=\s*(.*)$/.exec(line.trim());
          if (match === null) continue;
          const key = match[1]!.trim();
          if (wanted.includes(key)) config[key] = match[2]!.trim();
        }
      }
      const prefix = settings.agentBookmarkPrefix;
      const owned = prefix === "" ? [] : bookmarks.filter((b) => b.name.startsWith(prefix));
      const warnings: string[] = [];
      if (Array.isArray(workspaces) && workspaces.length > 1) {
        if (config["snapshot.auto-update-stale"] !== "true") {
          warnings.push(
            "snapshot.auto-update-stale is not true; another agent's rebase can leave this workspace stale.",
          );
        }
        if (owned.length === 0) {
          warnings.push(
            "No agent/* ownership bookmarks; jj_coordinate cannot tell which workspace belongs to which agent.",
          );
        }
      }
      if (divergence.length > 0) {
        warnings.push("Divergent changes exist; run jj_repair({action:'converge'}).");
      }
      return {
        version: version.exitCode === 0 ? version.stdout.trim() : null,
        root: typeof rootRaw === "string" ? rootRaw.trim() : null,
        workspaces: Array.isArray(workspaces) ? workspaces : [],
        ownerBookmarks: owned,
        divergence,
        opId: opId ?? null,
        sparse:
          typeof sparseRaw === "string"
            ? sparseRaw.split("\n").filter((line) => line.length > 0)
            : [],
        config,
        warnings,
      };
    }),
  });

  register({
    name: "jj_coordinate",
    description:
      "Plan how to group agents working in this repo. Lists each workspace's change, owner bookmark, parent and conflict state, groups workspaces that share a parent, and suggests merge or squash. Read-only.",
    parameters: {},
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (_args, cwd) => {
      const rows = await jjJson(
        ctx,
        settings,
        cwd,
        readOnly(["workspace", "list", "-T", 'json(self) ++ "\\n"']),
      );
      if (!Array.isArray(rows)) return rows;
      const bookmarks = (await bookmarkRows(ctx, settings, cwd)) ?? [];
      const prefix = settings.agentBookmarkPrefix;
      const workspaces: Record<string, unknown>[] = [];
      for (const row of rows as {
        name: string;
        target: { commit_id: string; change_id: string };
      }[]) {
        const parents = await jjJson(
          ctx,
          settings,
          cwd,
          readOnly([
            "log",
            "--no-graph",
            "-T",
            'json(self) ++ "\\n"',
            "-r",
            `${row.name}@-`,
            "--limit",
            "1",
          ]),
        );
        const conflict = await jj(
          ctx,
          settings,
          cwd,
          readOnly(["log", "--no-graph", "-T", "conflict", "-r", `${row.name}@`]),
        );
        const exact =
          prefix === ""
            ? undefined
            : bookmarks.find((entry) => entry.name === `${prefix}${row.name}`)?.name;
        const names = [
          ...new Set([
            ...bookmarks
              .filter((entry) => entry.target.includes(row.target.commit_id))
              .map((entry) => entry.name),
            ...(exact === undefined ? [] : [exact]),
          ]),
        ];
        const owner =
          exact ?? (prefix === "" ? undefined : names.find((entry) => entry.startsWith(prefix)));
        const parent = Array.isArray(parents)
          ? (parents[0] as { change_id?: string } | undefined)
          : undefined;
        workspaces.push({
          name: row.name,
          changeId: row.target.change_id,
          commitId: row.target.commit_id,
          parentChangeId: parent?.change_id ?? null,
          headChangeId: parent?.change_id ?? row.target.change_id,
          owner: owner ?? null,
          bookmarks: names,
          conflicted: typeof conflict === "string" && conflict.trim() === "true",
        });
      }
      const groups = new Map<string, Record<string, unknown>[]>();
      for (const workspace of workspaces) {
        const key =
          typeof workspace.parentChangeId === "string" ? workspace.parentChangeId : "root";
        groups.set(key, [...(groups.get(key) ?? []), workspace]);
      }
      const plan = [...groups.entries()].map(([parent, members]) => ({
        parent,
        workspaces: members.map((member) => String(member.name)),
        changes: members.map((member) => String(member.headChangeId ?? member.changeId)),
        conflicted: members.some((member) => member.conflicted === true),
        suggestedAction:
          members.length > 1
            ? settings.groupDefault
            : members[0]?.conflicted === true
              ? "resolve conflict before grouping"
              : "none",
      }));
      const warnings: string[] = [];
      for (const workspace of workspaces) {
        if (workspace.owner === null) {
          warnings.push(`${String(workspace.name)} has no ownership bookmark.`);
        }
        if (workspace.conflicted === true) {
          warnings.push(`${String(workspace.name)} has a conflicted working copy.`);
        }
      }
      const mergeCandidates = workspaces
        .filter((workspace) => workspace.conflicted !== true)
        .map((workspace) => String(workspace.headChangeId ?? workspace.changeId));
      const recommended =
        mergeCandidates.length > 1
          ? {
              action: settings.groupDefault,
              revsets: mergeCandidates,
              // A stack also needs a base; the Lead supplies it because only
              // the Lead knows the intended integration point.
              ...(settings.groupDefault === "stack" ? { onto: null } : {}),
            }
          : null;
      return {
        workspaces,
        groups: plan,
        mergeCandidates,
        recommended,
        divergence: (await divergentOf(ctx, settings, cwd)) ?? [],
        warnings,
      };
    }),
  });

  register({
    name: "jj_group",
    description:
      "Group agent commits: merge several revisions into one integration commit, squash several into one, or name a group with a bookmark. History-mutating actions return beforeOpId and opId.",
    parameters: {
      action: {
        type: "string",
        enum: ["merge", "squash", "bookmark", "stack"],
        required: true,
      },
      revsets: {
        type: "array",
        items: { type: "string" },
        description: "Merge/stack: revisions to group. Squash: source revisions.",
      },
      into: { type: "string", description: "Squash: destination revision." },
      onto: { type: "string", description: "Stack: base revision the chain is built on." },
      message: { type: "string", description: "Merge: commit description." },
      bookmark: {
        type: "string",
        description: "Merge/stack: bookmark to create at the group head.",
      },
      revset: { type: "string", description: "Bookmark: target revision. Default @." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const action = String(args.action);
      const beforeOpId = await latestOpId(ctx, settings, cwd);
      const revs = Array.isArray(args.revsets)
        ? args.revsets.filter((rev): rev is string => typeof rev === "string")
        : [];
      const owned = await ownershipIssue(
        ctx,
        settings,
        cwd,
        action === "stack"
          ? revs
          : action === "squash"
            ? [...revs, ...(typeof args.into === "string" ? [args.into] : [])]
            : [],
      );
      if (owned.error !== undefined) return owned.error;
      if (action === "stack") {
        if (revs.length === 0 || typeof args.onto !== "string") {
          return toolError(ErrorCode.JJ_EXEC_FAILED, "jj_group stack needs revsets and onto.");
        }
        const changes: string[] = [];
        for (const rev of revs) {
          const rows = await jjJson(
            ctx,
            settings,
            cwd,
            readOnly(["log", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", rev, "--limit", "2"]),
          );
          if (!Array.isArray(rows) || rows.length !== 1) {
            return toolError(
              ErrorCode.JJ_EXEC_FAILED,
              `jj_group stack could not resolve ${rev} to exactly one change.`,
              "Pass change ids or single-revision revsets.",
            );
          }
          changes.push(String((rows[0] as { change_id: string }).change_id));
        }
        let parent = args.onto;
        for (const change of changes) {
          const rebased = await jj(ctx, settings, cwd, ["rebase", "-r", change, "-o", parent]);
          if (typeof rebased !== "string") return rebased;
          parent = change;
        }
        let bookmark: string | null = null;
        if (typeof args.bookmark === "string" && args.bookmark.length > 0) {
          const set = await jj(ctx, settings, cwd, [
            "bookmark",
            "set",
            args.bookmark,
            "-r",
            changes[changes.length - 1]!,
          ]);
          if (typeof set === "string") bookmark = args.bookmark;
        }
        return {
          action,
          changes,
          parent,
          bookmark,
          beforeOpId,
          opId: (await latestOpId(ctx, settings, cwd)) ?? null,
          ...(owned.warning === undefined ? {} : { warning: owned.warning }),
        };
      }
      if (action === "merge") {
        if (revs.length === 0) {
          return toolError(
            ErrorCode.JJ_EXEC_FAILED,
            "jj_group merge needs at least one revision in revsets.",
          );
        }
        const message =
          typeof args.message === "string" && args.message.length > 0
            ? args.message
            : `group: merge ${revs.length} changes`;
        const raw = await jj(ctx, settings, cwd, ["new", ...revs, "-m", message]);
        if (typeof raw !== "string") return raw;
        let bookmark: string | null = null;
        if (typeof args.bookmark === "string" && args.bookmark.length > 0) {
          const set = await jj(ctx, settings, cwd, ["bookmark", "set", args.bookmark, "-r", "@"]);
          if (typeof set === "string") bookmark = args.bookmark;
        }
        return {
          action,
          stdout: raw,
          bookmark,
          beforeOpId,
          opId: (await latestOpId(ctx, settings, cwd)) ?? null,
        };
      }
      if (action === "squash") {
        if (revs.length === 0 || typeof args.into !== "string") {
          return toolError(ErrorCode.JJ_EXEC_FAILED, "jj_group squash needs revsets and into.");
        }
        const raw = await jj(ctx, settings, cwd, [
          "squash",
          "--from",
          revs.join("|"),
          "--into",
          args.into,
        ]);
        if (typeof raw !== "string") return raw;
        return {
          action,
          stdout: raw,
          beforeOpId,
          opId: (await latestOpId(ctx, settings, cwd)) ?? null,
          ...(owned.warning === undefined ? {} : { warning: owned.warning }),
        };
      }
      if (typeof args.bookmark !== "string" || args.bookmark.length === 0) {
        return toolError(ErrorCode.JJ_EXEC_FAILED, "jj_group bookmark needs bookmark.");
      }
      const raw = await jj(ctx, settings, cwd, [
        "bookmark",
        "set",
        args.bookmark,
        "-r",
        typeof args.revset === "string" ? args.revset : "@",
      ]);
      if (typeof raw !== "string") return raw;
      return {
        action,
        stdout: raw,
        beforeOpId,
        opId: (await latestOpId(ctx, settings, cwd)) ?? null,
      };
    }),
  });

  register({
    name: "jj_sign",
    description:
      "Sign or unsign revisions with the configured signing backend. Requires jj signing config; without it jj reports the missing backend.",
    parameters: {
      action: { type: "string", enum: ["sign", "unsign"], required: true },
      revsets: { type: "string", description: "Revisions to sign or unsign. Default @." },
    },
    output: JSON_OUTPUT,
    execute: onWorkspaceRoot(async (args, cwd) => {
      const action = args.action === "unsign" ? "unsign" : "sign";
      const beforeOpId = await latestOpId(ctx, settings, cwd);
      const raw = await jj(ctx, settings, cwd, [
        action,
        "-r",
        typeof args.revsets === "string" ? args.revsets : "@",
      ]);
      if (typeof raw !== "string") return raw;
      return {
        action,
        stdout: raw,
        beforeOpId,
        opId: (await latestOpId(ctx, settings, cwd)) ?? null,
      };
    }),
  });

  return definitions;
}

/**
 * Build the argv for `jj bookmark`.
 *
 * The revision flag is **not** the same across subcommands, and passing the
 * wrong one is a hard error rather than a no-op:
 *
 * | Subcommand | Revision flag |
 * |---|---|
 * | `create`, `set` | `-r <REVSET>` |
 * | `move` | `--to <REVSET>` — it has no `-r` at all |
 * | `delete`, `forget`, `rename` | neither; positional names only |
 *
 * Verified with `jj help bookmark <sub>` on 0.46.0. Exported so the mapping is
 * testable without a live shell.
 */
export function bookmarkArgv(
  action: string,
  name?: string,
  revset?: string,
  newName?: string,
): string[] {
  const argv = ["bookmark", action];
  if (name !== undefined) argv.push(name);
  // `rename` takes TWO positional names — `jj bookmark rename <OLD> <NEW>` —
  // and a single one is a usage error.
  if (action === "rename" && newName !== undefined) argv.push(newName);
  if (revset !== undefined) {
    if (action === "move") argv.push("--to", revset);
    else if (action === "create" || action === "set") argv.push("-r", revset);
  }
  return argv;
}

/**
 * Register the tool set.
 *
 * A workspace is deliberately NOT required at registration time: the tools must
 * exist so the model can be told `NOT_JJ_WORKSPACE` with a hint, rather than the
 * tool silently not being there. The *registry* is required, and it is read
 * through the same accessor it is written through.
 */
export function applyTools(ctx: Context, settings: Settings): void {
  // Read the registry through **either** shape. `ctx.tools` is the Cordis service
  // accessor a shipped plugin uses (`dsh-tool-bash` registers this way), and
  // `ctx.get('tools')` is the lookup. They are the same service, but a plugin
  // mounted by a third-party bundle is not guaranteed the property form — and
  // when the property form is absent, a single-accessor check silently registers
  // nothing at all, which is exactly what happened on the first live install.
  const registry =
    (ctx.tools as ToolRegistry | undefined) ?? (ctx.get("tools") as ToolRegistry | undefined);
  if (registry === undefined) return;

  const allowed = new Set<string>(
    settings.toolset === "minimal"
      ? MINIMAL_TOOL_NAMES
      : settings.toolset === "core"
        ? CORE_TOOL_NAMES
        : TOOL_NAMES,
  );

  for (const definition of buildToolDefinitions(ctx, settings)) {
    if (!allowed.has(String(definition.name))) continue;
    try {
      registry.register(defineTool(definition as never));
    } catch {
      // A duplicate name means another copy is mounted; registering nothing is
      // better than failing the whole plugin load.
    }
  }
}

/** The slice of the tool registry this plugin uses. */
interface ToolRegistry {
  register(definition: unknown): () => void;
}
