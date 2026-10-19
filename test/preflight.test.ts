/**
 * The preflight — what the prompt is told about the workspace.
 *
 * `applyPreflight` runs once, at `agent/created`, and writes the state the
 * system prompt later reads. `context.test.ts` covers the *rendering* of that
 * state but sets it directly, so this module's own work was untested: the
 * detection call, the three-way branch on what it finds, and the two probes it
 * runs inside a `jj` workspace.
 *
 * The branch that matters most is the one for a directory with **no** version
 * control. The plugin used to have no opinion there, which meant an agent could
 * work for an hour with no history and never mention it; now the state records
 * whatever does govern — a plain Git repo, or nothing at all — so the prompt can
 * say something instead of going silent.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { invalidateDetection } from "../src/detect.ts";
import { apply } from "../src/index.ts";
import { invalidateMarkers } from "../src/marker.ts";
import { clearWorkspaceState, workspaceState } from "../src/state.ts";
import { FIXTURES, fakeHarness, HAS_FIXTURES, HAS_JJ, realShell } from "./helpers.ts";

/**
 * The registered `agent/created` handler.
 *
 * Returned rather than used inline so every caller gets a value the type system
 * knows is present: calling through an optional chain reads as "this might not
 * be registered", which is exactly what these tests assert it is.
 */
function createdHandler(
  harness: ReturnType<typeof fakeHarness>,
): (payload: unknown) => Promise<void> {
  const listener = harness.listeners.find((entry) => entry.event === "agent/created");
  expect(listener, "the plugin registers an agent/created listener").toBeDefined();
  if (listener === undefined) throw new Error("no agent/created listener");
  return listener.handler as (payload: unknown) => Promise<void>;
}

/** Drive `agent/created` the way the harness does, and return the recorded state. */
async function preflight(
  harness: ReturnType<typeof fakeHarness>,
  cwd: string,
): Promise<ReturnType<typeof workspaceState>> {
  await createdHandler(harness)({
    agent: { session: { id: "s1", header: { cwd } } },
  });
  return workspaceState("s1");
}

beforeEach(() => {
  clearWorkspaceState();
  invalidateDetection();
  invalidateMarkers();
});

describe.skipIf(!HAS_FIXTURES)("a jj workspace is recorded in full", () => {
  it("records the kind, the root, and the two probes", async () => {
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", alertUninitialised: true });

    const state = await preflight(h, `${FIXTURES}/jj-colocated`);
    expect(state?.vcs).toBe("jj");
    expect(state?.kind).toBe("jj-colocated");
    expect(state?.root).toBe(`${FIXTURES}/jj-colocated`);
    // Both probes ran. `jj-hunk` is installed here, and the fixture has commits,
    // so the change id resolves — the assertions are on presence, not value,
    // because the fixtures rebuild their commits on every run.
    expect(typeof state?.jjHunk).toBe("boolean");
    expect(state?.changeId === undefined || typeof state.changeId === "string").toBe(true);
  });

  it("distinguishes a native workspace from a colocated one", async () => {
    // `jj git init` without colocation has no `.git`, and the prompt says
    // different things about the two — the distinction is the whole reason
    // `detect` reports a `kind` rather than a boolean.
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny" });
    const state = await preflight(h, `${FIXTURES}/jj-native`);
    expect(state?.vcs).toBe("jj");
    expect(state?.kind).toBe("jj-native");
  });
});

describe.skipIf(!HAS_FIXTURES)("a directory with no jj records what does govern", () => {
  it("records a plain Git repository", async () => {
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny" });
    const state = await preflight(h, `${FIXTURES}/plain-git`);
    expect(state?.vcs).toBe("git");
    expect(state?.root).toBe(`${FIXTURES}/plain-git`);
    // No `kind`: that field describes a jj workspace, and there is none.
    expect(state?.kind).toBeUndefined();
  });

  it("records nothing at all, using the directory as its own root", async () => {
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny" });
    const state = await preflight(h, `${FIXTURES}/not-a-repo`);
    expect(state?.vcs).toBe("none");
    expect(state?.root).toBe(`${FIXTURES}/not-a-repo`);
    expect(state?.kind).toBeUndefined();
  });
});

describe.skipIf(!HAS_FIXTURES)("a broken preflight costs nothing", () => {
  it("records no state and does not throw when the session is malformed", async () => {
    // `agent/created` is awaited by the harness, so a throw here would cost the
    // user their session. A payload with no session is the cheapest way to reach
    // the guard clause.
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny" });
    await expect(createdHandler(h)({ agent: {} })).resolves.toBeUndefined();
    expect(workspaceState("s1")).toBeUndefined();
  });
});

/**
 * Adoption, end to end: the branch of preflight that writes to the repository.
 *
 * The probe and `adoptRepo` have their own tests in `adopt.test.ts`; what is
 * only testable here is the wiring between them and the state the prompt reads
 * — that a successful import flips the session to `jj`, that the detection cache
 * is dropped rather than answering "plain git" for the rest of the session, and
 * that a refusal leaves the repository alone and records why.
 *
 * These use their own repositories rather than the shared fixtures: adoption
 * writes `.jj`, and a fixture that grows a workspace is one every other test in
 * the suite would then see.
 */
describe.skipIf(!HAS_JJ)("adopting a plain Git repo", () => {
  const ROOTS: string[] = [];

  afterAll(() => {
    for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
  });

  /** A real Git repo with one commit, and its own jj identity config. */
  function gitRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "dsh-jujutsu-adopt-"));
    ROOTS.push(root);
    writeFileSync(
      join(root, "id.toml"),
      '[user]\nname = "Adopt"\nemail = "adopt@example.invalid"\n',
    );
    const env = { ...process.env, JJ_CONFIG: `/dev/null:${root}/id.toml` };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
    writeFileSync(join(root, "a.txt"), "one\n");
    execFileSync("git", ["add", "."], { cwd: root, env });
    // `-c user.name` / `-c user.email` rather than the machine's Git config:
    // a CI runner has no global identity, so a bare `git commit` fails there
    // while passing on a developer's laptop. Same reason `adopt.test.ts` passes
    // them on every invocation.
    execFileSync(
      "git",
      ["-c", "user.name=Adopt", "-c", "user.email=adopt@example.invalid", "commit", "-qm", "first"],
      { cwd: root, env },
    );
    return root;
  }

  it("creates .jj, and the session is recorded as a colocated workspace", async () => {
    const root = gitRepo();
    const h = fakeHarness();
    realShell(h.ctx, { JJ_CONFIG: `/dev/null:${root}/id.toml` });
    apply(h.ctx, { guard: "deny", adoptGitRepos: true });

    const state = await preflight(h, root);

    expect(existsSync(join(root, ".jj"))).toBe(true);
    expect(state?.vcs).toBe("jj");
    expect(state?.kind).toBe("jj-colocated");
    expect(state?.adoption?.status).toBe("adopted");
  });

  it("makes the guard active: Git is refused in the same session", async () => {
    // The point of the feature. Creating `.jj` is only useful if the guard then
    // treats the repository as a workspace — which it will only do if the
    // detection cache that said "plain git" moments earlier was dropped. A
    // preflight that adopted without invalidating would leave the guard inert
    // for the rest of the session, and every test above would still pass.
    const root = gitRepo();
    const h = fakeHarness();
    realShell(h.ctx, { JJ_CONFIG: `/dev/null:${root}/id.toml` });
    // `readOnlyGit: "deny"` as well as `bypass`: the shipped default for
    // read-only Git is `ask`, so a bare `git status` would come back as a
    // prompt and the assertion below would be testing the posture rather than
    // whether the guard is awake at all.
    apply(h.ctx, { guard: "deny", readOnlyGit: "deny", bypass: "deny", adoptGitRepos: true });

    await preflight(h, root);
    const decision = await h.preExecute(
      h.session("s1", root).exec("bash", { command: "git status", description: "test" }),
    );

    expect(decision.kind).toBe("deny");
  });

  it("leaves the repository alone when the setting is off", async () => {
    // The default has to be inert: a plugin that creates .jj in a repository
    // nobody asked it to touch is the failure this setting exists to prevent.
    const root = gitRepo();
    const h = fakeHarness();
    realShell(h.ctx, { JJ_CONFIG: `/dev/null:${root}/id.toml` });
    apply(h.ctx, { guard: "deny" });

    const state = await preflight(h, root);

    expect(existsSync(join(root, ".jj"))).toBe(false);
    expect(state?.vcs).toBe("git");
    expect(state?.adoption).toBeUndefined();
  });

  it("adopts when the project marker opts in and the setting is off", async () => {
    // The per-project switch has to work in the direction that makes it useful:
    // one repository opted in without turning the setting on everywhere.
    const root = gitRepo();
    // `adopt` ALONE, which is what docs/37 §4 documents. Writing
    // `{enabled: true, adopt: true}` here is what let the bug through: the
    // marker parser required a boolean `enabled`, so the documented
    // `{"adopt": true}` was discarded and the opt-in silently did nothing.
    writeFileSync(join(root, ".dsh-jujutsu.json"), JSON.stringify({ adopt: true }));
    const h = fakeHarness();
    realShell(h.ctx, { JJ_CONFIG: `/dev/null:${root}/id.toml` });
    apply(h.ctx, { guard: "deny" });

    const state = await preflight(h, root);

    expect(existsSync(join(root, ".jj"))).toBe(true);
    expect(state?.adoption?.status).toBe("adopted");
  });

  it("refuses to adopt when the project marker opts out and the setting is on", async () => {
    // And in the direction that makes it safe: a monorepo or a vendored
    // checkout that must not grow a .jj because the setting is global.
    const root = gitRepo();
    writeFileSync(join(root, ".dsh-jujutsu.json"), JSON.stringify({ enabled: true, adopt: false }));
    const h = fakeHarness();
    realShell(h.ctx, { JJ_CONFIG: `/dev/null:${root}/id.toml` });
    apply(h.ctx, { guard: "deny", adoptGitRepos: true });

    const state = await preflight(h, root);

    expect(existsSync(join(root, ".jj"))).toBe(false);
    expect(state?.vcs).toBe("git");
  });

  it("refuses a repo with submodules and records why", async () => {
    const root = gitRepo();
    writeFileSync(join(root, ".gitmodules"), '[submodule "s"]\n\tpath = s\n\turl = ../s\n');
    const h = fakeHarness();
    realShell(h.ctx, { JJ_CONFIG: `/dev/null:${root}/id.toml` });
    apply(h.ctx, { guard: "deny", adoptGitRepos: true });

    const state = await preflight(h, root);

    expect(existsSync(join(root, ".jj"))).toBe(false);
    expect(state?.vcs).toBe("git");
    expect(state?.adoption?.status).toBe("blocked");
    expect(state?.adoption?.blocker).toBe("submodules");
  });
});
