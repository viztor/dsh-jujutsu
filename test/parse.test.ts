/**
 * The port's regression suite.
 *
 * `src/invocation.ts` is a byte-identical copy of
 * `scripts/probe-invocation.mjs`, whose behaviour is described in
 * `docs/21-guard-evasion.md`. This test exists so that "it is a port, not a
 * rewrite" is a checkable claim rather than a comment.
 *
 * The numbers below are **deliberately exact**. They are the prototype's
 * measured behaviour, and a change to any of them means the port changed
 * behaviour — which is the thing this test is for. Improving the parser is
 * welcome; it just has to be a deliberate edit to these numbers, in its own
 * commit, with the reason recorded.
 */

import { describe, expect, it } from "vitest";

import { CORPUS, classifyInvocation, runCorpus } from "../src/invocation.ts";

describe("the ported invocation resolver", () => {
  it("has the corpus it was verified against", () => {
    expect(CORPUS.length).toBe(64);
  });

  it("behaves exactly as the prototype did", () => {
    const { counts, lowConfidence } = runCorpus();
    expect(counts).toEqual({
      correct: 54,
      "false negative": 10,
      "false positive": 0,
    });
    expect(lowConfidence).toBe(16);
  });

  it("never produces a false positive", () => {
    // The invariant that matters most: a wrong denial blocks real work and the
    // model then flails. A missed Git call costs one stale read.
    const { rows } = runCorpus();
    const falsePositives = rows.filter((r) => r.verdict === "false positive");
    expect(falsePositives).toEqual([]);
  });

  it("flags every false negative as low confidence", () => {
    // No miss may be silent — that is the property that makes the residual gaps
    // in docs/21 tolerable, because policy turns low confidence into a question.
    const { rows } = runCorpus();
    const misses = rows.filter((r) => r.verdict === "false negative");
    expect(misses.length).toBeGreaterThan(0);
    for (const miss of misses) {
      expect(miss.r.confidence).toBe("low");
    }
  });
});

describe("the rules that carry the most weight", () => {
  it("resolves `jj git <sub>` to jj, not git — the carve-out needs no exception list", () => {
    for (const command of ["jj git export", "jj git fetch", "jj git push", "jj git init"]) {
      expect(classifyInvocation(command).gitInvocations, command).toEqual([]);
    }
  });

  it("does not deny a command that merely mentions git", () => {
    for (const command of [
      'echo "git commit -m x"',
      "echo git",
      'grep -rn "git status" docs/',
      "cat .git/config",
    ]) {
      expect(classifyInvocation(command).gitInvocations, command).toEqual([]);
    }
  });

  it("resolves through wrappers and nested shells", () => {
    for (const command of [
      "env FOO=1 git push",
      "command git status",
      "sh -c 'git commit'",
      'bash -lc "git push"',
      "\\git status",
      "/usr/bin/git status",
      'echo "v=$(git rev-parse HEAD)"',
    ]) {
      expect(classifyInvocation(command).gitInvocations.length, command).toBeGreaterThan(0);
    }
  });

  it("does not confuse a differently-named binary for git", () => {
    for (const command of ["git-lfs pull", "jj-hunk list"]) {
      expect(classifyInvocation(command).gitInvocations, command).toEqual([]);
    }
  });

  it("records which fragments run `jj`, the way it records Git", () => {
    // The workspace rule is a decision about `jj`, and `gitInvocations` cannot
    // answer it: the guard's Git rule resolves `jj git push` to jj on purpose.
    // `jjInvocations` is the list the rule walks, so it has to survive wrappers,
    // absolute paths and the long binary name — the three shapes the Git list
    // already handles.
    expect(classifyInvocation("jj log").jjInvocations).toEqual(["jj log"]);
    expect(classifyInvocation("jujutsu status").jjInvocations).toEqual(["jujutsu status"]);
    expect(classifyInvocation("/usr/local/bin/jj log").jjInvocations).toEqual([
      "/usr/local/bin/jj log",
    ]);
    expect(classifyInvocation("env FOO=1 jj log").jjInvocations).toEqual(["env FOO=1 jj log"]);
  });

  it("keeps each `jj` fragment, so a rule can walk the whole line", () => {
    // `jj git init --colocate && jj log` is one command; a list that collapsed
    // it to a single string could not tell the guard that the first fragment
    // creates the workspace the second one needs.
    expect(classifyInvocation("jj log && jj git push").jjInvocations).toEqual([
      "jj log",
      "jj git push",
    ]);
    expect(classifyInvocation("jj git init --colocate && jj log").jjInvocations).toEqual([
      "jj git init --colocate",
      "jj log",
    ]);
  });

  it("does not record `jj` when it is only mentioned or renamed", () => {
    for (const command of ['echo "jj log"', "jj-hunk list", "git commit -m 'jj log'"]) {
      expect(classifyInvocation(command).jjInvocations, command).toEqual([]);
    }
  });
});
