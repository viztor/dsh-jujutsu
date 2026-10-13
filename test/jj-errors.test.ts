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
