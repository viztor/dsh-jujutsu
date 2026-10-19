/**
 * Adopting a plain Git repository for Jujutsu.
 *
 * ## What "adopt" means, and what it deliberately is not
 *
 * `jj git init --colocate` adds `.jj` beside an existing `.git` and imports the
 * Git history. The repository stays a Git repository — `git log`, `git status`,
 * `git fetch` and every other Git tool keep working, because `.git` is the
 * source of truth and jj keeps it in sync. That is the "Git-compatible" half of
 * the feature: the user gets jj, and nothing that reads Git can tell.
 *
 * It is **not** a conversion. Nothing is rewritten, no history is replaced, and
 * the whole thing is undone by `jj git colocation disable` or by deleting
 * `.jj`. The cost of being wrong is one directory.
 *
 * ## Why a compatibility probe exists at all
 *
 * `jj` does not model everything Git does, and the gaps are not symmetric: some
 * are harmless, and one silently corrupts the repository. Each blocker below
 * was measured against `jj` 0.46.0 rather than inferred:
 *
 * - **LFS is the dangerous one.** `jj` does not run Git's clean/smudge filters,
 *   so a working file that Git smudged from an LFS pointer looks *modified* to
 *   jj — the commit holds the pointer, the worktree holds the bytes, and they
 *   differ. `jj status` reports `M big.bin` immediately after colocation, and a
 *   commit would write the raw bytes over the pointer. Every other clone of the
 *   repository then gets a broken object. This is the only blocker that can
 *   destroy data, and it is why the probe is not merely advisory.
 * - **Submodules.** jj prints `ignoring git submodule at "<path>"`. The gitlink
 *   and `.gitmodules` survive in commits, so history is not lost, but jj never
 *   materialises or updates the submodule working copy. An agent told "jj is
 *   available here" would silently operate on a tree missing the submodule.
 * - **A shallow clone.** jj imports the truncated history and has no ancestry
 *   to rewrite. Verified: after colocating a `--depth 1` clone, jj's view of
 *   `main` is the single imported commit.
 * - **A linked worktree.** Here `.git` is a *file*. `jj git init --colocate`
 *   answers `Initialized a new colocated jj repo inside a Git worktree` and
 *   creates a second, unrelated repository inside the worktree — a duplicate,
 *   not a workspace. `jj workspace add` is the correct tool and is out of scope.
 * - **An operation in progress.** Adopting mid-merge or mid-rebase bakes a
 *   half-finished state into the import, and the user's next `git` command
 *   would fight it.
 *
 * A repository with none of these is adopted. The probe is static — directory
 * and file reads, no `jj` invocation, no writes — so it is cheap enough to run
 * before deciding, and it is safe to run against a repository that is never
 * adopted.
 *
 * ## What it does not cover
 *
 * A `.gitattributes` in a subdirectory can also declare `filter=lfs`. Scanning
 * the whole tree for that would mean a recursive walk on the session-start path,
 * so only the repository root is read. The gap is deliberate and documented in
 * `docs/37-git-compatible-adoption.md`: a root `.gitattributes` is where LFS is
 * initialised in practice, and a false negative here is no worse than the
 * status quo, where the plugin does nothing in a plain Git repo at all.
 *
 * @module dsh-jujutsu/adopt
 */

import type { Context } from "@deepseek-ai/cordis";

import type { Settings } from "./settings.ts";
import { runJj } from "./shell.ts";

/**
 * Why a repository cannot be handed to Jujutsu.
 *
 * The names are the contract: `preflight.ts` stores them in the session state
 * and `context.ts` renders {@link blockerText} from them, so renaming one is a
 * behaviour change rather than a refactor.
 */
export type AdoptBlocker = "git-file" | "shallow" | "submodules" | "lfs" | "in-progress";

/**
 * Everything that can stop an adoption, including the one that is not a
 * property of the repository: `jj git init` itself failing.
 *
 * Kept separate from {@link AdoptBlocker} on purpose. A blocker is a fact about
 * the repository that a user could resolve and retry; `init-failed` is an
 * environment failure, and conflating the two would let a transient error be
 * reported as "this repository uses submodules".
 */
export type AdoptFailure = AdoptBlocker | "init-failed";

/** The result of asking whether a repository can be adopted. */
export type AdoptProbe =
  | { readonly ok: true }
  | { readonly ok: false; readonly blocker: AdoptBlocker; readonly evidence: string };

/** The result of attempting one. */
export type AdoptResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly blocker: AdoptFailure; readonly evidence: string };

/**
 * The files that mean a Git operation is half-finished.
 *
 * `rebase-merge` and `rebase-apply` are the two shapes a rebase leaves behind
 * (interactive and not), and the rest are the single-file markers. `index.lock`
 * is deliberately **not** here: a stale lock is a common, harmless annoyance and
 * refusing on it would block adoption for a reason the user cannot see.
 */
const IN_PROGRESS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
] as const;

/** One sentence naming a blocker, for the model and the human. */
export function blockerText(blocker: AdoptBlocker | "init-failed"): string {
  switch (blocker) {
    case "git-file":
      return "this is a linked Git worktree or a submodule checkout (.git is a file), and jj would create a second, separate repository inside it";
    case "shallow":
      return "this is a shallow clone, and jj would import a history with no ancestry to work from";
    case "submodules":
      return "this repository uses Git submodules, which jj records but never checks out or updates";
    case "lfs":
      return "this repository uses Git LFS, and jj does not run Git's smudge filter, so it would commit the raw file over the LFS pointer";
    case "in-progress":
      return "a Git operation is in progress (merge, rebase, cherry-pick, revert or bisect), so adopting now would import a half-finished state";
    case "init-failed":
      // Deliberately not "the repository was left as it was". A failure that
      // happens after `.jj` is created — a timeout on a very large history, a
      // full disk — leaves a partial workspace behind, and the fs service this
      // plugin is allowed to use has no remove call, so there is nothing to
      // clean up with. Saying so is better than a reassurance that is sometimes
      // false.
      return "jj git init --colocate failed; check jj status before relying on Jujutsu in this repository";
  }
}

/**
 * Would `jj git init --colocate` be safe here?
 *
 * Static and read-only: no `jj` process, no writes. Returns the **first**
 * blocker in the order the type lists them, so a repository that is both shallow
 * and submoduled always reports the same reason.
 *
 * @param ctx - plugin context, for `ctx.fs`.
 * @param root - the root of a plain Git repository, as `detect` reported it.
 */
export async function probeAdoption(ctx: Context, root: string): Promise<AdoptProbe> {
  const gitType = await typeOf(ctx, `${root}/.git`);

  // No `.git` at all is not this function's case: `preflight` only asks about a
  // repository `detect` already classified as Git. Treated as adoptable so that
  // a caller reaching here by mistake gets jj's own error rather than a blocker
  // that names the wrong feature.
  if (gitType === undefined) return { ok: true };

  if (gitType !== "directory") {
    return {
      ok: false,
      blocker: "git-file",
      evidence: `${root}/.git is a file, not a directory`,
    };
  }

  if (await exists(ctx, `${root}/.git/shallow`)) {
    return { ok: false, blocker: "shallow", evidence: `${root}/.git/shallow exists` };
  }

  // `.gitmodules` is the declared list; `.git/modules` is where the submodule
  // repositories are stored. Either alone is enough: a repository whose
  // `.gitmodules` was deleted but whose modules are still present has the same
  // problem.
  if (await exists(ctx, `${root}/.gitmodules`)) {
    return { ok: false, blocker: "submodules", evidence: `${root}/.gitmodules exists` };
  }
  if ((await typeOf(ctx, `${root}/.git/modules`)) === "directory") {
    return { ok: false, blocker: "submodules", evidence: `${root}/.git/modules exists` };
  }

  // LFS: the object store is the reliable signal, the attribute line is the
  // declaration. Check the store first because it is one stat, and the
  // attributes file needs a read.
  if ((await typeOf(ctx, `${root}/.git/lfs`)) === "directory") {
    return { ok: false, blocker: "lfs", evidence: `${root}/.git/lfs exists` };
  }
  const attributes = await readTextOf(ctx, `${root}/.gitattributes`);
  if (attributes !== undefined && /filter\s*=\s*lfs/.test(attributes)) {
    return {
      ok: false,
      blocker: "lfs",
      evidence: `${root}/.gitattributes declares filter=lfs`,
    };
  }

  for (const marker of IN_PROGRESS) {
    if (await exists(ctx, `${root}/.git/${marker}`)) {
      return {
        ok: false,
        blocker: "in-progress",
        evidence: `${root}/.git/${marker} exists`,
      };
    }
  }

  return { ok: true };
}

/**
 * Probe, then run `jj git init --colocate` when the repository is compatible.
 *
 * **Idempotent by checking first, not by retrying.** `jj git init --colocate`
 * is not idempotent: on a repository that already has `.jj` it exits 1 with
 * `Error: The target repo already exists`. So an existing `.jj` short-circuits
 * before the process starts. A session that runs preflight twice — a remount, a
 * second agent on the same workspace — must not turn a working repository into
 * an error.
 *
 * A failure is returned, never thrown. The caller runs inside an
 * `agent/created` listener, where a throw fails session creation — a plugin that
 * cannot adopt a repository must leave it alone and let the session start.
 *
 * @param ctx - plugin context.
 * @param settings - resolved configuration, for `jjPath`.
 * @param root - the root of a plain Git repository.
 */
export async function adoptRepo(
  ctx: Context,
  settings: Settings,
  root: string,
): Promise<AdoptResult> {
  // Already adopted. Not a probe blocker — `.jj` beside `.git` is the goal, not
  // a reason to refuse — so it is handled here rather than in `probeAdoption`.
  if ((await typeOf(ctx, `${root}/.jj`)) !== undefined) return { ok: true };

  const probe = await probeAdoption(ctx, root);
  if (!probe.ok) return probe;

  try {
    const result = await runJj(ctx, settings.jjPath, ["git", "init", "--colocate"], {
      cwd: root,
      timeoutMs: 30_000,
    });
    if (result.exitCode === 0) return { ok: true };
    return {
      ok: false,
      blocker: "init-failed",
      evidence: firstLine(result.stderr) || `jj exited ${String(result.exitCode)}`,
    };
  } catch (error) {
    return {
      ok: false,
      blocker: "init-failed",
      evidence: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The first non-empty line of a stream, trimmed — enough for an evidence string. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** `ctx.fs.stat` narrowed to a type, with every failure reading as "absent". */
async function typeOf(
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

/** Whether anything exists at `path`, of any type. */
async function exists(ctx: Context, path: string): Promise<boolean> {
  return (await typeOf(ctx, path)) !== undefined;
}

/** File contents, or `undefined` when the file is absent or unreadable. */
async function readTextOf(ctx: Context, path: string): Promise<string | undefined> {
  try {
    const fs = ctx.get("fs");
    if (fs === undefined) return undefined;
    const target = await fs.resolve(path);
    const info = await fs.stat(target);
    if (info?.type !== "file") return undefined;
    return await fs.readText(target);
  } catch {
    return undefined;
  }
}
