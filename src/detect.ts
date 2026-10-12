/**
 * Workspace detection, and the effective working directory for one call.
 *
 * ## The two questions, and why they are different
 *
 * 1. **Which directory will this command run in?** — {@link effectiveCwd}. The
 *    session cwd is *not* the answer; the `bash` tool exposes `workdir` and its
 *    own description tells the model to use it instead of `cd`.
 * 2. **Is that directory inside a Jujutsu workspace?** — {@link detect}. This
 *    **walks upward**, because `jj` works from any subdirectory of a repo: an
 *    agent that `cd`s into `src/` and runs `git commit` is still inside the
 *    workspace, and a detector that only checked `src/.jj` would say "no" and
 *    let the Git command through.
 *
 * Detection is a filesystem question, not a heuristic. Measured across every
 * layout (`docs/13-empirical-verification.md` §1–2):
 *
 * | Layout | `.jj` | `.git` |
 * |---|---|---|
 * | `jj git init` (the default) | directory | **directory** |
 * | `jj git init --no-colocate` | directory | absent |
 * | `jj workspace add` (secondary) | **directory** | **file** |
 * | plain Git | absent | directory |
 *
 * So `.jj` is always a directory — including in a secondary workspace, where it
 * is `.git` that becomes a file. `isDirectory('.jj')` is the whole test.
 *
 * @module dsh-jujutsu/detect
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

import { readString } from "./guard-utils.ts";

export type WorkspaceKind = "jj-native" | "jj-colocated" | "none";

/**
 * What version control, if any, governs a directory.
 *
 * `"none"` is the case the plugin used to be silent about, and it is worth
 * naming: a directory with neither `.jj` nor `.git` is one where the agent
 * should *offer* to initialise something, preferring Jujutsu.
 */
export type VcsKind = "jj" | "git" | "none";

export interface Detection {
  readonly kind: WorkspaceKind;
  /** The workspace root — the directory containing `.jj`. Empty when `none`. */
  readonly root: string;
  readonly hasGitDir: boolean;
  readonly hasGitFile: boolean;
  /** What governs this directory, nearest ancestor first. */
  readonly vcs: VcsKind;
  /** The root of a plain Git repo, when that is what governs. */
  readonly vcsRoot: string;
}

/** How far up to walk before giving up. A repo is never 64 levels deep. */
const MAX_DEPTH = 64;

/**
 * Resolve the directory a `bash` call will actually run in.
 *
 * The `bash` tool resolves it with `resolveWorkdir(modelWorkdir, exec,
 * policyWorkspaceRoot)` (`dsh-tool-bash/lib/index.js:293`), where a resolved
 * sandbox-policy root wins over the session cwd and a relative workdir is joined
 * by string concatenation. `docs/29` §3 settles that the guard can read the same
 * `policyWorkspaceRoot` from `ctx.get('sandboxPolicy')`, and that in every
 * ordinary session it equals `session.header.cwd` anyway.
 *
 * Getting this wrong is wrong in both directions: a Git command run with
 * `workdir: '../other'` inside another `jj` repo slips through, and a Git command
 * in a non-`jj` sibling is refused because the *session* root is a `jj` repo.
 *
 * @param exec - the pending call.
 * @param policyWorkspaceRoot - the resolved sandbox-policy root, when one applies.
 * @returns the absolute directory, or `undefined` for a non-agent caller.
 */
export function effectiveCwd(
  exec: ToolExecution,
  policyWorkspaceRoot?: string,
): string | undefined {
  const sessionCwd = policyWorkspaceRoot ?? exec.agent?.session.header.cwd ?? undefined;
  const modelWorkdir = readString(exec.arguments, "workdir");
  if (modelWorkdir === undefined) return sessionCwd;
  if (sessionCwd === undefined) return modelWorkdir;
  return modelWorkdir.startsWith("/") ? modelWorkdir : `${sessionCwd}/${modelWorkdir}`;
}

/**
 * How long a **negative** answer may be trusted.
 *
 * A positive ("this is a `jj` workspace") is stable — a workspace does not stop
 * being one — so it is cached until a layout-changing command invalidates it. A
 * negative is not: `jj git init` in a terminal, in another tool, or while the
 * plugin happened to be unmounted turns a plain directory into a workspace, and
 * a cached `none` would keep the plugin blind for the rest of the session.
 *
 * So negatives expire. The cost is one walk per root per window, and the walk is
 * a couple of `stat`s in the common case.
 */
const NEGATIVE_TTL_MS = 2_000;

/** Per-root cache. Detection is two `stat`s and a walk; do it once per root. */
const CACHE = new Map<string, { readonly value: Detection; readonly at: number }>();

/** Drop every cached result. */
export function invalidateDetection(): void {
  CACHE.clear();
}

/**
 * Commands after which the workspace layout may have changed.
 *
 * A `jj git init` or `jj workspace add` inside a `bash` call turns a plain
 * directory into a workspace, so a cached "none" must not survive it. This is
 * the invalidation rule that acceptance criterion 7 in `docs/12` §H depends on.
 */
export function mayChangeLayout(command: string): boolean {
  return /\bjj\s+(git\s+init|workspace\s+add|git\s+clone|git\s+colocation)\b/.test(command);
}

/**
 * Detect the workspace containing `start`.
 *
 * Walks upward from `start` looking for a `.jj` directory, so a command run in a
 * subdirectory is still recognised as being inside the repo.
 *
 * @param ctx - plugin context, for `ctx.fs`.
 * @param start - absolute directory to start from.
 */
export async function detect(ctx: Context, start: string): Promise<Detection> {
  const key = normalize(start);

  const entry = CACHE.get(key);
  if (entry !== undefined) {
    const fresh = entry.value.vcs !== "none" || Date.now() - entry.at < NEGATIVE_TTL_MS;
    if (fresh) return entry.value;
    CACHE.delete(key);
  }

  const found = await findVcs(ctx, key);
  const result: Detection =
    found.kind === "jj"
      ? await describe(ctx, found.root)
      : {
          kind: "none",
          root: "",
          hasGitDir: false,
          hasGitFile: false,
          vcs: found.kind,
          vcsRoot: found.root,
        };

  CACHE.set(key, { value: result, at: Date.now() });
  return result;
}

/**
 * Walk up from `start` to the nearest ancestor containing `.jj`.
 *
 * @returns the absolute root, or `undefined` when no ancestor is a workspace.
 */
export async function findWorkspaceRoot(ctx: Context, start: string): Promise<string | undefined> {
  const found = await findVcs(ctx, start);
  return found.kind === "jj" ? found.root : undefined;
}

/**
 * Find the nearest version-control root, whichever kind it is.
 *
 * One walk, checking `.jj` before `.git` at each level, so the **nearest** root
 * governs: a Git repo nested inside a Jujutsu workspace resolves to the inner
 * repo, and a workspace nested inside a Git repo resolves to the workspace.
 * Walking twice would need a tie-break rule that this ordering already is.
 *
 * @returns the governing kind and root; `none` with an empty root when neither
 *   is found before the filesystem root or {@link MAX_DEPTH}.
 */
export async function findVcs(
  ctx: Context,
  start: string,
): Promise<{ kind: VcsKind; root: string }> {
  let dir = normalize(start);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if ((await safeType(ctx, `${dir}/.jj`)) === "directory") {
      return { kind: "jj", root: dir };
    }
    const git = await safeType(ctx, `${dir}/.git`);
    if (git === "directory" || git === "file") {
      return { kind: "git", root: dir };
    }

    const parent = dirname(dir);
    if (parent === dir || parent === "") break;
    dir = parent;
  }
  return { kind: "none", root: "" };
}

/** Describe a known workspace root. */
async function describe(ctx: Context, root: string): Promise<Detection> {
  const git = await safeType(ctx, `${root}/.git`);
  return {
    kind: git === undefined ? "jj-native" : "jj-colocated",
    root,
    hasGitDir: git === "directory",
    // In a secondary workspace (`jj workspace add`) `.git` is a *file* holding
    // `gitdir: ../<main>/.git/worktrees/<name>`.
    hasGitFile: git === "file",
    vcs: "jj",
    vcsRoot: root,
  };
}

/**
 * `stat` that never throws, returning only the type.
 *
 * **Two calls, not one.** `stat` takes an `FsTarget`, not a path — `resolve()`
 * produces the target and every other operation consumes it
 * (`dsh-fs/lib/types/index.d.ts:94`, `:138`). This was an open question in
 * `docs/24` §6 until the dependency was installed and the types could be read;
 * the answer is that `resolve` is mandatory.
 *
 * A detector that throws must not reach the caller: inside `tools/pre-execute`
 * a throw becomes a tool error that skips `post-execute`
 * (`docs/31-probe-results-pipeline.md` Q1), and inside `agent/created` it fails
 * session creation outright (Q3). Hence the swallow.
 */
async function safeType(
  ctx: Context,
  path: string,
): Promise<"directory" | "file" | "other" | undefined> {
  try {
    const fs = ctx.get("fs");
    if (fs === undefined) return undefined;
    const target = await fs.resolve(path);
    const info = await fs.stat(target);
    return info?.type;
  } catch {
    return undefined;
  }
}

/** Strip a trailing slash, but keep `/` itself. */
function normalize(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/** Parent directory, using string maths so no `node:path` import is needed. */
function dirname(path: string): string {
  const trimmed = normalize(path);
  const at = trimmed.lastIndexOf("/");
  if (at < 0) return "";
  if (at === 0) return "/";
  return trimmed.slice(0, at);
}
