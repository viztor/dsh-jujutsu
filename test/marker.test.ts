/**
 * The per-project switch.
 *
 * The filesystem double reads the real disk, so these tests create real
 * `.dsh-jujutsu.json` files and assert on real behaviour — including the parts
 * that matter most: that a malformed marker does not silently disable the
 * plugin, and that the nearest marker wins.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { apply } from "../src/index.ts";
import { invalidateDetection } from "../src/detect.ts";
import { MARKER_FILE, invalidateMarkers, markerFor } from "../src/marker.ts";
import { FIXTURES, fakeHarness, HAS_FIXTURES } from "./helpers.ts";

/**
 * A root unique to this process.
 *
 * It used to be a fixed `/tmp` path, which two concurrent suite runs shared —
 * the same failure the note further down records for `/tmp/.dsh-jujutsu.json`,
 * one level up: one run's `beforeEach` deleted the tree the other was asserting
 * on. Per test, `beforeEach` still clears it, because the tests below write
 * markers and expect a clean tree.
 */
/**
 * Created in `beforeAll`, not at module scope, and that distinction is the whole
 * point of this comment.
 *
 * `mkdtempSync` at module scope ran at COLLECTION time — and a skipped suite
 * still collects. `describe.skipIf` runs its factory, so a module-scope
 * `mkdtemp` made a directory on every run, including runs where nothing in this
 * file executes. The `afterAll` that removes it is a file-level hook, and Vitest
 * does not run file-level hooks for a file where every suite was skipped.
 *
 * Measured, not assumed: with `HAS_FIXTURES` forced false, `dsh-jujutsu-marker-test-*`
 * went from 1 directory to 2 across one skipped run, while the same experiment on
 * `detect.test.ts` — fixed first — stayed at 0. One leaked directory per run on a
 * machine without `jj`, which is invisible in CI and accumulates in `$TMPDIR`.
 */
let ROOT = "";

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "dsh-jujutsu-marker-test-"));
});

afterAll(() => {
  if (ROOT !== "") rmSync(ROOT, { recursive: true, force: true });
});

function writeMarker(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${MARKER_FILE}`, body);
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  invalidateDetection();
  invalidateMarkers();
});

describe.skipIf(!HAS_FIXTURES)("finding the marker", () => {
  it("returns nothing when there is no marker", async () => {
    const { ctx } = fakeHarness();
    mkdirSync(ROOT, { recursive: true });
    expect(await markerFor(ctx, ROOT)).toBeUndefined();
  });

  it("reads an opt-out", async () => {
    const { ctx } = fakeHarness();
    writeMarker(ROOT, '{"enabled": false}');
    const marker = await markerFor(ctx, ROOT);
    expect(marker?.enabled).toBe(false);
    expect(marker?.dir).toBe(ROOT);
  });

  it("reads a force-Jujutsu opt-in, and a project-level opt-out of it", async () => {
    // `enabled` and `forceJj` are independent switches: a project can enable the
    // plugin without requiring jj (the default), or require jj without changing
    // anything else. Folding the two together would make `forceJj` impossible to
    // state in a repo that never opted into the plugin globally.
    const { ctx } = fakeHarness();
    writeMarker(ROOT, '{"forceJj": true}');
    let marker = await markerFor(ctx, ROOT);
    expect(marker?.forceJj).toBe(true);
    expect(marker?.enabled).toBe(true);

    invalidateMarkers();
    writeMarker(ROOT, '{"forceJj": false}');
    marker = await markerFor(ctx, ROOT);
    expect(marker?.forceJj).toBe(false);
  });

  it("lets the nearest marker win for forceJj too", async () => {
    const { ctx } = fakeHarness();
    writeMarker(ROOT, '{"forceJj": true}');
    writeMarker(`${ROOT}/vendored`, '{"forceJj": false}');
    expect((await markerFor(ctx, `${ROOT}/vendored`))?.forceJj).toBe(false);
    invalidateMarkers();
    expect((await markerFor(ctx, ROOT))?.forceJj).toBe(true);
  });

  it("rejects a malformed forceJj rather than guessing", async () => {
    // `"true"` is the mistake a hand-edited JSON file makes. The whole marker is
    // treated as absent, which leaves the shipped default (`forceJj: false`) in
    // force — fail open on protection, exactly like `enabled`.
    const { ctx } = fakeHarness();
    for (const body of ['{"forceJj": "true"}', '{"forceJj": 1}', '{"forceJj": null}']) {
      invalidateMarkers();
      writeMarker(ROOT, body);
      expect(await markerFor(ctx, ROOT), body).toBeUndefined();
    }
  });

  it("walks up to find one", async () => {
    const { ctx } = fakeHarness();
    writeMarker(ROOT, '{"enabled": false}');
    mkdirSync(`${ROOT}/deep/deeper`, { recursive: true });
    const marker = await markerFor(ctx, `${ROOT}/deep/deeper`);
    expect(marker?.enabled).toBe(false);
    expect(marker?.dir).toBe(ROOT);
  });

  it("lets the NEAREST marker win", async () => {
    // The point of `{"enabled": true}`: exempt one subtree from a monorepo-wide
    // opt-out without touching the outer marker.
    const { ctx } = fakeHarness();
    writeMarker(ROOT, '{"enabled": false}');
    writeMarker(`${ROOT}/vendored`, '{"enabled": true}');
    expect((await markerFor(ctx, `${ROOT}/vendored`))?.enabled).toBe(true);
    expect((await markerFor(ctx, ROOT))?.enabled).toBe(false);
  });

  it("treats a malformed marker as absent, keeping the plugin ON", async () => {
    // Fail open on protection: a typo must not be a silent way to disable the
    // guard. This is the one behaviour a wrong guess here would get backwards.
    const { ctx } = fakeHarness();
    for (const body of ["{ not json", '{"enabled": "false"}', "[]", '{"other": 1}']) {
      invalidateMarkers();
      writeMarker(ROOT, body);
      expect(await markerFor(ctx, ROOT), body).toBeUndefined();
    }
  });

  it("caches per directory", async () => {
    // The clock is pinned rather than raced. The cache lives for a 2s TTL, and
    // asserting "still cached" against real time made this test fail on a slow
    // first run — the entry expired before the second read.
    const now = vi.spyOn(Date, "now");
    let clock = 1_000_000;
    now.mockImplementation(() => clock);
    try {
      const { ctx } = fakeHarness();
      writeMarker(ROOT, '{"enabled": false}');
      expect((await markerFor(ctx, ROOT))?.enabled).toBe(false);

      rmSync(`${ROOT}/${MARKER_FILE}`);
      clock += 10; // well inside the TTL
      // Still false from the cache — which is why the guard invalidates it.
      expect((await markerFor(ctx, ROOT))?.enabled).toBe(false);

      invalidateMarkers();
      expect(await markerFor(ctx, ROOT)).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });
});

describe.skipIf(!HAS_FIXTURES)("the switch reaches the guard", () => {
  const inFixture = (h: ReturnType<typeof fakeHarness>, command: string, cwd: string) =>
    h.session("s1", cwd).exec("bash", { command, description: "test" });

  it("silences the plugin where the marker says so", async () => {
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", bypass: "deny", readOnlyGit: "deny" });
    const exec = inFixture(h, "git status", `${FIXTURES}/jj-colocated`);
    expect((await h.preExecute(exec)).kind).toBe("deny");
  });

  it("stays silent when a marker disables the tree", async () => {
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", bypass: "deny", readOnlyGit: "deny" });

    // An ISOLATED tree, not /tmp. Vitest runs test files in parallel workers,
    // and this test used to write `/tmp/.dsh-jujutsu.json` to prove an ancestor
    // marker covers the fixtures — which are also under /tmp. Whenever
    // `guard.test.ts` ran concurrently it read that marker and its "refuses
    // git" assertions failed. A shared path across parallel workers is the
    // flake; the marker semantics were never wrong.
    const tree = `${ROOT}/ancestor`;
    const repo = `${tree}/repo`;
    mkdirSync(`${repo}/.jj`, { recursive: true });
    writeMarker(tree, '{"enabled": false}');
    invalidateMarkers();
    invalidateDetection();

    const exec = h.session("s1", repo).exec("bash", {
      command: "git status",
      description: "test",
    });
    // The marker governs `repo` even though it sits one level above it.
    expect((await h.preExecute(exec)).kind).toBe("allow");
  });
});
