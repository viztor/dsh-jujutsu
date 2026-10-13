/**
 * `jj`'s own failures, mapped onto the codes `docs/26` declares for them.
 *
 * Two of them were arriving as `JJ_EXEC_FAILED`, which made a caller unable to
 * tell "you are not in a workspace" or "that revset does not parse" from a crash.
 * Both messages below are `jj` 0.46.0's own text.
 *
 * The shell is scripted: these assert the *mapping*, and running real `jj` for a
 * deliberately broken revset would make the test depend on `jj`'s exact wording
 * staying wrong.
 */

import { describe, expect, it } from "vitest";

import { applyTools } from "../src/tools.ts";
import { resolveSettings } from "../src/settings.ts";
import { fakeHarness } from "./helpers.ts";

/** A harness whose `jj` always fails with the given stderr. */
function failing(stderr: string) {
  const harness = fakeHarness();
  const shell = {
    resolve: (request: unknown) => request,
    execute: async () => ({
      result: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: { text: "", truncated: false },
        stderr: { text: stderr, truncated: false },
      }),
    }),
  };
  const target = harness.ctx as unknown as { get: (n: string) => unknown };
  const get = target.get;
  target.get = (name: string) => (name === "shell" ? shell : get.call(target, name));
  applyTools(harness.ctx, resolveSettings({}));
  return harness;
}

/** Call a tool and return its typed error, if any. */
async function call(harness: ReturnType<typeof failing>, tool: string, args: unknown) {
  const { buildToolDefinitions } = await import("../src/tools.ts");
  const defs = buildToolDefinitions(harness.ctx, resolveSettings({}));
  const definition = defs.find((d) => d.name === tool) as
    | { execute: (a: unknown, e: unknown) => Promise<unknown> }
    | undefined;
  return (await definition?.execute(args, harness.session("s1", "/tmp").exec("bash", {}))) as
    | { error?: { code: string; message: string; hint?: string } }
    | undefined;
}

describe("jj's own failures carry their declared code", () => {
  it("maps a missing workspace onto NOT_JJ_WORKSPACE", async () => {
    // P8 in `docs/26`: any `jj_*` tool, no readable `.jj/` at the resolved root.
    const outcome = await call(
      failing('Error: There is no jj repo in "."\nHint: It looks like this is a git repo.'),
      "jj_status",
      {},
    );
    expect(outcome?.error?.code).toBe("NOT_JJ_WORKSPACE");
    expect(outcome?.error?.hint).toContain("jj git init");
  });

  it("maps an unparseable revset onto REVSET_INVALID", async () => {
    const outcome = await call(
      failing("Error: Failed to parse revset: bogus(\nCaused by:  --> 1:1"),
      "jj_log",
      { revset: "bogus(" },
    );
    expect(outcome?.error?.code).toBe("REVSET_INVALID");
    expect(outcome?.error?.hint).toContain("jj help revsets");
  });

  it("still reports anything else as JJ_EXEC_FAILED", async () => {
    // The mapping must not swallow the general case: a genuine runtime failure
    // is still a runtime failure, and its advice is still "run it by hand".
    const outcome = await call(failing("Error: something else went wrong"), "jj_status", {});
    expect(outcome?.error?.code).toBe("JJ_EXEC_FAILED");
    expect(outcome?.error?.hint).toContain("by hand");
  });
});

describe("a missing shell service is not a missing binary", () => {
  it("reports SHELL_EXEC_FAILED rather than offering an install", async () => {
    // `fakeHarness` mounts no shell. Before this, the hunk bridge read that as
    // "jj-hunk is not installed" and offered to install it — advice that could
    // not be followed, because the install would need the same shell.
    const harness = fakeHarness();
    applyTools(harness.ctx, resolveSettings({ hunkInstall: "ask" }));

    const { buildToolDefinitions } = await import("../src/tools.ts");
    const defs = buildToolDefinitions(harness.ctx, resolveSettings({ hunkInstall: "ask" }));
    const hunk = defs.find((d) => d.name === "jj_hunk_list") as {
      execute: (a: unknown, e: unknown) => Promise<unknown>;
    };
    const outcome = (await hunk.execute(
      { query: "added()" },
      harness.session("s1", "/tmp").exec("bash", {}),
    )) as { error?: { code: string; hint?: string } };
    expect(outcome.error?.code).toBe("SHELL_EXEC_FAILED");
    expect(outcome.error?.hint).toContain("shell service");

    const status = defs.find((d) => d.name === "jj_status") as {
      execute: (a: unknown, e: unknown) => Promise<unknown>;
    };
    const fromJj = (await status.execute({}, harness.session("s1", "/tmp").exec("bash", {}))) as {
      error?: { code: string };
    };
    expect(fromJj.error?.code).toBe("SHELL_EXEC_FAILED");
  });
});

describe("the repository layout probes", () => {
  /** A harness whose fs answers for one path and throws for another. */
  function withFs(options: { readonly gitTarget?: string; readonly throwOn?: string }) {
    const harness = fakeHarness();
    const shell = {
      resolve: (r: unknown) => r,
      execute: async () => ({
        result: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: { text: "", truncated: false },
          stderr: { text: "", truncated: false },
        }),
      }),
    };
    const fs = {
      resolve: async (path: string) => path,
      stat: async (target: string) => {
        if (options.throwOn !== undefined && String(target).includes(options.throwOn)) {
          throw new Error("EACCES");
        }
        if (String(target).endsWith("git_target")) return { type: "file" };
        if (String(target).endsWith("/.jj/repo/store/../../../.git")) return undefined;
        return { type: "directory" };
      },
      readText: async () => options.gitTarget ?? "",
    };
    const target = harness.ctx as unknown as { get: (n: string) => unknown };
    const get = target.get;
    target.get = (name: string) =>
      name === "shell" ? shell : name === "fs" ? fs : get.call(target, name);
    applyTools(harness.ctx, resolveSettings({}));
    return harness;
  }

  it("reports JJ_REPO_BROKEN when git_target names a missing directory", async () => {
    // `docs/26` P9. A colocated repo whose `.git` was deleted leaves `git_target`
    // naming a path that is not there, and `jj` fails with something generic.
    const harness = withFs({ gitTarget: "../../../.git" });
    const { buildToolDefinitions, forgetRepoChecks } = await import("../src/tools.ts");
    forgetRepoChecks();
    const defs = buildToolDefinitions(harness.ctx, resolveSettings({}));
    const status = defs.find((d) => d.name === "jj_status") as {
      execute: (a: unknown, e: unknown) => Promise<unknown>;
    };
    const outcome = (await status.execute({}, harness.session("s1", "/repo").exec("bash", {}))) as {
      error?: { code: string };
    };
    expect(outcome.error?.code).toBe("JJ_REPO_BROKEN");
  });

  it("stays silent for a native repo, where git_target is the literal `git`", async () => {
    const harness = withFs({ gitTarget: "git" });
    const { buildToolDefinitions, forgetRepoChecks } = await import("../src/tools.ts");
    forgetRepoChecks();
    const defs = buildToolDefinitions(harness.ctx, resolveSettings({}));
    const status = defs.find((d) => d.name === "jj_status") as {
      execute: (a: unknown, e: unknown) => Promise<unknown>;
    };
    const outcome = (await status.execute({}, harness.session("s1", "/repo").exec("bash", {}))) as {
      error?: { code: string };
    };
    expect(outcome.error?.code).not.toBe("JJ_REPO_BROKEN");
  });
});
