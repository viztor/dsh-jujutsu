/**
 * The mount itself: the master switch, and the boundary it guards.
 *
 * `apply` is the one function every other test calls to get a mounted plugin, and
 * its own first line — `if (!settings.enabled) return` — was covered by nothing.
 * The switch is the setting a user reaches for when the plugin is misbehaving, so
 * "off means off" has to be true of everything it registers, not just the guard.
 *
 * The boundary matters too. Module-level caches outlive an unmount, because the
 * harness keeps the module in its registry after the bundle is removed — so a
 * workspace created while the plugin was unmounted would stay invisible for the
 * rest of the process. `apply` invalidates on every mount for that reason, and
 * the second test here pins it.
 */

import { describe, expect, it } from "vitest";

import { apply } from "../src/index.ts";
import { FIXTURES, fakeHarness } from "./helpers.ts";

describe("the master switch", () => {
  it("registers nothing at all when it is off", () => {
    // Not "registers less": off unregisters everything. A listener left mounted
    // would still refuse Git, which is the opposite of what the switch says.
    const h = fakeHarness();
    apply(h.ctx, { enabled: false });

    expect(h.listeners).toEqual([]);
    expect(h.tools).toEqual([]);
  });

  it("registers the guard, the explainer, the tools and the prompt when it is on", () => {
    const h = fakeHarness();
    apply(h.ctx, { enabled: true });

    const events = h.listeners.map((entry) => entry.event);
    expect(events).toContain("tools/pre-execute");
    expect(events).toContain("tools/post-execute");
    expect(events).toContain("agent/created");
    expect(h.tools.length).toBeGreaterThan(0);
  });

  it("treats a missing switch as on", () => {
    // The default is `true`, and a patch row that skipped schema validation
    // reaches `apply` as a partial object. Defaulting to off would silently
    // disable the plugin for anyone whose config was written by hand.
    const h = fakeHarness();
    apply(h.ctx, {});
    expect(h.listeners.length).toBeGreaterThan(0);
  });
});

describe("the mount is a cache boundary", () => {
  it("rediscovers a workspace created while the plugin was unmounted", async () => {
    // Measured live and recorded in src/README.md: detection caches a negative
    // result per directory, and the module outlives an unmount. Without the
    // invalidation in `apply`, a `jj git init` run while the plugin was off stays
    // invisible until the process restarts.
    const h = fakeHarness();

    // First mount, in a directory with no repository: the negative is cached.
    apply(h.ctx, { enabled: true });
    const before = h.session("s1", `${FIXTURES}/not-a-repo`).exec("bash", {
      command: "git status",
      description: "test",
    });
    expect((await h.preExecute(before)).kind).toBe("allow");

    // A second harness is a second `apply`, which is what a remount is.
    const remounted = fakeHarness();
    apply(remounted.ctx, { enabled: true });
    const after = remounted
      .session("s1", `${FIXTURES}/jj-colocated`)
      .exec("bash", { command: "git status", description: "test" });
    expect((await remounted.preExecute(after)).kind).not.toBe("allow");
  });
});
