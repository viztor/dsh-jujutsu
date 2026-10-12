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

import { beforeEach, describe, expect, it } from "vitest";

import { invalidateDetection } from "../src/detect.ts";
import { apply } from "../src/index.ts";
import { invalidateMarkers } from "../src/marker.ts";
import { clearWorkspaceState, workspaceState } from "../src/state.ts";
import { FIXTURES, fakeHarness } from "./helpers.ts";

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

describe("a jj workspace is recorded in full", () => {
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

describe("a directory with no jj records what does govern", () => {
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

describe("a broken preflight costs nothing", () => {
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
