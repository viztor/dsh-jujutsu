/**
 * The guard, end to end through the plugin entry point.
 *
 * `apply()` is called on a harness double, then real tool calls are driven
 * through the registered `tools/pre-execute` listener. The workspace is a real
 * `jj` repository built by the fixture script and read from the real disk, so
 * detection inside the guard is exercised for real rather than stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { apply } from "../src/index.ts";
import { forget } from "../src/bypass.ts";
import { invalidateDetection } from "../src/detect.ts";
import { invalidateMarkers } from "../src/marker.ts";
import { FIXTURES, fakeHarness, HAS_FIXTURES } from "./helpers.ts";

/** A `bash` call in the colocated fixture. */
function bash(
  harness: ReturnType<typeof fakeHarness>,
  command: string,
  cwd = `${FIXTURES}/jj-colocated`,
) {
  return harness.session("s1", cwd).exec("bash", { command, description: "test" });
}

function harnessWith(config: Record<string, unknown> = {}, policy?: "ask" | "never") {
  const harness = fakeHarness(policy === undefined ? {} : { policy });
  // `bypass: 'deny'` by default here so the refusal tests assert refusal. The
  // shipped default is `'ask'` (SPEC.md §6), and the ask posture is exercised
  // explicitly in its own block below.
  apply(harness.ctx, { guard: "deny", bypass: "deny", ...config });
  return harness;
}

beforeEach(() => {
  forget();
  // `marker.test.ts` writes a `/tmp/.dsh-jujutsu.json` to prove the switch
  // reaches the guard. Its cache entry outlives the file by the TTL, and the
  // fixtures live under `/tmp`, so without this the guard tests below would run
  // with the plugin switched off.
  invalidateMarkers();
  // Detection caches per root in a module-level Map. Without this, the
  // fail-open test would read a cache entry populated by an earlier test and
  // never reach its throwing filesystem double.
  invalidateDetection();
});

describe.skipIf(!HAS_FIXTURES)("the guard refuses Git inside a jj workspace", () => {
  it("denies `git commit` and names `jj commit`", async () => {
    const h = harnessWith({ readOnlyGit: "deny" });
    const decision = await h.preExecute(bash(h, "git commit -m 'fix'"));
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reason).toContain("jj commit");
  });

  it("hands back the concrete command, not the shape of one", async () => {
    // The end-to-end form of the feature: what reaches the model is a command
    // it can run as typed. `git log --oneline -6` has its flags translated and
    // its revision default filled in; a reason that said "run jj log" would
    // leave the model to do the analysis the guard already did.
    const h = harnessWith({ readOnlyGit: "deny" });
    const decision = await h.preExecute(bash(h, "git log --oneline -6"));
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reason).toBe(
      "Refused: git log --oneline -6. Run: jj log -r ::@ --limit 6 --no-graph",
    );
  });

  it("says `jj`, never `jujutsu`, in every replacement it hands back", async () => {
    // `jujutsu` is the project; `jj` is the binary. A refusal that names the
    // project as a command sends the model to `jujutsu log`, which fails with
    // "command not found" — the same failure mode as the harness's
    // `unknown tool "jujutsu"`.
    const h = harnessWith({ readOnlyGit: "deny" });
    for (const command of [
      "git log --oneline -6",
      "git status",
      "git branch -d feat",
      "git push origin main",
      "git checkout -b feat",
    ]) {
      const decision = await h.preExecute(bash(h, command));
      expect(decision.kind, command).toBe("deny");
      if (decision.kind !== "deny") continue;
      expect(decision.reason, command).toContain("Run: jj");
      expect(decision.reason, command).not.toContain("Run: jujutsu");
    }
  });

  it("keeps the catalogue reason when nothing can be translated", async () => {
    // `git add` has no equivalent. The composed path must not fire here, or
    // the model gets a command that does not exist instead of the explanation
    // of why there is none.
    const h = harnessWith();
    const decision = await h.preExecute(bash(h, "git add src/a.ts"));
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") return;
    expect(decision.reason).toContain("no staging area");
    expect(decision.reason).not.toContain("Run: jj add");
  });

  it("denies `git push`", async () => {
    const h = harnessWith();
    const decision = await h.preExecute(bash(h, "git push origin main"));
    expect(decision.kind).toBe("deny");
  });

  it("composes the reason on an ask, not only on a deny", async () => {
    // This was a real defect, and the tests could not see it: every refusal
    // test pins `readOnlyGit: "deny"`, so the deny arm was the only one
    // exercised — while `readOnlyGit: "ask"` is the *shipped default* and its
    // arm returned the catalogue string. The common path therefore kept
    // handing the model `Refused: git status describes a Git working tree…`
    // instead of `Run: jj status`, which is the whole feature missing.
    const h = harnessWith({ readOnlyGit: "ask" });
    const decision = await h.preExecute(bash(h, "git log --oneline -6"));
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") return;
    expect(decision.reason).toBe(
      "Refused: git log --oneline -6. Run: jj log -r ::@ --limit 6 --no-graph",
    );
    // The human-facing string stays the family variant: the prompt is about
    // the consequence, and it is not the channel that teaches the syntax.
    expect(decision.displayReason?.en).toContain("read-only Git command");
  });

  it("asks and denies with the same composed reason", async () => {
    // Two postures, one answer. If these ever diverge, one of them is stale.
    const asking = harnessWith({ readOnlyGit: "ask" });
    const denying = harnessWith({ readOnlyGit: "deny" });
    const asked = await asking.preExecute(bash(asking, "git diff HEAD~1"));
    const denied = await denying.preExecute(bash(denying, "git diff HEAD~1"));
    expect((asked as { reason?: string }).reason).toBe((denied as { reason?: string }).reason);
  });

  it("asks about read-only Git by default, and denies it when configured", async () => {
    const asking = harnessWith();
    expect((await asking.preExecute(bash(asking, "git status"))).kind).toBe("ask");

    const denying = harnessWith({ readOnlyGit: "deny" });
    expect((await denying.preExecute(bash(denying, "git status"))).kind).toBe("deny");

    const allowing = harnessWith({ readOnlyGit: "allow" });
    expect((await allowing.preExecute(bash(allowing, "git status"))).kind).toBe("allow");
  });

  it("never lets `readOnlyGit: allow` open a mutating form", async () => {
    // The whole point of R6: `branch` is read-only as a listing and mutating as
    // `branch -d`. A user who allowed looking did not allow rewriting.
    const h = harnessWith({ readOnlyGit: "allow" });
    expect((await h.preExecute(bash(h, "git branch"))).kind).toBe("allow");
    expect((await h.preExecute(bash(h, "git branch -d feat"))).kind).toBe("deny");
  });
});

describe.skipIf(!HAS_FIXTURES)("the guard is invisible outside a jj workspace", () => {
  it("allows Git in a plain Git repo", async () => {
    const h = harnessWith();
    const decision = await h.preExecute(bash(h, "git commit -m x", `${FIXTURES}/plain-git`));
    expect(decision.kind).toBe("allow");
  });

  it("allows Git in a directory that is not a repo", async () => {
    const h = harnessWith();
    expect((await h.preExecute(bash(h, "git status", `${FIXTURES}/not-a-repo`))).kind).toBe(
      "allow",
    );
  });

  it("allows non-Git commands", async () => {
    const h = harnessWith();
    expect((await h.preExecute(bash(h, "pnpm build"))).kind).toBe("allow");
  });
});

describe.skipIf(!HAS_FIXTURES)("the carve-outs and the false positives", () => {
  it("allows `jj git <sub>`", async () => {
    const h = harnessWith();
    for (const command of ["jj git export", "jj git fetch", "jj git push"]) {
      expect((await h.preExecute(bash(h, command))).kind, command).toBe("allow");
    }
  });

  it("allows a command that merely mentions git", async () => {
    const h = harnessWith();
    for (const command of ['echo "git commit"', "grep -rn git docs/"]) {
      expect((await h.preExecute(bash(h, command))).kind, command).toBe("allow");
    }
  });
});

describe.skipIf(!HAS_FIXTURES)("destructive paths — the unrecoverable class", () => {
  it("refuses `rm -rf .git` in a colocated repo", async () => {
    const h = harnessWith({ readOnlyGit: "allow" });
    const decision = await h.preExecute(bash(h, "rm -rf .git"));
    expect(decision.kind).not.toBe("allow");
    if (decision.kind === "deny") {
      // The message must name what is destroyed and offer the safe alternative.
      // It used to assert a specific word ("unrecoverable"), which broke the
      // moment the copy improved — testing the wording, not the job.
      expect(decision.reason).toContain(".git");
      expect(decision.reason).toContain("jj git colocation disable");
    }
  });

  it("does not refuse `.gitignore` or `.github`", async () => {
    const h = harnessWith();
    for (const command of ["rm -rf .gitignore", "rm -rf .github/workflows"]) {
      expect((await h.preExecute(bash(h, command))).kind, command).toBe("allow");
    }
  });

  it("asks, never allows, when the path is computed", async () => {
    const h = harnessWith();
    const decision = await h.preExecute(bash(h, 'rm -rf "$PWD/.git"'));
    expect(decision.kind).not.toBe("allow");
  });
});

describe.skipIf(!HAS_FIXTURES)("write protection", () => {
  it("refuses a write into .jj", async () => {
    const h = harnessWith();
    const exec = h.session("s1", `${FIXTURES}/jj-colocated`).exec("write", {
      file_path: `${FIXTURES}/jj-colocated/.jj/working_copy/tree_state`,
      content: "x",
    });
    expect((await h.preExecute(exec)).kind).not.toBe("allow");
  });

  it("allows a READ of .jj", async () => {
    const h = harnessWith();
    const exec = h.session("s1", `${FIXTURES}/jj-colocated`).exec("read", {
      file_path: `${FIXTURES}/jj-colocated/.jj/repo`,
    });
    expect((await h.preExecute(exec)).kind).toBe("allow");
  });

  it("allows a write to an ordinary file", async () => {
    const h = harnessWith();
    const exec = h.session("s1", `${FIXTURES}/jj-colocated`).exec("write", {
      file_path: `${FIXTURES}/jj-colocated/notes.md`,
      content: "x",
    });
    expect((await h.preExecute(exec)).kind).toBe("allow");
  });
});

describe.skipIf(!HAS_FIXTURES)("the approval policy", () => {
  it("denies rather than asks under `never`, so our message survives", async () => {
    // Under `never` an ask auto-rejects *and* dsh-tools substitutes its own
    // reason, losing the jj command entirely (docs/17).
    const h = harnessWith({}, "never");
    const decision = await h.preExecute(bash(h, "git commit -m x"));
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") expect(decision.reason).toContain("jj");
  });

  it("asks under the deployment default when there is no session override", async () => {
    const harness = fakeHarness({ defaultPolicy: "never" });
    apply(harness.ctx, { guard: "deny" });
    // `overrideOf` returns undefined, so the deployment default must be read —
    // the three-term expression. A two-term read would conclude "ask" here.
    expect((await harness.preExecute(bash(harness, "git commit -m x"))).kind).toBe("deny");
  });
});

describe.skipIf(!HAS_FIXTURES)("the remembered bypass", () => {
  it("stops asking once the user has approved a verb", async () => {
    const h = harnessWith({ bypass: "ask" });
    const first = bash(h, "git commit -m one");
    expect((await h.preExecute(first)).kind).toBe("ask");

    // An asked call that then ran is an approval.
    await h.postExecute(first, { isError: false });

    const second = bash(h, "git commit -m two");
    expect((await h.preExecute(second)).kind).toBe("allow");
  });

  it("does not remember a verb the user rejected", async () => {
    const h = harnessWith({ bypass: "ask" });
    const first = bash(h, "git commit -m one");
    await h.preExecute(first);
    await h.postExecute(first, { isError: true }); // rejected

    expect((await h.preExecute(bash(h, "git commit -m two"))).kind).toBe("ask");
  });

  it("can be switched off", async () => {
    const h = harnessWith({ bypass: "ask", rememberBypass: false });
    const first = bash(h, "git commit -m one");
    await h.preExecute(first);
    await h.postExecute(first, { isError: false });
    expect((await h.preExecute(bash(h, "git commit -m two"))).kind).toBe("ask");
  });
});

describe.skipIf(!HAS_FIXTURES)("fail open", () => {
  it("allows the call when the detector throws", async () => {
    // A throw inside `tools/pre-execute` becomes a tool error that skips
    // post-execute for every call, so the guard must swallow its own failures.
    const harness = fakeHarness();
    const ctx = harness.ctx as unknown as { get: (n: string) => unknown };
    const realGet = ctx.get.bind(ctx);
    ctx.get = (name: string) => {
      if (name !== "fs") return realGet(name);
      return {
        resolve: async () => ({ targetKey: "x" }),
        stat: async () => {
          throw new Error("detector exploded");
        },
      };
    };
    apply(harness.ctx, { guard: "deny" });
    expect((await harness.preExecute(bash(harness, "git commit -m x"))).kind).toBe("allow");
  });
});

describe.skipIf(!HAS_FIXTURES)("destructive paths — expansions must not over-trigger", () => {
  const h = () => {
    const harness = fakeHarness();
    apply(harness.ctx, { guard: "deny", bypass: "deny", readOnlyGit: "deny" });
    return harness;
  };
  const at = (harness: ReturnType<typeof fakeHarness>, command: string) =>
    harness.session("s1", `${FIXTURES}/jj-colocated`).exec("bash", {
      command,
      description: "test",
    });

  it("allows an ordinary computed path", async () => {
    // Found live: `rm -rf $R` was refused, which would block every
    // `rm -rf $BUILD_DIR` in every jj repository.
    const harness = h();
    for (const command of [
      "rm -rf $BUILD_DIR",
      'rm -rf "$TMPDIR/cache"',
      "rm -rf ${OUT}/dist",
      "rm -rf $(mktemp -d)",
    ]) {
      expect((await harness.preExecute(at(harness, command))).kind, command).toBe("allow");
    }
  });

  it("still refuses an expansion that names .git or .jj", async () => {
    const harness = h();
    for (const command of [
      'rm -rf "$PWD/.git"',
      "rm -rf $(jj workspace root)/.git",
      'rm -rf "${REPO}/.jj"',
    ]) {
      const decision = await harness.preExecute(at(harness, command));
      expect(decision.kind, command).not.toBe("allow");
    }
  });

  it("does not fire on a computed path that merely starts like one", async () => {
    const harness = h();
    expect((await harness.preExecute(at(harness, "rm -rf $DIR/.gitignore"))).kind).toBe("allow");
  });
});

describe.skipIf(!HAS_FIXTURES)("fail-open is loud", () => {
  it("allows the call and reports the error when the guard throws", async () => {
    // Fail-open is deliberate: a throw here would become a tool error that skips
    // post-execute for *every* call. But swallowing it silently means a broken
    // detector disables the guard for the rest of the session and nothing says
    // so — the user would read that as "there was nothing to refuse".
    //
    // Reaching the fail-open path needs something the guard does NOT already
    // guard internally. Breaking `ctx.fs` does not work: `detect.safeType`
    // catches that itself and returns `undefined`, so the call is allowed by the
    // ordinary "cannot tell" route and the outer catch never runs. `decide`
    // reads `exec.name` unguarded, so a throwing getter lands there.
    const h = fakeHarness();
    apply(h.ctx, { guard: "deny", bypass: "deny", readOnlyGit: "deny" });

    const exec = bash(h, "git commit -m 'fix'");
    Object.defineProperty(exec, "name", {
      get() {
        throw new Error("detector exploded");
      },
      configurable: true,
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const decision = await h.preExecute(exec);
      // Fail open: the command is allowed.
      expect(decision.kind).toBe("allow");
      // And it is reported, tagged with the package so it can be found.
      expect(spy).toHaveBeenCalled();
      const reported = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(reported).toContain("[dsh-jujutsu]");
      expect(reported).toContain("guard failed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a denial carries a durable code", () => {
  // `docs/26` documented these as `info.code` values before the guard set any.
  // The harness has always allowed it — `PreToolDecision`'s deny arm declares
  // `info?: ToolErrorInfo` — so the doc was right and the code was incomplete.
  //
  // The code is not for the model: `reason` is. It exists so a log or a durable
  // projection can say *which* rule fired without parsing prose, and so a test
  // can tell the three refusals apart from outside.

  /** A harness with the guard denying outright, and a `bash` execution. */
  function armed() {
    const harness = fakeHarness();
    apply(harness.ctx, { guard: true, bypass: "deny", readOnlyGit: "deny" });
    return {
      harness,
      // A property, not a method: the tests below destructure it, and a bare
      // reference to a method reads as an unbound receiver.
      bashAt: (command: string, cwd = `${FIXTURES}/jj-colocated`) =>
        harness.session("s1", cwd).exec("bash", { command, description: "test" }),
    };
  }

  it("names the Git rule", async () => {
    const { harness, bashAt } = armed();
    const decision = await harness.preExecute(bashAt("git commit -m x"));
    expect(decision).toMatchObject({ kind: "deny", info: { code: "GUARD_GIT_DENIED" } });
  });

  it("names the internals-write rule", async () => {
    const { harness } = armed();
    const exec = harness.session("s1", `${FIXTURES}/jj-colocated`).exec("write", {
      file_path: `${FIXTURES}/jj-colocated/.jj/working_copy/tree_state`,
    });
    const decision = await harness.preExecute(exec);
    expect(decision).toMatchObject({ kind: "deny", info: { code: "GUARD_JJ_INTERNALS_WRITE" } });
  });

  it("names the destructive-path rule", async () => {
    const { harness, bashAt } = armed();
    const decision = await harness.preExecute(bashAt("rm -rf .jj"));
    expect(decision).toMatchObject({ kind: "deny", info: { code: "GUARD_REPO_STORE_DELETE" } });
  });

  it("keeps the code out of what the model sees", async () => {
    // The whole point of `info` is that it is durable and not model-facing. A
    // code leaking into `reason` would have the model reading a diagnostic.
    const { harness, bashAt } = armed();
    const decision = await harness.preExecute(bashAt("git status"));
    expect(decision).toMatchObject({ kind: "deny" });
    expect((decision as { reason: string }).reason).not.toContain("GUARD_");
  });
});
