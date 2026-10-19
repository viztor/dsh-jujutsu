/**
 * Adopting a plain Git repository into Jujutsu, and refusing the ones that
 * cannot be adopted faithfully.
 *
 * The two halves fail in different ways, so they are tested differently:
 *
 * 1. **The probe** is a static filesystem check, so its tests build `.git/` by
 *    hand. No `git`, no `jj` — which is the point: a probe that needed a binary
 *    could not answer before the workspace existed, and the decision it informs
 *    is exactly whether to create one.
 * 2. **The adoption** runs the real `jj git init --colocate`, so those tests use
 *    a real `git init` and `realShell(ctx)`. A mocked shell would prove that the
 *    plugin can assemble an argv, not that `jj` accepts it. Measured on 0.46.0:
 *    a second `jj git init --colocate` exits 1 with "The target repo already
 *    exists", which is why idempotency has to be a real check rather than a
 *    retry.
 *
 * Every `jj` invocation carries `JJ_CONFIG` pointing inside this file's own temp
 * root. `test/hermetic.test.ts` bans the alternatives by name: `~/.config/jj` is
 * not writable under the DSH file sandbox, so an identity written there is a
 * suite that is red on exactly the machines the plugin ships to.
 *
 * The refusals are not politeness. `lfs` is the dangerous one: jj does not run
 * Git's clean/smudge filters, so it reads the smudged working file as modified
 * and would commit raw bytes over the LFS pointer. A probe that let that repo
 * through would corrupt it for every other clone.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { adoptRepo, blockerText, probeAdoption } from "../src/adopt.ts";
import type { AdoptBlocker } from "../src/adopt.ts";
import { detect, invalidateDetection } from "../src/detect.ts";
import { resolveSettings } from "../src/settings.ts";
import { declaredTests, fakeHarness, HAS_JJ, realShell, REQUIRE_TOOLS } from "./helpers.ts";

/**
 * Whether `git` is on PATH.
 *
 * The real-adoption tests drive it to build their input, so a missing binary has
 * to skip rather than fail with `exited 127`. The counter below then turns that
 * skip into a failure under `DSH_JUJUTSU_REQUIRE_TOOLS=1`, because a skipped
 * end-to-end test is worse than none.
 */
const HAS_GIT = ((): boolean => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * A root unique to this process.
 *
 * Created in `beforeAll`, not at module scope: a module-scope `mkdtemp` runs at
 * collection time, and a suite that never executes would still leave the
 * directory behind (`test/marker.test.ts` records the measurement).
 */
let ROOT = "";

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "dsh-jujutsu-adopt-"));
});

afterAll(() => {
  if (ROOT !== "") rmSync(ROOT, { recursive: true, force: true });
});

/** A case directory under this file's root. */
function caseDir(name: string): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A root whose `.git` is a directory — the shape an ordinary clone has. */
function gitDirAt(name: string): string {
  const root = caseDir(name);
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

/** A `.gitattributes` line that marks files as Git LFS. */
const LFS_ATTRIBUTES = "*.bin filter=lfs diff=lfs merge=lfs -text\n";

/**
 * The refusal, narrowed, or a failure naming what came back instead.
 *
 * `init-failed` is allowed in the blocker position because `adoptRepo` can fail
 * for an environmental reason as well as a repository one; the probe tests still
 * assert the exact five, so widening the helper does not weaken them.
 */
type Refusal =
  | {
      readonly ok: false;
      readonly blocker: AdoptBlocker | "init-failed";
      readonly evidence: string;
    }
  | { readonly ok: true };

function refusal(probe: Refusal): {
  blocker: AdoptBlocker | "init-failed";
  evidence: string;
} {
  expect(probe.ok, "expected a refusal").toBe(false);
  if (probe.ok) throw new Error("the probe accepted a repository it must refuse");
  return probe;
}

describe("the compatibility probe", () => {
  it("refuses a `.git` file, which is a linked worktree or a submodule checkout", async () => {
    // `jj git init --colocate` succeeds there and creates a *duplicate*
    // repository beside the real one, so the refusal has to happen before the
    // init runs.
    const root = caseDir("git-file");
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");

    const { ctx } = fakeHarness();
    const bad = refusal(await probeAdoption(ctx, root));
    expect(bad.blocker).toBe("git-file");
    expect(bad.evidence).toContain(".git");
  });

  it("refuses a shallow clone, whose history has no ancestry to rewrite", async () => {
    const root = gitDirAt("shallow");
    writeFileSync(join(root, ".git/shallow"), "0000000000000000000000000000000000000000\n");

    const { ctx } = fakeHarness();
    const bad = refusal(await probeAdoption(ctx, root));
    expect(bad.blocker).toBe("shallow");
    expect(bad.evidence).toContain("shallow");
  });

  it("refuses a repo with submodules, which jj would silently never update", async () => {
    // jj prints `ignoring git submodule at "<path>"` and keeps the gitlink in
    // commits; a clone through jj then never materialises the submodule.
    const root = gitDirAt("submodules-file");
    writeFileSync(
      join(root, ".gitmodules"),
      '[submodule "vendor"]\n\tpath = vendor\n\turl = https://example.invalid/vendor\n',
    );

    const { ctx } = fakeHarness();
    const bad = refusal(await probeAdoption(ctx, root));
    expect(bad.blocker).toBe("submodules");
    expect(bad.evidence).toContain("gitmodules");
  });

  it("refuses a repo with a `.git/modules` directory, the same feature by another shape", async () => {
    // A checkout whose `.gitmodules` was deleted still carries the submodule
    // data. Checking only the tracked file would adopt it.
    const root = gitDirAt("submodules-dir");
    mkdirSync(join(root, ".git/modules/vendor"), { recursive: true });

    const { ctx } = fakeHarness();
    const bad = refusal(await probeAdoption(ctx, root));
    expect(bad.blocker).toBe("submodules");
    expect(bad.evidence).toContain("modules");
  });

  it("refuses a Git LFS repo, which jj would corrupt on the next commit", async () => {
    // The dangerous blocker: jj sees the smudged working file as modified and
    // commits the raw bytes over the LFS pointer.
    const root = gitDirAt("lfs-attributes");
    writeFileSync(join(root, ".gitattributes"), LFS_ATTRIBUTES);

    const { ctx } = fakeHarness();
    const bad = refusal(await probeAdoption(ctx, root));
    expect(bad.blocker).toBe("lfs");
    expect(bad.evidence).toMatch(/gitattributes|filter=lfs/i);
  });

  it("refuses a repo with a `.git/lfs` directory, even with no `.gitattributes`", async () => {
    const root = gitDirAt("lfs-dir");
    mkdirSync(join(root, ".git/lfs/objects"), { recursive: true });

    const { ctx } = fakeHarness();
    const bad = refusal(await probeAdoption(ctx, root));
    expect(bad.blocker).toBe("lfs");
    expect(bad.evidence).toContain("lfs");
  });

  it("refuses every in-progress Git operation, naming the marker it found", async () => {
    // Adopting mid-operation bakes a half-finished state into the import: the
    // merge, rebase or bisect would be frozen at whatever step it had reached.
    // The two rebase markers are directories in a real repository, so they are
    // built as directories here rather than as files.
    const markers: { readonly path: string; readonly directory: boolean }[] = [
      { path: ".git/MERGE_HEAD", directory: false },
      { path: ".git/rebase-merge", directory: true },
      { path: ".git/rebase-apply", directory: true },
      { path: ".git/CHERRY_PICK_HEAD", directory: false },
      { path: ".git/REVERT_HEAD", directory: false },
      { path: ".git/BISECT_LOG", directory: false },
    ];

    for (const [index, marker] of markers.entries()) {
      const root = gitDirAt(`in-progress-${index}`);
      const path = join(root, marker.path);
      if (marker.directory) mkdirSync(path, { recursive: true });
      else writeFileSync(path, "0000000000000000000000000000000000000000\n");

      const { ctx } = fakeHarness();
      const bad = refusal(await probeAdoption(ctx, root));
      const name = marker.path.slice(".git/".length);
      expect(bad.blocker, name).toBe("in-progress");
      expect(bad.evidence, name).toContain(name);
    }
  });

  it("accepts a clean Git repository, and writes nothing", async () => {
    // A probe that created `.jj` would have performed the adoption it was only
    // asked to judge. `fakeHarness()` also has no shell service, so this proves
    // the probe needs no process: a `jj` call here would throw.
    const root = caseDir("clean");
    gitInit(root);
    writeFileSync(join(root, "README.md"), "# clean\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "base"]);

    const { ctx } = fakeHarness();
    expect(await probeAdoption(ctx, root)).toEqual({ ok: true });
    expect(existsSync(join(root, ".jj"))).toBe(false);
  });

  it("reports the first blocker in the documented order", async () => {
    // The order is the message's stability: a repo that is both shallow and
    // submoduled must always name the same one, or the prompt's advice changes
    // between sessions for no reason.
    const { ctx } = fakeHarness();

    const shallowAndSubmodules = gitDirAt("order-shallow");
    writeFileSync(join(shallowAndSubmodules, ".git/shallow"), "0000\n");
    writeFileSync(join(shallowAndSubmodules, ".gitmodules"), '[submodule "x"]\n');
    expect(refusal(await probeAdoption(ctx, shallowAndSubmodules)).blocker).toBe("shallow");

    const submodulesAndLfs = gitDirAt("order-submodules");
    writeFileSync(join(submodulesAndLfs, ".gitmodules"), '[submodule "x"]\n');
    writeFileSync(join(submodulesAndLfs, ".gitattributes"), LFS_ATTRIBUTES);
    expect(refusal(await probeAdoption(ctx, submodulesAndLfs)).blocker).toBe("submodules");

    const lfsAndMerge = gitDirAt("order-lfs");
    writeFileSync(join(lfsAndMerge, ".gitattributes"), LFS_ATTRIBUTES);
    writeFileSync(join(lfsAndMerge, ".git/MERGE_HEAD"), "0000\n");
    expect(refusal(await probeAdoption(ctx, lfsAndMerge)).blocker).toBe("lfs");
  });
});

/** The generated identity, inside this file's root. */
const IDENTITY = () => join(ROOT, "jj-config.toml");

/** `/dev/null` first, so the user's own jj config is never read. */
const CONFIGURED = () => `/dev/null:${IDENTITY()}`;

/** The environment every direct `jj` call in this file runs under. */
function jjEnv(): NodeJS.ProcessEnv {
  return { ...process.env, JJ_CONFIG: CONFIGURED() };
}

/** Run `git` with an identity and without the user's global config. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Adopt Tests",
      "-c",
      "user.email=adopt@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    },
  );
}

/** `git init` at `root`, with a fixed initial branch so the output is stable. */
function gitInit(root: string): void {
  git(root, ["init", "-b", "main"]);
}

/** Run `jj` in a repository and return its stdout. */
function jj(cwd: string, args: readonly string[]): string {
  return execFileSync("jj", args, { cwd, encoding: "utf8", env: jjEnv() });
}

/** A real Git repository with one commit and nothing jj cannot represent. */
function adoptable(name: string): string {
  const root = caseDir(name);
  gitInit(root);
  writeFileSync(join(root, "README.md"), "# repo\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "base"]);
  return root;
}

/** A harness whose shell runs commands for real, under this file's identity. */
function harnessAt() {
  const harness = fakeHarness();
  realShell(harness.ctx, { JJ_CONFIG: CONFIGURED() });
  return harness;
}

/** How many `it(` blocks this file declares, counted as `docs.test.ts` counts. */
const DECLARED_HERE = declaredTests(import.meta.url);
let executed = 0;

beforeEach(() => {
  executed += 1;
});

afterAll(() => {
  // Same rule as `test/e2e.test.ts`: under the release flag, a skip is a
  // failure. Without this, a machine missing `jj` or `git` would report green
  // having exercised no adoption at all.
  if (!REQUIRE_TOOLS) return;
  expect(
    executed,
    `DSH_JUJUTSU_REQUIRE_TOOLS=1, but ${DECLARED_HERE - executed} of ` +
      `${DECLARED_HERE} tests in test/adopt.test.ts did not run — a missing ` +
      `jj or git, most likely`,
  ).toBe(DECLARED_HERE);
});

describe.skipIf(!HAS_JJ || !HAS_GIT)("adoption runs real jj", () => {
  beforeAll(() => {
    writeFileSync(
      IDENTITY(),
      [
        "# Generated by test/adopt.test.ts. Never written to ~/.config/jj.",
        "[user]",
        'name = "Adopt"',
        'email = "adopt@example.invalid"',
        "",
      ].join("\n"),
    );
  });

  it("adopts a plain Git repo, and detection then calls it colocated", async () => {
    // The whole feature in one assertion: `.jj` appears beside `.git`, and the
    // detector that decides whether the guard is active sees the new workspace.
    // The detection is deliberately warmed before the adoption, because a cached
    // `git` answer surviving it is the exact bug `invalidateDetection` exists to
    // prevent.
    const root = adoptable("adopt");
    const h = harnessAt();
    invalidateDetection();
    expect((await detect(h.ctx, root)).vcs).toBe("git");

    const settings = resolveSettings({ adoptGitRepos: true });
    expect(await adoptRepo(h.ctx, settings, root)).toEqual({ ok: true });

    expect(existsSync(join(root, ".jj"))).toBe(true);
    // Colocated means Git tooling keeps working: `.git` is still a real
    // directory, not a pointer to somewhere else.
    expect(statSync(join(root, ".git")).isDirectory()).toBe(true);

    invalidateDetection();
    const after = await detect(h.ctx, root);
    expect(after.kind).toBe("jj-colocated");
    expect(after.root).toBe(root);
  });

  it("is idempotent: the second call succeeds without rebuilding the repo", async () => {
    // Measured: `jj git init --colocate` in an existing workspace exits 1 with
    // "The target repo already exists", so a second call that simply re-ran it
    // would return a failure for a repository that is already correct. The
    // change ID is compared as well, because an implementation that deleted and
    // re-created `.jj` would "succeed" while discarding the imported history.
    const root = adoptable("idempotent");
    const h = harnessAt();
    const settings = resolveSettings({ adoptGitRepos: true });

    expect(await adoptRepo(h.ctx, settings, root)).toEqual({ ok: true });
    const first = jj(root, ["log", "--no-graph", "-r", "@", "-T", "change_id.short()"]).trim();

    expect(await adoptRepo(h.ctx, settings, root)).toEqual({ ok: true });
    const second = jj(root, ["log", "--no-graph", "-r", "@", "-T", "change_id.short()"]).trim();

    expect(second).toBe(first);
    expect(existsSync(join(root, ".jj"))).toBe(true);
  });

  it("refuses an LFS repo and leaves it untouched", async () => {
    // The refusal must come before the init. A `.jj` left behind would mean the
    // probe ran after the damage, and jj would already be able to corrupt the
    // LFS objects.
    const root = adoptable("blocked-lfs");
    writeFileSync(join(root, ".gitattributes"), LFS_ATTRIBUTES);

    const h = harnessAt();
    const bad = refusal(await adoptRepo(h.ctx, resolveSettings({ adoptGitRepos: true }), root));
    expect(bad.blocker).toBe("lfs");
    expect(existsSync(join(root, ".jj"))).toBe(false);
  });

  it("refuses a repo with submodules and leaves it untouched", async () => {
    const root = adoptable("blocked-submodules");
    writeFileSync(
      join(root, ".gitmodules"),
      '[submodule "vendor"]\n\tpath = vendor\n\turl = https://example.invalid/vendor\n',
    );

    const h = harnessAt();
    const bad = refusal(await adoptRepo(h.ctx, resolveSettings({ adoptGitRepos: true }), root));
    expect(bad.blocker).toBe("submodules");
    expect(existsSync(join(root, ".jj"))).toBe(false);
  });
});

describe("the one-sentence explanation", () => {
  it("names the feature for every blocker, and for a failed init", () => {
    // This text goes into the prompt, where a sentence that says "not supported"
    // without naming *what* is not supported gives the model nothing to tell the
    // user. `init-failed` is separate from the five blockers: it is not a
    // property of the repository but a failure to run `jj` at all.
    const expected: readonly (readonly [AdoptBlocker | "init-failed", RegExp])[] = [
      ["git-file", /worktree|submodule|symlink/i],
      ["sparse", /sparse/i],
      ["shallow", /shallow/i],
      ["submodules", /submodule/i],
      ["lfs", /lfs/i],
      ["filters", /filter|autocrlf/i],
      ["in-progress", /merge|rebase|cherry|revert|bisect|progress/i],
      ["init-failed", /jj|jujutsu|init/i],
    ];

    for (const [blocker, names] of expected) {
      const text = blockerText(blocker);
      expect(text.trim().length, blocker).toBeGreaterThan(0);
      // One sentence: the prompt renders it inline, so a newline would break the
      // surrounding paragraph.
      expect(text, blocker).not.toContain("\n");
      expect(text, blocker).toMatch(names);
    }
  });
});

describe("LFS is caught however it was installed", () => {
  it("refuses when the filter is in .git/config, even with no root .gitattributes", async () => {
    // The gap the first probe had: `filter=lfs` declared only in a nested
    // `.gitattributes` is invisible to a root-only read. `git lfs install`
    // writes `[filter "lfs"]` into `.git/config` and LFS cannot work without
    // it, so the config is the repo-level answer that a nested file cannot
    // hide. This repository has no root `.gitattributes` at all.
    const root = caseDir("lfs-config-only");
    gitInit(root);
    writeFileSync(
      join(root, ".git", "config"),
      '[core]\n\trepositoryformatversion = 0\n[filter "lfs"]\n\trequired = true\n\tclean = git-lfs clean -- %f\n',
    );
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", ".gitattributes"), "*.bin filter=lfs\n");

    const { ctx } = fakeHarness();
    const probe = await probeAdoption(ctx, root);
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.blocker).toBe("lfs");
  });

  it("refuses when the filter is declared in .git/info/attributes", async () => {
    const root = caseDir("lfs-info-attributes");
    gitInit(root);
    writeFileSync(join(root, ".git", "info", "attributes"), "*.bin filter=lfs\n");

    const { ctx } = fakeHarness();
    const probe = await probeAdoption(ctx, root);
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.blocker).toBe("lfs");
  });
});

describe("the shapes the first probe missed", () => {
  /** A hand-built repository root: `.git/` as a directory, no git process. */
  function handBuilt(name: string): string {
    const root = caseDir(name);
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
  }

  it("refuses a sparse checkout, which jj would read as mass deletion", async () => {
    // jj does not know about the sparse cone, so every path outside it looks
    // deleted: `jj status` shows `D dirB/b.txt` and one commit removes those
    // files from the shared history. Disabling sparse checkout afterwards does
    // not bring them back — this is the same danger class as LFS.
    const root = handBuilt("sparse-file");
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "sparse-checkout"), "dirA/\n");
    const { ctx } = fakeHarness();
    const probe = await probeAdoption(ctx, root);
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.blocker).toBe("sparse");
  });

  it("refuses a sparse checkout configured only in .git/config", async () => {
    const root = handBuilt("sparse-config");
    writeFileSync(
      join(root, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n\tsparseCheckout = true\n",
    );
    const { ctx } = fakeHarness();
    const probe = await probeAdoption(ctx, root);
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.blocker).toBe("sparse");
  });

  it("refuses a custom content filter, the git-crypt shape", async () => {
    // The root cause is not LFS, it is that jj runs no filters at all. With
    // git-crypt, the worktree is the DECRYPTED file, so jj would commit
    // plaintext over the encrypted blob — a secret-exposure incident.
    const root = handBuilt("custom-filter");
    writeFileSync(
      join(root, ".git", "config"),
      '[core]\n\trepositoryformatversion = 0\n[filter "crypt"]\n\tclean = git-crypt clean %f\n\tsmudge = git-crypt smudge %f\n',
    );
    const { ctx } = fakeHarness();
    const probe = await probeAdoption(ctx, root);
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.blocker).toBe("filters");
  });

  it("refuses core.autocrlf, which would commit CRLF over the normalised blob", async () => {
    const root = handBuilt("autocrlf");
    writeFileSync(
      join(root, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n\tautocrlf = true\n",
    );
    const { ctx } = fakeHarness();
    const probe = await probeAdoption(ctx, root);
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.blocker).toBe("filters");
  });

  it("refuses a symlinked .git, where two directories share one repository", async () => {
    // `stat` follows the link and sees a directory. Two working copies then each
    // get their own jj workspace over one shared Git directory, and a commit
    // from one deletes the other's files from the shared repository. Only
    // `lstat` can tell.
    const real = caseDir("symlink-real");
    gitInit(real);
    writeFileSync(join(real, "a.txt"), "one\n");
    git(real, ["add", "."]);
    git(real, ["commit", "-m", "base"]);

    const root = caseDir("symlink-user");
    symlinkSync(join(real, ".git"), join(root, ".git"));

    const { ctx } = fakeHarness();
    const probe = await probeAdoption(ctx, root);
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.blocker).toBe("git-file");
  });

  it("refuses a pending multi-commit cherry-pick, which leaves .git/sequencer", async () => {
    // `git cherry-pick A B` with a conflict, resolved with `git commit` rather
    // than `--continue`, leaves a pending pick in `sequencer/` and no
    // `CHERRY_PICK_HEAD`. Checking only the latter says the repository is idle.
    const root = handBuilt("sequencer");
    mkdirSync(join(root, ".git", "sequencer"), { recursive: true });
    writeFileSync(join(root, ".git", "sequencer", "todo"), "pick abc123\n");
    const { ctx } = fakeHarness();
    const probe = await probeAdoption(ctx, root);
    expect(probe.ok).toBe(false);
    expect(probe.ok === false && probe.blocker).toBe("in-progress");
  });
});

describe.skipIf(!HAS_JJ || !HAS_GIT)("a failed import is undone", () => {
  it("removes the partial .jj when jj cannot import the repository", async () => {
    // The worst state to leave behind: a `.jj` that does not work. The next
    // session's detect would see it, the guard would activate, and every jj
    // command would fail — the repository bricked for the agent while Git keeps
    // working outside the plugin.
    //
    // An unparseable ref makes `jj git init --colocate` fail after it has
    // created `.jj` (measured on 0.46.0: exit 1, "Failed to import refs").
    const root = adoptable("broken-ref");
    writeFileSync(join(root, ".git", "refs", "heads", "main"), "not-a-sha\n");

    const h = fakeHarness();
    realShell(h.ctx, jjEnv());
    const result = await adoptRepo(h.ctx, resolveSettings({}), root);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.blocker).toBe("init-failed");
    expect(existsSync(join(root, ".jj"))).toBe(false);
  });
});
