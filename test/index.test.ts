/**
 * The mount itself, and the cache boundary it guards.
 *
 * `apply` is the one function every other test calls to get a mounted plugin, and
 * for a long time nothing tested `apply` directly. It now has two jobs worth
 * pinning: it registers everything, unconditionally — the master switch this file
 * was written for turned out to duplicate the enable toggle the Plugins page
 * already gives every row, and was removed — and it invalidates the detection
 * caches on every mount.
 *
 * That second one is the boundary. Module-level caches outlive an unmount,
 * because the harness keeps the module in its registry after the bundle is
 * removed — so a workspace created while the plugin was unmounted would stay
 * invisible for the rest of the process. `apply` invalidates for that reason, and
 * the last test here pins it.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { apply } from "../src/index.ts";
import { FIXTURES, fakeHarness, HAS_FIXTURES } from "./helpers.ts";

describe.skipIf(!HAS_FIXTURES)("there is no master switch, and that is the decision", () => {
  // The Plugins page already gives every row an enable toggle, and disabling the
  // row unmounts the plugin -- so `apply` never runs. A config-level switch would
  // be a second control for one decision, with the two able to disagree: the row
  // on and the config off is a plugin that looks enabled and does nothing. The
  // harness owns that switch; this plugin does not re-implement it.
  it("has no `enabled` field in the schema", () => {
    const schema = readFileSync("src/config.ts", "utf8");
    expect(schema).not.toMatch(/^ {2}enabled: z\b/m);
  });

  it("registers everything on every mount", () => {
    const h = fakeHarness();
    apply(h.ctx, {});

    const events = h.listeners.map((entry) => entry.event);
    expect(events).toContain("tools/pre-execute");
    expect(events).toContain("tools/post-execute");
    expect(events).toContain("agent/created");
    expect(h.tools.length).toBeGreaterThan(0);
  });

  it("draws no master-switch group", () => {
    // The panel is checked from its built bundle, which is what the browser
    // loads; the source is checked for the absence of the field above.
    const panel = readFileSync("lib/client.js", "utf8");
    expect(panel).not.toContain("groupMaster");
  });
});

describe.skipIf(!HAS_FIXTURES)("the mount is a cache boundary", () => {
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
