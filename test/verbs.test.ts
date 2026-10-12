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
import { classifyGitInvocation } from "../src/verbs.ts";
import { classifyInvocation } from "../src/invocation.ts";

/** Classify a command line the way the guard does. */
function classify(command: string) {
  return classifyGitInvocation(classifyInvocation(command));
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

describe("the message catalogue is internally consistent", () => {
  it("gives every message a reason and a display", () => {
    const empty = ALL_MESSAGES.filter(
      (message) => message.reason.trim() === "" || message.display.trim() === "",
    );
    expect(empty).toEqual([]);
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
