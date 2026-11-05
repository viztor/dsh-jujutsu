/**
 * Multi-agent coordination against real `jj`.
 *
 * The convention under test: `jj_workspace add` writes an ownership bookmark
 * (`agent/<name>`), `jj_coordinate` reads those bookmarks and the workspace
 * graph to suggest a group, and `jj_group merge` creates the integration merge.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/settings.ts";
import { buildToolDefinitions } from "../src/tools.ts";
import { fakeHarness, HAS_JJ, realShell } from "./helpers.ts";

const ROOT = mkdtempSync(join(tmpdir(), "dsh-jujutsu-coordination-"));
const IDENTITY = join(ROOT, "jj-config.toml");
const CONFIG = `/dev/null:${IDENTITY}`;
const ENV = { ...process.env, JJ_CONFIG: CONFIG };

function jj(cwd: string, args: readonly string[]): string {
  return execFileSync("jj", args, { cwd, encoding: "utf8", env: ENV });
}

function harnessAt(cwd: string, overrides: Record<string, unknown> = {}) {
  const harness = fakeHarness();
  realShell(harness.ctx, { JJ_CONFIG: CONFIG });
  const definitions = buildToolDefinitions(harness.ctx, resolveSettings(overrides));
  const exec = harness.session("coordination", cwd);
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

const WORK_A = join(ROOT, "..", `dsh-agent-a-${Date.now()}`);
const WORK_B = join(ROOT, "..", `dsh-agent-b-${Date.now()}`);

beforeAll(() => {
  writeFileSync(
    IDENTITY,
    ["[user]", 'name = "Coordination"', 'email = "coordination@example.invalid"', ""].join("\n"),
  );
  execFileSync("jj", ["git", "init", "--colocate"], { cwd: ROOT, env: ENV });
  writeFileSync(join(ROOT, "base.txt"), "base\n");
  execFileSync("jj", ["commit", "-m", "base"], { cwd: ROOT, env: ENV });
});

afterAll(() => {
  for (const path of [WORK_A, WORK_B]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* the OS reclaims the temp area */
    }
  }
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS reclaims the temp area */
  }
});

describe.skipIf(!HAS_JJ)("multi-agent coordination runs real jj", () => {
  it("creates ownership bookmarks with the workspaces", async () => {
    const h = harnessAt(ROOT);
    await h.call("jj_workspace", { action: "add", name: "agent-a", path: WORK_A });
    await h.call("jj_workspace", { action: "add", name: "agent-b", path: WORK_B });

    const bookmarks = jj(ROOT, ["bookmark", "list", "--ignore-working-copy"]);
    expect(bookmarks).toContain("agent/agent-a");
    expect(bookmarks).toContain("agent/agent-b");

    const list = (await h.call("jj_workspace", { action: "list" })) as {
      name: string;
      owner: string | null;
    }[];
    expect(list.find((entry) => entry.name === "agent-a")?.owner).toBe("agent/agent-a");
    expect(list.find((entry) => entry.name === "agent-b")?.owner).toBe("agent/agent-b");
  });

  it("jj_status reports the workspace and its owner", async () => {
    const worker = harnessAt(WORK_A);
    const status = (await worker.call("jj_status")) as {
      workspace: { name: string; owner: string | null } | null;
    };
    expect(status.workspace?.name).toBe("agent-a");
    expect(status.workspace?.owner).toBe("agent/agent-a");
  });

  it("commits work in each workspace, on its own change", async () => {
    for (const [path, name] of [
      [WORK_A, "agent-a.txt"],
      [WORK_B, "agent-b.txt"],
    ] as const) {
      writeFileSync(join(path, name), `${name}\n`);
      const h = harnessAt(path);
      const result = (await h.call("jj_commit", { message: `work from ${name}` })) as {
        workingCopy: { change_id: string }[];
      };
      expect(result.workingCopy[0]?.change_id.length).toBeGreaterThan(0);
    }
  });

  it("jj_coordinate finds both agent heads as merge candidates", async () => {
    const h = harnessAt(ROOT);
    const plan = (await h.call("jj_coordinate")) as {
      workspaces: { name: string; owner: string | null; conflicted: boolean }[];
      mergeCandidates: string[];
      recommended: { action: string; revsets: string[] } | null;
      groups: unknown[];
      warnings: string[];
    };
    expect(plan.workspaces.length).toBeGreaterThanOrEqual(3);
    expect(plan.workspaces.some((entry) => entry.name === "agent-a")).toBe(true);
    expect(plan.workspaces.some((entry) => entry.name === "agent-b")).toBe(true);
    // Ownership is matched by bookmark *name*, not target: the bookmark stays
    // on the initial @ while the agent commits on top of it.
    expect(plan.workspaces.find((entry) => entry.name === "agent-a")?.owner).toBe("agent/agent-a");
    expect(plan.workspaces.find((entry) => entry.name === "agent-b")?.owner).toBe("agent/agent-b");
    expect(plan.mergeCandidates.length).toBeGreaterThanOrEqual(2);
    expect(plan.recommended?.action).toBe("merge");
    expect(plan.recommended?.revsets.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(plan.groups)).toBe(true);
    expect(Array.isArray(plan.warnings)).toBe(true);
  });

  it("refuses jj_edit into another workspace's working copy when enforcing", async () => {
    const h = harnessAt(ROOT, { coordination: "enforce" });
    const result = (await h.call("jj_edit", { revset: "agent-a@" })) as {
      error?: { code: string };
    };
    expect(result.error?.code).toBe("JJ_CHANGE_OWNED_BY_WORKSPACE");
  });

  it("jj_group merge integrates the agent heads and names the group", async () => {
    const h = harnessAt(ROOT);
    const plan = (await h.call("jj_coordinate")) as { mergeCandidates: string[] };
    const merged = (await h.call("jj_group", {
      action: "merge",
      revsets: plan.mergeCandidates,
      message: "integration: agents a + b",
      bookmark: "group/integration",
    })) as { bookmark: string | null; opId: string | null };
    expect(merged.bookmark).toBe("group/integration");
    expect(merged.opId).toBeTypeOf("string");

    const bookmarks = jj(ROOT, ["bookmark", "list", "--ignore-working-copy"]);
    expect(bookmarks).toContain("group/integration");

    const headJson = jj(ROOT, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      'json(self) ++ "\\n"',
      "--ignore-working-copy",
    ]);
    const head = JSON.parse(headJson.trim().split("\n")[0]!) as { parents: string[] };
    // A merge of the two agent heads has two parents.
    expect(head.parents.length).toBeGreaterThanOrEqual(2);
  });

  it("jj_doctor reports the multi-agent configuration", async () => {
    const h = harnessAt(ROOT);
    const report = (await h.call("jj_doctor")) as {
      version: string | null;
      workspaces: unknown[];
      ownerBookmarks: { name: string }[];
      config: Record<string, string>;
      warnings: string[];
    };
    expect(report.version).toContain("jj");
    expect(report.workspaces.length).toBeGreaterThanOrEqual(3);
    expect(report.ownerBookmarks.length).toBeGreaterThanOrEqual(2);
    expect(report.config).toHaveProperty("snapshot.auto-update-stale");
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it("jj_sign reports the missing signing backend instead of pretending", async () => {
    const h = harnessAt(ROOT);
    const result = (await h.call("jj_sign", { action: "sign" })) as {
      error?: { code: string };
    };
    // No signing config in the generated identity, so jj must fail; the tool
    // surfaces that as a typed error rather than a success value.
    expect(result.error?.code).toBe("JJ_EXEC_FAILED");
  });
});

describe.skipIf(!HAS_JJ)("jj_group stack runs real jj", () => {
  const STACK = mkdtempSync(join(tmpdir(), "dsh-jujutsu-stack-"));
  let base = "";
  let a = "";
  let b = "";

  beforeAll(() => {
    execFileSync("jj", ["git", "init", "--colocate"], { cwd: STACK, env: ENV });
    writeFileSync(join(STACK, "base.txt"), "base\n");
    execFileSync("jj", ["commit", "-m", "base"], { cwd: STACK, env: ENV });
    base = jj(STACK, ["log", "--no-graph", "-r", "@", "-T", "change_id"]).trim();

    execFileSync("jj", ["new", base, "-m", "A"], { cwd: STACK, env: ENV });
    writeFileSync(join(STACK, "a.txt"), "a\n");
    execFileSync("jj", ["commit", "-m", "A"], { cwd: STACK, env: ENV });
    a = jj(STACK, ["log", "--no-graph", "-r", "@-", "-T", "change_id"]).trim();

    execFileSync("jj", ["new", base, "-m", "B"], { cwd: STACK, env: ENV });
    writeFileSync(join(STACK, "b.txt"), "b\n");
    execFileSync("jj", ["commit", "-m", "B"], { cwd: STACK, env: ENV });
    b = jj(STACK, ["log", "--no-graph", "-r", "@-", "-T", "change_id"]).trim();
  });

  afterAll(() => {
    try {
      rmSync(STACK, { recursive: true, force: true });
    } catch {
      /* the OS reclaims the temp area */
    }
  });

  it("chains independent heads into a linear stack under a bookmark", async () => {
    const h = harnessAt(STACK);
    const result = (await h.call("jj_group", {
      action: "stack",
      revsets: [a, b],
      onto: base,
      bookmark: "group/stack",
    })) as { changes: string[]; bookmark: string | null };
    expect(result.changes).toEqual([a, b]);
    expect(result.bookmark).toBe("group/stack");

    const aParent = jj(STACK, [
      "log",
      "--no-graph",
      "-r",
      a,
      "-T",
      'parents.map(|p| p.change_id()).join(",")',
    ]).trim();
    const bParent = jj(STACK, [
      "log",
      "--no-graph",
      "-r",
      b,
      "-T",
      'parents.map(|p| p.change_id()).join(",")',
    ]).trim();
    expect(aParent).toBe(base);
    expect(bParent).toBe(a);

    const bookmarkTarget = jj(STACK, [
      "log",
      "--no-graph",
      "-r",
      "group/stack",
      "-T",
      "change_id",
    ]).trim();
    expect(bookmarkTarget).toBe(b);
  });

  it("jj_history parallelize turns the stack into siblings", async () => {
    const h = harnessAt(STACK);
    await h.call("jj_history", { action: "parallelize", revsets: `${a}::${b}` });
    const bParent = jj(STACK, [
      "log",
      "--no-graph",
      "-r",
      b,
      "-T",
      'parents.map(|p| p.change_id()).join(",")',
    ]).trim();
    expect(bParent).toBe(base);
  });

  it("jj_workspace rename renames the current workspace", async () => {
    const h = harnessAt(STACK);
    const result = (await h.call("jj_workspace", {
      action: "rename",
      newName: "stack-renamed",
    })) as { renamed: boolean };
    expect(result.renamed).toBe(true);
    const list = jj(STACK, ["workspace", "list", "--ignore-working-copy"]);
    expect(list).toContain("stack-renamed");
  });
});
