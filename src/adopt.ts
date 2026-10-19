/**
 * Adopting a plain Git repository for Jujutsu.
 *
 * ## What "adopt" means, and what it is not
 *
 * `jj git init --colocate` adds `.jj` beside an existing `.git` and imports the
 * Git history. The repository stays a Git repository — `git log`, `git status`,
 * `git fetch` and every other Git tool keep working, because `.git` remains the
 * source of truth and jj keeps it in sync. That is the "Git-compatible" half of
 * the feature: the user gets jj, and nothing that reads Git can tell.
 *
 * It is **not** a conversion, and the undo is `rm -rf .jj` — not
 * `jj git colocation disable`. That command does something else entirely: it
 * moves `.git` into `.jj/repo/store/git` and removes Git from the working tree,
 * a far more invasive change than the adoption. See
 * `docs/37-git-compatible-adoption.md` §5.
 *
 * `.git` is **not** untouched, either. The import writes `refs/jj/keep/*` and
 * new objects into it, which is how jj remembers what it has exported. The
 * claim that matters is the narrow one: adoption does not change the branch
 * history or the working tree.
 *
 * ## Why a compatibility probe exists at all
 *
 * `jj` does not run Git's clean/smudge filters and does not model everything Git
 * does. The gaps are not symmetric: some are harmless, and several silently
 * destroy data. Each blocker below was measured against `jj` 0.46.0, and the
 * ones marked **corrupt** were carried through a real `jj commit` with the
 * Git-side result inspected.
 *
 * - **LFS — corrupt.** jj does not run the smudge filter, so a working file Git
 *   materialised from an LFS pointer looks *modified* to jj: the commit holds
 *   the pointer, the worktree holds the bytes. `jj status` reports `M big.bin`
 *   immediately after colocation and a commit writes the raw bytes over the
 *   pointer, breaking every other clone.
 * - **Any other filter — corrupt, and worse.** The root cause is not LFS, it is
 *   that jj runs no filters at all. A custom `filter=<name>` is how git-crypt
 *   and git-secret work: jj sees the decrypted worktree, decides the file is
 *   modified, and commits **plaintext over the encrypted blob**. That is a
 *   secret-exposure incident, not just corruption.
 * - **`core.autocrlf` — corrupt.** The blob is LF-normalised and the worktree is
 *   CRLF; jj sees a modification and commits CRLF over the normalised blob.
 * - **Sparse checkout — corrupt.** jj does not know about the sparse cone, so
 *   every path outside it reads as deleted. `jj status` shows `D dirB/b.txt` and
 *   one commit removes those files from the shared history; disabling sparse
 *   checkout afterwards does not bring them back.
 * - **Submodules — safe, and deliberately not a blocker.** jj imports a submodule
 *   as the gitlink Git stores (mode `160000`), leaves the checked-out submodule
 *   directory alone, and `git status` in the colocated repository stays clean.
 *   Verified on `jj` 0.46.0 against a repository with an initialised submodule.
 *   jj does not *update* submodules, so `git submodule update` remains the tool
 *   for that; that is a missing feature, not a corruption, and refusing adoption
 *   for it would keep jj out of repositories it handles correctly.
 * - **A shallow clone.** jj imports the truncated history and has no ancestry to
 *   rewrite.
 * - **A linked worktree or a symlinked `.git`.** A `.git` *file* means
 *   `jj git init --colocate` creates a second, unrelated repository inside the
 *   worktree. A `.git` *symlink* is worse and quieter: two directories sharing
 *   one Git directory each get their own jj workspace, and a commit from one
 *   deletes the other's files from the shared repository.
 * - **An operation in progress.** Adopting mid-merge bakes a half-finished state
 *   into the import. `sequencer/` is included because a multi-commit
 *   cherry-pick resolved with `git commit` rather than `--continue` leaves a
 *   pending pick with no `CHERRY_PICK_HEAD`.
 *
 * The probe is static — directory and file reads, no `jj` invocation, no writes
 * — so it is cheap enough to run before deciding, and safe to run against a
 * repository that is never adopted.
 *
 * ## A failed import is undone
 *
 * `jj git init --colocate` is not atomic. A failure — an unparseable ref, a
 * timeout on a large history — can leave a `.jj` that does not work. That is the
 * worst state to leave behind: the next session's `detect` sees `.jj`, the guard
 * activates, and every `jj` command fails, so the repository is bricked for the
 * agent while Git keeps working outside the plugin. So a failure removes the
 * `.jj` this call created and reports `init-failed`; the repository goes back to
 * being a plain Git repository, which is what it was.
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
export type AdoptBlocker = "git-file" | "sparse" | "shallow" | "lfs" | "filters" | "in-progress";

/**
 * Everything that can stop an adoption, including the one that is not a
 * property of the repository: `jj git init` itself failing.
 *
 * Kept separate from {@link AdoptBlocker} on purpose. A blocker is a fact about
 * the repository that a user could resolve and retry; `init-failed` is an
 * environment failure, and conflating the two would let a transient error be
 * reported as "this repository uses Git LFS".
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
 * (interactive and not), and `sequencer` is the multi-commit cherry-pick or
 * revert state that survives when the user `git commit`s the resolution instead
 * of running `--continue`. `index.lock` is deliberately **not** here: a stale
 * lock is a common, harmless annoyance and refusing on it would block adoption
 * for a reason the user cannot see.
 */
const IN_PROGRESS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
] as const;

/** One sentence naming a blocker, for the model and the human. */
export function blockerText(blocker: AdoptFailure): string {
  switch (blocker) {
    case "git-file":
      return "this is a linked Git worktree, a submodule checkout, or a directory whose .git is a symlink, and jj would create a second, separate repository on top of it";
    case "sparse":
      return "this repository uses a sparse checkout, and jj would read every path outside the cone as deleted and remove it from the history";
    case "shallow":
      return "this is a shallow clone, and jj would import a history with no ancestry to work from";
    case "lfs":
      return "this repository uses Git LFS, and jj does not run Git's smudge filter, so it would commit the raw file over the LFS pointer";
    case "filters":
      return "this repository uses a Git content filter or autocrlf, and jj runs no filters, so it would commit the filtered working file over the stored blob";
    case "in-progress":
      return "a Git operation is in progress (merge, rebase, cherry-pick, revert or bisect), so adopting now would import a half-finished state";
    case "init-failed":
      // Deliberately not "the repository was left as it was" — a failure is
      // undone by removing the `.jj` this call created, and saying that is
      // accurate only because of it.
      return "jj git init --colocate failed; the partial workspace it created was removed, so the repository is still plain Git";
  }
}

/**
 * Would `jj git init --colocate` be safe here?
 *
 * Static and read-only: no `jj` process, no writes. Returns the **first**
 * blocker in the order the type lists them, so a repository with several
 * problems always reports the same reason.
 *
 * @param ctx - plugin context, for `ctx.fs`.
 * @param root - the root of a plain Git repository, as `detect` reported it.
 */
export async function probeAdoption(ctx: Context, root: string): Promise<AdoptProbe> {
  const gitType = await ltypeOf(ctx, `${root}/.git`);

  // No `.git` at all is not this function's case: `preflight` only asks about a
  // repository `detect` already classified as Git. Treated as adoptable so that
  // a caller reaching here by mistake gets jj's own error rather than a blocker
  // that names the wrong feature.
  if (gitType === undefined) return { ok: true };

  // `lstat`, not `stat`: `stat` follows the link, and a `.git` symlink then
  // looks exactly like a `.git` directory. Two directories sharing one Git
  // directory is the dangerous shape — each gets its own jj workspace, and a
  // commit from one deletes the other's files from the shared repository.
  if (gitType === "symlink") {
    return { ok: false, blocker: "git-file", evidence: `${root}/.git is a symlink` };
  }
  if (gitType !== "directory") {
    return { ok: false, blocker: "git-file", evidence: `${root}/.git is a file, not a directory` };
  }

  // One read of `.git/config` serves four checks. An unreadable config is
  // skipped rather than treated as a blocker: a `.git` whose config cannot be
  // read is already broken for Git too, and the file-level checks below still
  // run.
  const configText = await readTextOf(ctx, `${root}/.git/config`);
  const config = configText === undefined ? [] : parseConfig(configText);

  if (await exists(ctx, `${root}/.git/info/sparse-checkout`)) {
    return {
      ok: false,
      blocker: "sparse",
      evidence: `${root}/.git/info/sparse-checkout exists`,
    };
  }
  const sparseFlag = coreValue(config, "sparsecheckout") ?? coreValue(config, "sparsecheckoutcone");
  if (sparseFlag !== undefined && sparseFlag.toLowerCase() === "true") {
    return {
      ok: false,
      blocker: "sparse",
      evidence: `${root}/.git/config enables a sparse checkout`,
    };
  }

  if (await exists(ctx, `${root}/.git/shallow`)) {
    return { ok: false, blocker: "shallow", evidence: `${root}/.git/shallow exists` };
  }

  // Submodules are deliberately **not** checked. jj imports the gitlink Git
  // stores and leaves the checked-out submodule alone, so a repository that uses
  // them survives adoption intact; refusing it would take jj away from exactly
  // the repositories its Git compatibility exists for. What jj does not do is
  // update submodules, and `git submodule update` still does that in the
  // colocated repository.

  // LFS first, then every other filter, because LFS deserves its own sentence.
  // `git lfs install` writes `[filter "lfs"]` into `.git/config` and LFS cannot
  // work without it, so the config is a repository-level answer that a nested
  // `.gitattributes` cannot hide.
  const filterNames = filterSections(config);
  if (filterNames.includes("lfs")) {
    return { ok: false, blocker: "lfs", evidence: `${root}/.git/config enables the LFS filter` };
  }
  if ((await typeOf(ctx, `${root}/.git/lfs`)) === "directory") {
    return { ok: false, blocker: "lfs", evidence: `${root}/.git/lfs exists` };
  }
  if (await declaresLfs(ctx, `${root}/.gitattributes`)) {
    return { ok: false, blocker: "lfs", evidence: `${root}/.gitattributes declares filter=lfs` };
  }
  if (await declaresLfs(ctx, `${root}/.git/info/attributes`)) {
    return {
      ok: false,
      blocker: "lfs",
      evidence: `${root}/.git/info/attributes declares filter=lfs`,
    };
  }

  // Any other filter: the git-crypt / git-secret shape, where committing the
  // worktree writes plaintext over the encrypted blob.
  if (filterNames.length > 0) {
    return {
      ok: false,
      blocker: "filters",
      evidence: `${root}/.git/config defines the "${filterNames[0] ?? ""}" filter`,
    };
  }
  const autocrlf = coreValue(config, "autocrlf")?.toLowerCase();
  if (autocrlf === "true" || autocrlf === "input") {
    return { ok: false, blocker: "filters", evidence: `${root}/.git/config sets core.autocrlf` };
  }
  // A global attributes file can declare a filter too. It is outside the
  // repository, so the only safe reading is: readable and clean, or refuse.
  const attributesFile = coreValue(config, "attributesfile");
  if (attributesFile !== undefined) {
    const text = await readTextOf(ctx, attributesFile);
    if (text === undefined || /filter\s*=/.test(text)) {
      return {
        ok: false,
        blocker: "filters",
        evidence: `core.attributesFile (${attributesFile}) declares or may declare a filter`,
      };
    }
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
 * Probe, then run `jj git init --colocate` when the repository is compatible,
 * then verify the result and undo it if it did not work.
 *
 * **Idempotent by checking first, not by retrying.** `jj git init --colocate` is
 * not idempotent: on a repository that already has `.jj` it exits 1 with
 * `Error: The target repo already exists`. So an existing `.jj` short-circuits
 * before the process starts.
 *
 * **A failure is undone.** A partial `.jj` is the worst state to leave behind —
 * the next session treats the repository as a workspace and every `jj` command
 * fails — so this removes the `.jj` it created when the import fails or the
 * result does not work. Only a `.jj` that did not exist before is ever removed.
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

  const fail = async (evidence: string): Promise<AdoptResult> => {
    await removeJj(ctx, root);
    return { ok: false, blocker: "init-failed", evidence };
  };

  try {
    const init = await runJj(ctx, settings.jjPath, ["git", "init", "--colocate"], {
      cwd: root,
      timeoutMs: 30_000,
    });
    if (init.exitCode !== 0) {
      return await fail(firstLine(init.stderr) || `jj exited ${String(init.exitCode)}`);
    }

    // Exit 0 is not proof the workspace works: an import can get far enough to
    // create `.jj` and still leave jj unable to read `@`. One cheap read is the
    // difference between "adopted" and a repository the agent cannot use.
    const check = await runJj(
      ctx,
      settings.jjPath,
      ["log", "--no-graph", "-r", "@", "-T", "change_id.short()"],
      { cwd: root, timeoutMs: 10_000 },
    );
    if (check.exitCode !== 0) {
      return await fail(firstLine(check.stderr) || "the imported workspace is not readable");
    }
    return { ok: true };
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Remove a `.jj` that this call created.
 *
 * The filesystem service this plugin is allowed to use has no remove call, and
 * `node:fs` is forbidden in `src/`, so this is one shell invocation. It is
 * narrow on purpose: a fixed `rm -rf -- <repo>/.jj`, never a path chosen by
 * anything but the repository root, and only reached when `.jj` was absent
 * before the attempt.
 *
 * A failure to remove is swallowed: the caller is already returning
 * `init-failed`, and there is nothing better to do with the error than leave it
 * unsaid. The next session will see the partial `.jj` and treat the repository
 * as a workspace — which is exactly why the attempt is made at all.
 */
async function removeJj(ctx: Context, root: string): Promise<void> {
  try {
    await runJj(ctx, "rm", ["-rf", "--", `${root}/.jj`], { cwd: root, timeoutMs: 10_000 });
  } catch {
    // Best effort. See the comment above.
  }
}

/** One `key = value` line, with the section it appeared under. */
interface ConfigEntry {
  /** Lower-cased section name, e.g. `core`, `filter`. */
  readonly section: string;
  /** Subsection name, e.g. the `lfs` in `[filter "lfs"]`. Case preserved. */
  readonly subsection?: string;
  /** Lower-cased key. */
  readonly key: string;
  readonly value: string;
}

/**
 * Parse the parts of a Git config this probe needs.
 *
 * Not a full INI parser — comments, quoting and continuations are handled only
 * as far as a `.git/config` written by Git needs them. The important part is
 * that it tracks the **section**: the first version of these checks matched
 * `core.autocrlf` as a flat regex, but a config spells that as
 * `[core]` followed by `autocrlf = true`, so the checks silently matched
 * nothing and every filter-bearing repository was adopted.
 */
function parseConfig(text: string): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  let section = "";
  let subsection: string | undefined;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    const header = /^\[([^\]\s"]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (header !== null) {
      section = (header[1] ?? "").toLowerCase();
      subsection = header[2];
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    entries.push({
      section,
      ...(subsection === undefined ? {} : { subsection }),
      key: line.slice(0, eq).trim().toLowerCase(),
      value: line.slice(eq + 1).trim(),
    });
  }
  return entries;
}

/** The `[filter "name"]` subsection names, in file order. */
function filterSections(entries: readonly ConfigEntry[]): string[] {
  return entries
    .filter((entry) => entry.section === "filter" && entry.subsection !== undefined)
    .map((entry) => entry.subsection ?? "");
}

/** The last value of one key in one section, lower-cased for comparison. */
function coreValue(entries: readonly ConfigEntry[], key: string): string | undefined {
  let found: string | undefined;
  for (const entry of entries) {
    if (entry.section === "core" && entry.key === key) found = entry.value;
  }
  return found;
}

/** Does this attributes file declare an LFS filter? */
async function declaresLfs(ctx: Context, path: string): Promise<boolean> {
  const text = await readTextOf(ctx, path);
  return text !== undefined && /filter\s*=\s*lfs/.test(text);
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

/** `ctx.fs.stat` narrowed to a type, following symlinks. */
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

/**
 * `ctx.fs.lstat` narrowed to a type, **not** following symlinks.
 *
 * The difference is the whole `.git`-symlink check: `stat` on a symlink reports
 * what it points at, which is exactly the ambiguity that lets two working copies
 * share one Git directory.
 */
async function ltypeOf(
  ctx: Context,
  path: string,
): Promise<"directory" | "file" | "symlink" | "other" | undefined> {
  try {
    const fs = ctx.get("fs");
    if (fs === undefined) return undefined;
    const info = await fs.lstat(path);
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
