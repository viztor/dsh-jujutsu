/**
 * Detection, end to end against real repositories.
 *
 * Every path below is a directory that `test/fixtures/build-fixtures.sh` created
 * with real `jj` and `git`, and the filesystem double reads the real disk. So
 * these assertions are about actual `.jj` and `.git` entries, not about a mock's
 * idea of them — which is the only kind of test that would have caught the
 * inverted `.jj`/`.git` assumption this repo shipped in its first draft
 * (`docs/13-empirical-verification.md` §2).
 */

import { mkdirSync, rmSync } from "node:fs";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { detect, effectiveCwd, findWorkspaceRoot, invalidateDetection } from "../src/detect.ts";
import { apply } from "../src/index.ts";
import { FIXTURES, fakeHarness } from "./helpers.ts";

const { ctx } = fakeHarness();

beforeAll(() => {
  // A plain subdirectory inside a real `jj` repo, to prove the walk-up. The
  // fixture builder does not create one, and this is the case that a
  // `cwd + '/.jj'` check gets wrong.
  mkdirSync(`${FIXTURES}/jj-colocated/nested/deeper`, { recursive: true });
});

describe("workspace detection", () => {
  it("does not claim a plain Git repo", async () => {
    const found = await detect(ctx, `${FIXTURES}/plain-git`);
    expect(found.kind).toBe("none");
    expect(found.root).toBe("");
  });

  it("does not claim a directory that is not a repo", async () => {
    const found = await detect(ctx, `${FIXTURES}/not-a-repo`);
    expect(found.kind).toBe("none");
  });

  it("recognises a non-colocated workspace and reports no .git", async () => {
    const found = await detect(ctx, `${FIXTURES}/jj-native`);
    expect(found.kind).toBe("jj-native");
    expect(found.root).toBe(`${FIXTURES}/jj-native`);
    expect(found.hasGitDir).toBe(false);
    expect(found.hasGitFile).toBe(false);
  });

  it("recognises a colocated workspace", async () => {
    const found = await detect(ctx, `${FIXTURES}/jj-colocated`);
    expect(found.kind).toBe("jj-colocated");
    expect(found.hasGitDir).toBe(true);
  });

  it("recognises a secondary workspace, where .git is a FILE", async () => {
    // `jj workspace add` leaves `.jj` a directory and turns `.git` into a file
    // holding `gitdir: ../primary/.git/worktrees/<name>`. Detecting this wrong
    // is the mistake docs/13 §2 records.
    const found = await detect(ctx, `${FIXTURES}/jj-secondary/secondary`);
    expect(found.kind).toBe("jj-colocated");
    expect(found.root).toBe(`${FIXTURES}/jj-secondary/secondary`);
    expect(found.hasGitFile).toBe(true);
    expect(found.hasGitDir).toBe(false);
  });

  it("walks UP from a subdirectory — the whole point of the walk", async () => {
    // `jj` works from any subdirectory, so a Git command run in `src/` is still
    // inside the workspace. A detector that only checked the cwd would say
    // "none" here and let the command through.
    for (const dir of [
      `${FIXTURES}/jj-colocated/nested`,
      `${FIXTURES}/jj-colocated/nested/deeper`,
      `${FIXTURES}/jj-with-changes/src`,
    ]) {
      const found = await detect(ctx, dir);
      expect(found.kind, dir).toBe("jj-colocated");
      expect(found.root, dir).not.toBe(dir);
    }
  });

  it("resolves the INNER repo when repos are nested", async () => {
    const inner = await detect(ctx, `${FIXTURES}/jj-nested/outer/sub`);
    expect(inner.root).toBe(`${FIXTURES}/jj-nested/outer/sub`);

    const outer = await detect(ctx, `${FIXTURES}/jj-nested/outer`);
    expect(outer.root).toBe(`${FIXTURES}/jj-nested/outer`);
  });

  it("tolerates a trailing slash", async () => {
    const found = await detect(ctx, `${FIXTURES}/jj-colocated/`);
    expect(found.kind).toBe("jj-colocated");
  });

  it("terminates rather than looping when nothing is found", async () => {
    await expect(findWorkspaceRoot(ctx, "/tmp")).resolves.toBeUndefined();
  });
});

describe("effectiveCwd", () => {
  const { session } = fakeHarness();
  const s = session("s1", "/repo");

  it("uses the session cwd when no workdir is given", () => {
    expect(effectiveCwd(s.exec("bash", { command: "git status" }))).toBe("/repo");
  });

  it("resolves a relative workdir against the session cwd", () => {
    // The bash tool tells the model to use `workdir` instead of `cd`, so a
    // relative one is the common case and the command runs elsewhere.
    expect(effectiveCwd(s.exec("bash", { command: "git status", workdir: "sub" }))).toBe(
      "/repo/sub",
    );
  });

  it("honours an absolute workdir", () => {
    expect(effectiveCwd(s.exec("bash", { command: "git status", workdir: "/other" }))).toBe(
      "/other",
    );
  });

  it("prefers a resolved sandbox-policy root over the session cwd", () => {
    // `resolveWorkdir` gives the policy root precedence so that workdir and
    // confinement use the same per-call identity (docs/24 §1).
    expect(effectiveCwd(s.exec("bash", { command: "git status" }), "/policy-root")).toBe(
      "/policy-root",
    );
  });

  it("returns undefined for a non-agent caller", () => {
    const orphan = { name: "bash", arguments: { command: "git status" } };
    expect(effectiveCwd(orphan as never)).toBeUndefined();
  });
});

describe("cache invalidation — the stale-negative bug", () => {
  const SCRATCH = "/tmp/dsh-jujutsu-cache-test";

  beforeAll(() => {
    // The scratch tree persists between runs, and a `.jj` left by a previous run
    // would make the first assertion in each test fail. Start from nothing.
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
  });

  it("clears the cache when the plugin is applied", async () => {
    // This is the bug observed live: the plugin was mounted, cached "none" for a
    // plain directory, was unmounted, the directory became a jj workspace, and on
    // remount the stale "none" kept the guard blind. A mount is a boundary.
    invalidateDetection();
    const { ctx } = fakeHarness();
    const dir = `${SCRATCH}/remount`;
    mkdirSync(dir, { recursive: true });
    expect((await detect(ctx, dir)).kind).toBe("none");

    mkdirSync(`${dir}/.jj`, { recursive: true });
    apply(ctx, {}); // a fresh mount

    expect((await detect(ctx, dir)).kind).toBe("jj-native");
  });

  it("lets a negative expire, so a workspace created later is seen", async () => {
    // A positive is stable; a negative is not. `jj git init` in a terminal while
    // the session runs must not leave the plugin blind for the rest of it.
    invalidateDetection();
    const { ctx } = fakeHarness();
    const dir = `${SCRATCH}/ttl`;
    mkdirSync(dir, { recursive: true });
    expect((await detect(ctx, dir)).kind).toBe("none");

    mkdirSync(`${dir}/.jj`, { recursive: true });
    expect((await detect(ctx, dir)).kind).toBe("none"); // still cached

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(Date.now() + 5_000);
    try {
      expect((await detect(ctx, dir)).kind).toBe("jj-native");
    } finally {
      now.mockRestore();
    }
  });

  it("never expires a positive answer", async () => {
    invalidateDetection();
    const { ctx } = fakeHarness();
    const found = await detect(ctx, `${FIXTURES}/jj-colocated`);
    expect(found.kind).toBe("jj-colocated");

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(Date.now() + 3_600_000);
    try {
      expect((await detect(ctx, `${FIXTURES}/jj-colocated`)).kind).toBe("jj-colocated");
    } finally {
      now.mockRestore();
    }
  });
});
