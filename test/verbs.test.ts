/**
 * The Git→`jj` classification, and the catalogue's internal consistency.
 *
 * `verbs.ts` is exercised hard through the guard, which is why it had no direct
 * test — but the guard tests assert *what happens to a command*, and these
 * assert the table's own shape: that a refusal always carries the two strings
 * every consumer needs, and that the prefix and read-only helpers behave on the
 * edges rather than only on the examples.
 *
 * The catalogue is the plugin's product. A row with an empty `reason` would ship
 * `Error: ` to the model, and a row with an empty `display` would render an
 * approval prompt with nothing to approve.
 */

import { describe, expect, it } from "vitest";

import { ALL_MESSAGES, VERB_ROWS } from "../src/messages.ts";
import { classifyGitInvocation, classifyJjInvocation } from "../src/verbs.ts";
import { classifyInvocation } from "../src/invocation.ts";

/** Classify a command line the way the guard does. */
function classify(command: string) {
  return classifyGitInvocation(classifyInvocation(command));
}

/** Apply the workspace rule to a command line. */
function workspaceRule(command: string) {
  return classifyJjInvocation(classifyInvocation(command));
}

describe("classifyGitInvocation", () => {
  it("allows a command with no Git invocation at all", () => {
    // The guard's job is Git, not shell. A `jj` command, a `gh` call or a plain
    // `ls` are all none of its business.
    for (const command of ["jj status", "gh pr list", "ls -la", "echo hi"]) {
      expect(classify(command).kind, command).toBe("allow");
    }
  });

  it("refuses a mutating Git verb and names the jj replacement", () => {
    const decision = classify("git commit -m 'x'");
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.verb).toBe("commit");
    // The copy rule: a refusal names the exact command to run instead.
    expect(decision.message.reason).toContain("jj");
  });

  it("tells read-only Git apart from mutating Git", () => {
    // The distinction drives which config posture applies, so getting it
    // backwards would silently send a write down the read-only path.
    const read = classify("git status");
    const write = classify("git push origin main");
    expect(read.kind).toBe("refuse");
    expect(write.kind).toBe("refuse");
    if (read.kind !== "refuse" || write.kind !== "refuse") return;
    expect(read.classification === "special" || read.classification === "deny").toBe(true);
    expect(write.classification).toBe("deny");
  });
});

describe("classifyJjInvocation — the workspace rule", () => {
  it("allows a command that never runs `jj`", () => {
    for (const command of ["git status", "ls -la", "echo hi", "jj-hunk list"]) {
      expect(workspaceRule(command), command).toEqual({ kind: "allow" });
    }
  });

  it("refuses a subcommand that needs a workspace, and names it", () => {
    // The name matters: the refusal copy is one sentence for every subcommand,
    // so the model learns which word was the problem from this field.
    expect(workspaceRule("jj status")).toEqual({ kind: "refuse", verb: "status" });
    expect(workspaceRule("jj log -r ::@")).toEqual({ kind: "refuse", verb: "log" });
    expect(workspaceRule("jj git fetch")).toEqual({ kind: "refuse", verb: "git fetch" });
  });

  it("allows the commands that answer without a workspace", () => {
    // Measured on 0.46.0 (`docs/13` §1). Refusing these would be the guard
    // inventing a limitation `jj` does not have.
    for (const command of [
      "jj config list",
      "jj help",
      "jj util completion bash",
      "jj --version",
      "jj version",
      "jj",
    ]) {
      expect(workspaceRule(command), command).toEqual({ kind: "allow" });
    }
  });

  it("allows naming the repository, in all three spellings", () => {
    // `jj -R ../repo log` works from anywhere, so it satisfies the requirement
    // it would otherwise fail.
    for (const command of [
      "jj -R ../repo log",
      "jj --repository ../repo log",
      "jj --repository=../repo log",
      "jj -R../repo log",
    ]) {
      expect(workspaceRule(command), command).toEqual({ kind: "allow" });
    }
  });

  it("allows `jj git init` and `jj git clone`, which create the workspace", () => {
    for (const command of [
      "jj git init --colocate",
      "jj git clone https://example.com/repo",
      "jj -R other git init",
    ]) {
      expect(workspaceRule(command), command).toEqual({ kind: "allow" });
    }
  });

  it("does not refuse what follows a workspace-creating fragment", () => {
    // `jj git init --colocate && jj log` is the exact line the refusal copy
    // recommends; denying its second half would make the advice unusable.
    expect(workspaceRule("jj git init --colocate && jj log")).toEqual({ kind: "allow" });
    expect(workspaceRule("jj git clone url && jj status")).toEqual({ kind: "allow" });
  });

  it("still refuses the first offending fragment, wherever it is", () => {
    // A later `init` does not excuse an earlier command that needed a workspace.
    expect(workspaceRule("jj log && jj git init --colocate")).toEqual({
      kind: "refuse",
      verb: "log",
    });
  });

  it("skips global flags that take a value", () => {
    // `--config` takes the next word; reading it as the subcommand would name a
    // config file in the refusal.
    expect(workspaceRule("jj --config ui.color=always log")).toEqual({
      kind: "refuse",
      verb: "log",
    });
    expect(workspaceRule("jj --color never status")).toEqual({ kind: "refuse", verb: "status" });
    expect(workspaceRule("jj --config-toml x log")).toEqual({ kind: "refuse", verb: "log" });
    expect(workspaceRule("jj --at-operation abc log")).toEqual({ kind: "refuse", verb: "log" });
  });

  it("recognises the long binary name and a path to either", () => {
    for (const command of ["jujutsu status", "/usr/local/bin/jj status", "/x/jj.exe status"]) {
      expect(workspaceRule(command), command).toEqual({ kind: "refuse", verb: "status" });
    }
  });

  it("stops at `--`, which cannot introduce a subcommand", () => {
    // `jj -- status` passes `status` as a path argument to the *op*, whatever
    // that op is; reading it as a subcommand would be a guess.
    expect(workspaceRule("jj -- status")).toEqual({ kind: "allow" });
  });
});

describe("the message catalogue is internally consistent", () => {
  it("gives every message a reason, and a display that is never blank", () => {
    // `display` is optional now: absent means the reason stands in for it, which
    // is what thirteen rows were spelling out by copying the reason verbatim.
    // What must not happen is a display that is *present and empty* — that would
    // render an approval prompt with nothing to approve, which is worse than
    // having none at all.
    const bad = ALL_MESSAGES.filter(
      (message) => message.reason.trim() === "" || message.display?.trim() === "",
    );
    expect(bad).toEqual([]);
  });

  it("does not copy the reason into the display", () => {
    // The duplication this replaced: two hand-edited copies of one sentence, of
    // which only one is read by a test. When there is nothing shorter to say, the
    // field is absent.
    const copied = ALL_MESSAGES.filter((message) => message.display === message.reason);
    expect(copied).toEqual([]);
  });

  it("keeps every reason inside the character budget", () => {
    // `messages.ts` asserts this at load and would throw on import, so reaching
    // this line at all is most of the proof. The assertion restates the bound so
    // a future move of the check cannot quietly drop it.
    const over = ALL_MESSAGES.filter((message) => message.reason.length > 240);
    expect(over).toEqual([]);
  });

  it("gives every row a non-empty match", () => {
    // A row matching nothing is dead weight that still reads as coverage.
    const empty = VERB_ROWS.filter((row) => row.match.length === 0);
    expect(empty).toEqual([]);
  });
});
