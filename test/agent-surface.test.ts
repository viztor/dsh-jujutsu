/**
 * The agent-surface additions, against real `jj`.
 *
 * These tests exist because the new tools are mostly argv construction and
 * parsing, and the layer that can actually catch a wrong flag is a real binary.
 * The read-purity test is the important one: it proves that `jj_status` and the
 * other reads do **not** snapshot the working copy, which is the whole reason
 * `--ignore-working-copy` is threaded through the surface.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/settings.ts";
import { buildToolDefinitions } from "../src/tools.ts";
import { fakeHarness, HAS_JJ, realShell } from "./helpers.ts";

const ROOT = mkdtempSync(join(tmpdir(), "dsh-jujutsu-agent-surface-"));
const IDENTITY = join(ROOT, "jj-config.toml");
const CONFIG = `/dev/null:${IDENTITY}`;
const ENV = { ...process.env, JJ_CONFIG: CONFIG };

function jj(cwd: string, args: readonly string[]): string {
  return execFileSync("jj", args, { cwd, encoding: "utf8", env: ENV });
}

function harnessAt(cwd: string) {
  const harness = fakeHarness();
  realShell(harness.ctx, { JJ_CONFIG: CONFIG });
  const definitions = buildToolDefinitions(harness.ctx, resolveSettings({}));
  const exec = harness.session("agent-surface", cwd);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const definition = definitions.find((d) => d.name === name) as
        | { execute: (a: unknown, e: unknown) => Promise<unknown> }
        | undefined;
      if (definition === undefined) throw new Error(`no tool ${name}`);
      return await definition.execute(args, exec.exec("bash", {}));
    },
  };
}

beforeAll(() => {
  writeFileSync(
    IDENTITY,
    ["[user]", 'name = "Agent Surface"', 'email = "agent-surface@example.invalid"', ""].join("\n"),
  );
  execFileSync("jj", ["git", "init", "--colocate"], { cwd: ROOT, env: ENV });
  writeFileSync(join(ROOT, "f.txt"), "one\ntwo\nthree\n");
  execFileSync("jj", ["commit", "-m", "base"], { cwd: ROOT, env: ENV });
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS reclaims the temp area */
  }
});

describe.skipIf(!HAS_JJ)("the agent surface runs real jj", () => {
  it("jj_status does not snapshot the working copy", async () => {
    writeFileSync(join(ROOT, "dirty-status.txt"), "unsnapshotted\n");
    const before = jj(ROOT, [
      "op",
      "log",
      "--limit",
      "1",
      "--no-graph",
      "--ignore-working-copy",
      "-T",
      "id.short()",
    ]).trim();

    const h = harnessAt(ROOT);
    const result = (await h.call("jj_status")) as { opId?: string; snapshot?: boolean };
    expect(result.snapshot).toBe(false);
    expect(result.opId).toBe(before);

    // The file is still invisible to a read-only status, which is the proof
    // that the tool did not take the snapshot it was asked not to take.
    const status = jj(ROOT, ["status", "--ignore-working-copy"]);
    expect(status).not.toContain("dirty-status.txt");
  });

  it("jj_status snapshot:true captures the edit and returns a checkpoint", async () => {
    const h = harnessAt(ROOT);
    const result = (await h.call("jj_status", { snapshot: true })) as {
      opId?: string;
      snapshot?: boolean;
    };
    expect(result.snapshot).toBe(true);
    expect(result.opId).toMatch(/^[0-9a-f]+$/);
    const status = jj(ROOT, ["status", "--ignore-working-copy"]);
    expect(status).toContain("dirty-status.txt");
  });

  it("jj_workspace adds, lists and forgets a real workspace", async () => {
    const h = harnessAt(ROOT);
    const path = join(ROOT, "..", `dsh-ws-${Date.now()}`);
    const added = (await h.call("jj_workspace", {
      action: "add",
      name: "agent-test",
      path,
    })) as { name: string; path: string; stdout: string };
    expect(added.name).toBe("agent-test");
    expect(added.path).toBe(path);

    const list = (await h.call("jj_workspace", { action: "list" })) as { name: string }[];
    expect(list.some((entry) => entry.name === "agent-test")).toBe(true);

    const forgotten = (await h.call("jj_workspace", {
      action: "forget",
      name: "agent-test",
    })) as { forgotten: boolean };
    expect(forgotten.forgotten).toBe(true);
    const after = (await h.call("jj_workspace", { action: "list" })) as { name: string }[];
    expect(after.some((entry) => entry.name === "agent-test")).toBe(false);
    rmSync(path, { recursive: true, force: true });
  });

  it("jj_show and jj_file read one revision without checking it out", async () => {
    const h = harnessAt(ROOT);
    const shown = (await h.call("jj_show", { revset: "@" })) as {
      commit: { change_id: string };
      files: unknown[];
    };
    expect(shown.commit.change_id.length).toBeGreaterThan(0);
    expect(Array.isArray(shown.files)).toBe(true);

    const listed = (await h.call("jj_file", { action: "list", revision: "@" })) as {
      paths: string[];
    };
    expect(listed.paths).toContain("f.txt");

    const content = (await h.call("jj_file", {
      action: "show",
      revision: "@",
      paths: ["f.txt"],
    })) as { content: string };
    expect(content.content).toContain("one");

    const searched = (await h.call("jj_file", {
      action: "search",
      revision: "@",
      pattern: "one",
    })) as { output: string };
    expect(searched.output).toContain("f.txt");
  });

  it("jj_evolog returns the change's evolution", async () => {
    const h = harnessAt(ROOT);
    const entries = (await h.call("jj_evolog", { revset: "@", limit: 2 })) as unknown[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("jj_op log and jj_publish tag-list return structured data", async () => {
    const h = harnessAt(ROOT);
    const ops = (await h.call("jj_op", { action: "log", limit: 3 })) as unknown[];
    expect(Array.isArray(ops)).toBe(true);
    expect(ops.length).toBeGreaterThan(0);

    const tags = (await h.call("jj_publish", { action: "tag-list" })) as unknown[];
    expect(Array.isArray(tags)).toBe(true);
  });

  it("jj_repair converge is a no-op on a clean repo", async () => {
    const h = harnessAt(ROOT);
    const result = (await h.call("jj_repair", { action: "converge" })) as {
      resolved: boolean;
      after: unknown[];
    };
    expect(result.resolved).toBe(true);
    expect(result.after).toEqual([]);
  });

  it("jj_test runs a command in an ephemeral workspace and cleans it up", async () => {
    // A file written only into @ proves the workspace is based on @, not on
    // @-: `jj workspace add` without -r would silently test the parent tree.
    writeFileSync(join(ROOT, "only-in-at.txt"), "at\n");
    const h = harnessAt(ROOT);
    const result = (await h.call("jj_test", {
      command: "test -f only-in-at.txt",
      deps: "none",
    })) as { exitCode: number; cleanedUp: boolean; workspace: { name: string } };
    expect(result.exitCode).toBe(0);
    expect(result.cleanedUp).toBe(true);

    const list = jj(ROOT, ["workspace", "list", "--ignore-working-copy"]);
    expect(list).not.toContain(result.workspace.name);
  });
});

describe.skipIf(!HAS_JJ)("the mutation surface runs real jj", () => {
  const MUT = mkdtempSync(join(tmpdir(), "dsh-jujutsu-mutations-"));

  beforeAll(() => {
    execFileSync("jj", ["git", "init", "--colocate"], { cwd: MUT, env: ENV });
    writeFileSync(join(MUT, "m.txt"), "mutation\n");
    execFileSync("jj", ["commit", "-m", "base"], { cwd: MUT, env: ENV });
  });

  afterAll(() => {
    try {
      rmSync(MUT, { recursive: true, force: true });
    } catch {
      /* the OS reclaims the temp area */
    }
  });

  it("jj_commit commits and starts a new change", async () => {
    const h = harnessAt(MUT);
    const before = jj(MUT, ["log", "--no-graph", "-r", "@", "-T", "change_id"]).trim();
    const result = (await h.call("jj_commit", { message: "feat: commit" })) as {
      mode: string;
      workingCopy: { change_id: string }[];
    };
    expect(result.mode).toBe("commit");
    expect(result.workingCopy[0]?.change_id).not.toBe(before);
    const description = jj(MUT, ["log", "--no-graph", "-r", "@-", "-T", "description"]).trim();
    expect(description).toContain("feat: commit");
  });

  it("jj_edit enters an existing change", async () => {
    const h = harnessAt(MUT);
    const target = jj(MUT, ["log", "--no-graph", "-r", "@-", "-T", "change_id"]).trim();
    const result = (await h.call("jj_edit", { revset: target })) as {
      workingCopy: { change_id: string }[];
    };
    expect(result.workingCopy[0]?.change_id).toBe(target);
  });

  it("jj_history abandons a change and returns operation anchors", async () => {
    const h = harnessAt(MUT);
    const result = (await h.call("jj_history", { action: "abandon", revsets: "@" })) as {
      action: string;
      beforeOpId?: string;
      afterOpId?: string;
    };
    expect(result.action).toBe("abandon");
    expect(result.beforeOpId).toBeTypeOf("string");
    expect(result.afterOpId).toBeTypeOf("string");
  });

  it("jj_test run mode uses jj run", async () => {
    const h = harnessAt(MUT);
    const result = (await h.call("jj_test", {
      mode: "run",
      command: "ls",
    })) as { mode: string; stdout: string };
    expect(result.mode).toBe("run");
    expect(result.stdout).toContain("m.txt");
  });

  it("jj_sparse list returns the current patterns", async () => {
    const h = harnessAt(MUT);
    const result = (await h.call("jj_sparse", { action: "list" })) as { patterns: string[] };
    expect(result.patterns).toContain(".");
  });

  it("jj_publish sets, lists and deletes a local tag", async () => {
    const h = harnessAt(MUT);
    await h.call("jj_publish", { action: "tag-set", tag: "v-test" });
    const tags = (await h.call("jj_publish", { action: "tag-list" })) as { name: string }[];
    expect(tags.some((tag) => tag.name === "v-test")).toBe(true);
    await h.call("jj_publish", { action: "tag-delete", tag: "v-test" });
    const after = (await h.call("jj_publish", { action: "tag-list" })) as { name: string }[];
    expect(after.some((tag) => tag.name === "v-test")).toBe(false);
  });

  it("jj_workspace remove deletes the workspace directory", async () => {
    const h = harnessAt(MUT);
    const path = join(MUT, "..", `dsh-remove-${Date.now()}`);
    await h.call("jj_workspace", { action: "add", name: "remove-test", path });
    expect(existsSync(path)).toBe(true);
    const removed = (await h.call("jj_workspace", {
      action: "remove",
      name: "remove-test",
    })) as { removed: boolean };
    expect(removed.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("jj_file chmod and delete mutate the revision", async () => {
    writeFileSync(join(MUT, "chmod.txt"), "x\n");
    writeFileSync(join(MUT, "delete.txt"), "x\n");
    const h = harnessAt(MUT);
    const chmod = (await h.call("jj_file", {
      action: "chmod",
      mode: "x",
      paths: ["chmod.txt"],
    })) as { opId: string | null };
    expect(chmod.opId).toBeTypeOf("string");
    const deleted = (await h.call("jj_file", {
      action: "delete",
      paths: ["delete.txt"],
    })) as { deleted: boolean; opId: string | null };
    expect(deleted.deleted).toBe(true);
    expect(deleted.opId).toBeTypeOf("string");
    const listed = jj(MUT, ["file", "list", "-r", "@"]);
    expect(listed).not.toContain("delete.txt");
  });
});

describe.skipIf(!HAS_JJ)("the extended surface runs real jj", () => {
  const EXTRA = mkdtempSync(join(tmpdir(), "dsh-jujutsu-extended-"));

  beforeAll(() => {
    execFileSync("git", ["init", "--bare", join(EXTRA, "remote.git")]);
    execFileSync("jj", ["git", "init", "--colocate"], { cwd: EXTRA, env: ENV });
    execFileSync("jj", ["git", "remote", "add", "origin", join(EXTRA, "remote.git")], {
      cwd: EXTRA,
      env: ENV,
    });
    writeFileSync(join(EXTRA, "x.txt"), "x\n");
    writeFileSync(join(EXTRA, "y.txt"), "y\n");
    execFileSync("jj", ["commit", "-m", "base"], { cwd: EXTRA, env: ENV });
    execFileSync("jj", ["bookmark", "create", "main", "-r", "@-"], { cwd: EXTRA, env: ENV });
    writeFileSync(join(EXTRA, "x.txt"), "x changed\n");
    writeFileSync(join(EXTRA, "y.txt"), "y changed\n");
  });

  afterAll(() => {
    try {
      rmSync(EXTRA, { recursive: true, force: true });
    } catch {
      /* the OS reclaims the temp area */
    }
  });

  it("jj_commit split divides a revision by path", async () => {
    const h = harnessAt(EXTRA);
    const result = (await h.call("jj_commit", {
      mode: "split",
      message: "split first",
      paths: ["x.txt"],
    })) as { mode: string };
    expect(result.mode).toBe("split");
    const log = jj(EXTRA, ["log", "--no-graph", "-r", "::@", "-T", "description"]).trim();
    expect(log).toContain("split first");
  });

  it("jj_op show describes the latest operation", async () => {
    const h = harnessAt(EXTRA);
    const opId = jj(EXTRA, ["op", "log", "--limit", "1", "--no-graph", "-T", "id.short()"]).trim();
    const result = (await h.call("jj_op", { action: "show", opId })) as { output: string };
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("jj_repair undo reverses the last operation", async () => {
    const h = harnessAt(EXTRA);
    const result = (await h.call("jj_repair", { action: "undo" })) as { undone: boolean };
    expect(result.undone).toBe(true);
  });

  it("jj_show patch returns diff text", async () => {
    const h = harnessAt(EXTRA);
    const result = (await h.call("jj_show", { revset: "@", patch: true })) as {
      patch?: string;
    };
    expect(typeof result.patch).toBe("string");
    expect(result.patch).toContain("x.txt");
  });

  it("jj_file annotate reads line provenance", async () => {
    const h = harnessAt(EXTRA);
    const result = (await h.call("jj_file", {
      action: "annotate",
      revision: "@",
      paths: ["x.txt"],
    })) as { output: string };
    expect(result.output).toContain("x changed");
  });

  it("jj_publish push previews and then pushes to a local remote", async () => {
    const h = harnessAt(EXTRA);
    const preview = (await h.call("jj_publish", {
      action: "push",
      bookmark: "main",
    })) as { dryRun: boolean; requiresConfirmation: boolean; stderr: string };
    expect(preview.dryRun).toBe(true);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.stderr).toContain("main");

    const pushed = (await h.call("jj_publish", {
      action: "push",
      bookmark: "main",
      confirm: true,
    })) as { dryRun: boolean; stderr: string };
    expect(pushed.dryRun).toBe(false);
    expect(pushed.stderr).toContain("main");
  });
});
