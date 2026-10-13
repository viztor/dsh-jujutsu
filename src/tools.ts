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

import { ErrorCode } from "./errors.ts";
import { applyHunks, listHunks } from "./hunk.ts";
import type { Settings } from "./settings.ts";
import { runJj } from "./shell.ts";

/**
 * The tool set, in the order `docs/18-tool-surface.md` presents them: four
 * reads, five mutations, two hunk-level. Exported so a test can assert the
 * count without duplicating the list.
 */
export const TOOL_NAMES = [
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

/** Run `jj` and return its raw stdout, or a typed error object. */
async function jj(
  ctx: Context,
  settings: Settings,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const result = await runJj(ctx, settings.jjPath, args, {
      cwd,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode !== 0) {
      return {
        error: {
          code: ErrorCode.JJ_EXEC_FAILED,
          message: `jj exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 300)}`,
          hint: `Run \`jj ${args.join(" ")}\` by hand to see the full output.`,
        },
      };
    }
    return result.stdout;
  } catch (error) {
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
  const raw = await jj(ctx, settings, cwd, ["config", "list", "user"], signal);
  return typeof raw === "string" ? parseIdentity(raw) : undefined;
}

/** The refusal every commit-creating tool returns when the identity is unset. */
function identityRefusal(): unknown {
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
    ["log", "--no-graph", "-T", "conflict", "-r", "@"],
    signal,
  );
  return typeof raw === "string" ? raw.trim() === "true" : undefined;
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
      "Show the Jujutsu working copy: the current revision, its parent, and whether there are unresolved conflicts.",
    parameters: {},
    output: JSON_OUTPUT,
    execute: async (_args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      const revisions = await jjJson(ctx, settings, cwd, [
        "log",
        "--no-graph",
        "-T",
        'json(self) ++ "\\n"',
        "-r",
        "@|@-",
      ]);
      if (!Array.isArray(revisions)) return revisions; // error object
      const conflict = await conflictOf(ctx, settings, cwd);
      return { conflict: conflict ?? null, revisions };
    },
  });

  register({
    name: "jj_log",
    description: "Show revision history as JSON, newest first.",
    parameters: {
      revset: { type: "string", description: "A revset, e.g. `::@` or `all()`." },
      limit: { type: "integer", description: "Maximum revisions to return." },
    },
    output: JSON_OUTPUT,
    execute: async (args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      const revset = typeof args.revset === "string" ? args.revset : "::@";
      const argv = ["log", "--no-graph", "-T", 'json(self) ++ "\\n"', "-r", revset];
      if (typeof args.limit === "number") argv.push("--limit", String(args.limit));
      return jjJson(ctx, settings, cwd, argv);
    },
  });

  register({
    name: "jj_diff",
    description:
      "Show the changes in a revision as JSON. `@` always has a diff; that is normal in Jujutsu.",
    parameters: {
      revset: { type: "string", description: "Defaults to `@`." },
    },
    output: JSON_OUTPUT,
    execute: async (args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      const revset = typeof args.revset === "string" ? args.revset : "@";
      const raw = await jj(ctx, settings, cwd, ["diff", "--summary", "-r", revset]);
      if (typeof raw !== "string") return raw; // error object
      return { files: parseSummary(raw) };
    },
  });

  register({
    name: "jj_op_log",
    description:
      "Show the operation log. Every mutation is recorded and reversible with jj_op_restore — this is the recovery path.",
    parameters: {
      limit: { type: "integer", description: "Maximum operations to return." },
    },
    output: JSON_OUTPUT,
    execute: async (args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      const argv = ["op", "log", "--no-graph", "-T", 'json(self) ++ "\\n"'];
      if (typeof args.limit === "number") argv.push("--limit", String(args.limit));
      return jjJson(ctx, settings, cwd, argv);
    },
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
    execute: async (args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      // `jj new` mints a commit, so an unconfigured identity makes it a trap.
      if ((await identityConfigured(ctx, settings, cwd)) === false) {
        return identityRefusal();
      }
      const argv = ["new"];
      if (typeof args.revset === "string") argv.push(args.revset);
      if (typeof args.message === "string") argv.push("-m", args.message);
      return jj(ctx, settings, cwd, argv);
    },
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
    execute: async (args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      const argv = ["describe", "-m", String(args.message)];
      if (typeof args.revset === "string") argv.push("-r", args.revset);
      return jj(ctx, settings, cwd, argv);
    },
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
    execute: async (args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      const argv = ["squash"];
      if (typeof args.from === "string") argv.push("--from", args.from);
      if (typeof args.into === "string") argv.push("--into", args.into);
      return jj(ctx, settings, cwd, argv);
    },
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
    execute: async (args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      return jj(
        ctx,
        settings,
        cwd,
        bookmarkArgv(
          String(args.action),
          typeof args.name === "string" ? args.name : undefined,
          typeof args.revset === "string" ? args.revset : undefined,
          typeof args.newName === "string" ? args.newName : undefined,
        ),
      );
    },
  });

  register({
    name: "jj_op_restore",
    description:
      "Restore the repository to an earlier operation. This is the undo for everything except a deleted .git or .jj.",
    parameters: {
      opId: { type: "string", description: "Operation id from jj_op_log.", required: true },
    },
    output: JSON_OUTPUT,
    execute: async (args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      return jj(ctx, settings, cwd, ["op", "restore", String(args.opId)]);
    },
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
    execute: async (args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      const outcome = await listHunks(ctx, settings, {
        cwd,
        // The live agent: `ctx.userQuestions.ask` requires it, and the offer to
        // install jj-hunk is the only thing here that needs a human.
        ...agentOf(exec),
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        ...(typeof args.revset === "string" ? { revset: args.revset } : {}),
      });
      return outcome.ok ? outcome.value : outcome.error;
    },
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
    execute: async (args: ToolArgs, exec: unknown) => {
      const cwd = cwdOf(exec);
      if (cwd === undefined) return { error: { code: ErrorCode.WORKSPACE_ROOT_UNRESOLVED } };
      const mode = String(args.mode) as "split" | "commit" | "squash";
      // `squash` moves changes into an existing commit and preserves its author;
      // `split` and `commit` create one, so they are the modes that mint the
      // empty identity.
      if (mode !== "squash" && (await identityConfigured(ctx, settings, cwd)) === false) {
        return identityRefusal();
      }
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
      return outcome.ok ? { stdout: outcome.value } : outcome.error;
    },
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

  for (const definition of buildToolDefinitions(ctx, settings)) {
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
