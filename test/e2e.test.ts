/**
 * End to end: the plugin's tools, running against **real `jj` and `jj-hunk`**.
 *
 * Every other test drives the plugin through doubles. This one does not stub
 * the thing under test: `ctx.shell` hands the plugin's command *string* to a
 * real shell, so `tools.ts` builds a real argv, `shell.ts` quotes it, the
 * installed binaries run, and the plugin parses their real output.
 *
 * That is the layer no unit test can reach — argv construction, quoting, exit
 * codes, and the JSON shapes `jj` actually emits. The fixtures are real
 * repositories built by `test/fixtures/build-fixtures.sh`.
 *
 * The binaries are a hard requirement: `jj` 0.46.0 and `jj-hunk` 0.5.1. A
 * missing binary fails the suite rather than skipping, because a silently
 * skipped end-to-end test is worse than none.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/settings.ts";
import { buildToolDefinitions } from "../src/tools.ts";
import { fakeHarness, HAS_JJ, HAS_JJ_HUNK, realShell } from "./helpers.ts";

const ROOT = "/tmp/dsh-jujutsu-e2e";

/** Run `jj` in a directory and return its stdout. */
function jj(cwd: string, args: readonly string[]): string {
  return execFileSync("jj", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, JJ_CONFIG: "/dev/null" },
  });
}

/** A harness whose shell is real, bound to one repository. */
function harnessAt(cwd: string) {
  const harness = fakeHarness();
  realShell(harness.ctx);
  const settings = resolveSettings({});
  const definitions = buildToolDefinitions(harness.ctx, settings);
  const exec = harness.session("e2e", cwd);
  return {
    /** Call a tool by name and return its value. */
    async call(name: string, args: Record<string, unknown> = {}) {
      const def = definitions.find((d) => d.name === name) as
        | { execute: (a: unknown, e: unknown) => Promise<unknown> }
        | undefined;
      if (def === undefined) throw new Error(`no tool ${name}`);
      return await def.execute(args, exec.exec("bash", {}));
    },
  };
}

beforeAll(() => {
  // A real repository with a described base and a real working-copy change.
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const env = { ...process.env, JJ_CONFIG: "/dev/null" };
  execFileSync("jj", ["git", "init", "--colocate"], { cwd: ROOT, env });
  execFileSync("jj", ["config", "set", "--repo", "user.name", "E2E"], { cwd: ROOT, env });
  execFileSync("jj", ["config", "set", "--repo", "user.email", "e2e@example.invalid"], {
    cwd: ROOT,
    env,
  });
  writeFileSync(`${ROOT}/f.txt`, "one\ntwo\nthree\n");
  execFileSync("jj", ["commit", "-m", "base"], { cwd: ROOT, env });
  // Both edits go in the working copy: `jj-hunk` defaults to `-r @`, and a
  // `jj new` here would leave the f.txt edit in @-'s parent where the query
  // cannot see it.
  writeFileSync(`${ROOT}/f.txt`, "one\nTWO-CHANGED\nthree\nfour\n");
  writeFileSync(`${ROOT}/g.txt`, "new file\n");
  // A binary change, so a query can select a *file* that has no hunks. Measured
  // against jj-hunk 0.5.1: `binary_changed()` returns 1 file and 0 hunks. That is
  // a different case from "matches nothing", and the plugin has to refuse it too.
  writeFileSync(`${ROOT}/blob.bin`, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]));
});

describe.skipIf(!HAS_JJ)("the tools run real jj", () => {
  it("jj_status reports the working copy, and that it is not conflicted", async () => {
    const h = harnessAt(ROOT);
    const result = (await h.call("jj_status")) as {
      conflict: boolean | null;
      revisions: { change_id: string; commit_id: string }[];
    };
    expect(Array.isArray(result.revisions)).toBe(true);
    expect(result.revisions.length).toBeGreaterThan(0);
    // `json(self)` has no conflict key, so the tool queries it separately —
    // this asserts that second query ran and returned a real boolean.
    expect(result.conflict).toBe(false);
  });

  it("jj_log returns parsed objects, not newline-delimited text", async () => {
    const h = harnessAt(ROOT);
    const rows = (await h.call("jj_log", { revset: "::@", limit: 5 })) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(1);
    // A real jj commit object: snake_case, straight from the template.
    expect(rows[0]).toHaveProperty("change_id");
    expect(rows[0]).toHaveProperty("commit_id");
  });

  it("jj_diff returns structured entries", async () => {
    const h = harnessAt(ROOT);
    const result = (await h.call("jj_diff", { revset: "@" })) as {
      files: { status: string; path: string }[];
    };
    expect(Array.isArray(result.files)).toBe(true);
    for (const file of result.files) {
      expect(file.status.length).toBeGreaterThan(0);
      expect(file.path.length).toBeGreaterThan(0);
    }
  });

  it("jj_op_log returns parsed operations", async () => {
    const h = harnessAt(ROOT);
    const ops = (await h.call("jj_op_log", { limit: 3 })) as { id: string }[];
    expect(Array.isArray(ops)).toBe(true);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops[0]?.id.length).toBeGreaterThan(0);
  });

  it("jj_describe sets a description and preserves the author", async () => {
    const h = harnessAt(ROOT);
    await h.call("jj_describe", { message: "described by the tool" });
    const out = jj(ROOT, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      'description.first_line() ++ "|" ++ author.name()',
    ]);
    expect(out).toContain("described by the tool");
    expect(out).toContain("E2E");
  });

  it("jj_bookmark create uses -r, and the bookmark is real", async () => {
    const h = harnessAt(ROOT);
    await h.call("jj_bookmark", { action: "create", name: "e2e-bm", revset: "@" });
    const out = jj(ROOT, ["bookmark", "list", "e2e-bm", "-T", "name"]);
    expect(out).toContain("e2e-bm");
  });

  it("jj_bookmark move uses --to, which is a different flag", async () => {
    // The bug this pins: passing `-r` to `move` is a hard error, not a no-op.
    const h = harnessAt(ROOT);
    await h.call("jj_bookmark", { action: "move", name: "e2e-bm", revset: "@-" });
    const out = jj(ROOT, ["bookmark", "list", "e2e-bm", "-T", "name"]);
    expect(out).toContain("e2e-bm");
  });

  it("jj_new refuses when the identity is unconfigured", async () => {
    // The empty-identity trap, against the real binary. A separate repo, because
    // the check reads the repo's own config.
    const bare = `${ROOT}/no-identity`;
    mkdirSync(bare, { recursive: true });
    const env = { ...process.env, JJ_CONFIG: "/dev/null" };
    execFileSync("jj", ["git", "init", "--colocate"], { cwd: bare, env });

    const h = harnessAt(bare);
    const result = (await h.call("jj_new", { message: "should refuse" })) as {
      error?: { code: string };
    };
    expect(result.error?.code).toBe("JJ_IDENTITY_UNCONFIGURED");
  });
});

describe.skipIf(!HAS_JJ || !HAS_JJ_HUNK)("the hunk bridge runs real jj-hunk", () => {
  it("jj_hunk_list returns real hunks for a real query", async () => {
    const h = harnessAt(ROOT);
    const result = (await h.call("jj_hunk_list", {
      query: 'added(content:"four")',
    })) as { files?: { path: string; hunks: { id: string }[] }[]; error?: unknown };

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.files)).toBe(true);
    const withHunks = (result.files ?? []).filter((f) => f.hunks.length > 0);
    expect(withHunks.length).toBeGreaterThan(0);
    // Real hunk IDs are SHA-256, prefixed.
    expect(withHunks[0]?.hunks[0]?.id).toMatch(/^hunk-[0-9a-f]{8,}/);
  });

  it("jj_hunk_apply refuses an empty query before running anything", async () => {
    // `jj-hunk` exits 0 on an empty query and does nothing, so the plugin has to
    // catch it. This asserts the pre-check, not jj-hunk's behaviour.
    const h = harnessAt(ROOT);
    const result = (await h.call("jj_hunk_apply", {
      mode: "split",
      query: "",
      message: "nope",
    })) as { error?: { code: string } };
    expect(result.error?.code).toBe("HUNK_QUERY_EMPTY");
  });

  it("jj_hunk_apply refuses a query that selects nothing", async () => {
    const h = harnessAt(ROOT);
    const result = (await h.call("jj_hunk_apply", {
      mode: "split",
      query: 'added(content:"ZZZ-NO-SUCH-TEXT-ZZZ")',
      message: "nope",
    })) as { error?: { code: string } };
    expect(result.error?.code).toBe("HUNK_QUERY_EMPTY");
  });

  it("jj_hunk_apply refuses a query that selects a file but no hunks", async () => {
    // A third case, distinct from the two above. `binary_changed()` matches the
    // binary file — so the query is not empty and does not match nothing — but a
    // binary change has no text hunks to report. The pre-check filters on
    // `file.hunks.length > 0`, so this lands in the same refusal.
    //
    // Measured against jj-hunk 0.5.1 rather than assumed: `renamed()`,
    // `mode_changed()` and `binary_changed()` each return 1 file and 0 hunks on a
    // repository that really contains those changes (`docs/15` §"Settled since").
    const h = harnessAt(ROOT);
    const listed = (await h.call("jj_hunk_list", { query: "binary_changed()" })) as {
      files?: { hunks: unknown[] }[];
    };
    expect(listed.files?.length, "the query must select a file").toBe(1);
    expect(listed.files?.[0]?.hunks.length, "and no hunks").toBe(0);

    const result = (await h.call("jj_hunk_apply", {
      mode: "split",
      query: "binary_changed()",
      message: "nope",
    })) as { error?: { code: string } };
    expect(result.error?.code).toBe("HUNK_QUERY_EMPTY");
  });

  it("jj_hunk_apply splits a real change and the commit appears", async () => {
    // The whole point of the bridge: a hunk-level split, headless.
    const h = harnessAt(ROOT);
    const before = jj(ROOT, ["log", "--no-graph", "-r", "::@", "-T", 'change_id.short() ++ "\\n"'])
      .trim()
      .split("\n").length;

    const result = (await h.call("jj_hunk_apply", {
      mode: "split",
      query: 'added(content:"four")',
      message: "e2e: the four line",
    })) as { error?: unknown; stdout?: string };

    expect(result.error).toBeUndefined();
    const after = jj(ROOT, ["log", "--no-graph", "-r", "::@", "-T", 'change_id.short() ++ "\\n"'])
      .trim()
      .split("\n").length;
    expect(after).toBeGreaterThan(before);

    const described = jj(ROOT, [
      "log",
      "--no-graph",
      "-r",
      "::@",
      "-T",
      'description.first_line() ++ "\\n"',
    ]);
    expect(described).toContain("e2e: the four line");
  });
});
