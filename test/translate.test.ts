/**
 * Static analysis: the concrete `jj` command a refusal hands back.
 *
 * The catalogue in `messages.ts` names the replacement for a *shape* of
 * command; `translate.ts` names it for the command the model actually
 * typed. That distinction is the whole feature — `Refused: git log. Run:
 * jj log` still leaves the model to work out what its six flags mean,
 * which is the reasoning this module exists to remove.
 *
 * Three classes of test, because three things can go wrong:
 *
 * 1. **The composition.** A reason assembled from the wrong pieces is
 *    worse than the catalogue string it replaced; it is specific *and*
 *    wrong. These assert the exact sentence.
 * 2. **The analysis.** Every Git spelling has to be rewritten, dropped,
 *    or refused — never passed through to `jj` unchanged, because
 *    `jj log HEAD~2` and `git log HEAD~2` are different commands and
 *    `HEAD` is not a `jj` revset at all.
 * 3. **The emitted command runs.** A test can be entirely self-consistent
 *    and still produce a command line `jj` rejects. The last block
 *    executes every translation against the installed binary in a real
 *    fixture repository, and skips (loudly) when `jj` is absent.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MAX_REASON_CHARS, VERB_ROWS } from "../src/messages.ts";
import { classifyInvocation } from "../src/invocation.ts";
import { refusalReason, translateEquivalent } from "../src/translate.ts";
import { classifyGitInvocation } from "../src/verbs.ts";
import { FIXTURES, HAS_FIXTURES, HAS_JJ } from "./helpers.ts";

/** Translate the way the guard does, from a full command line. */
function equivalentOf(command: string): string | undefined {
  const decision = classifyGitInvocation(classifyInvocation(command));
  return decision.kind === "refuse" ? decision.equivalent : undefined;
}

/** The refusal reason the guard would return for a command line. */
function reasonFor(command: string): string {
  const decision = classifyGitInvocation(classifyInvocation(command));
  if (decision.kind !== "refuse") throw new Error(`not refused: ${command}`);
  return refusalReason(decision.source ?? "", decision.equivalent, decision.message.reason);
}

describe("the composed refusal names the command that was typed", () => {
  it("carries the typed arguments and the concrete replacement", () => {
    // The screenshot that started this: `git log --oneline -6` answered with
    // "Run: jj log", which is not the same command and leaves the model to
    // translate six flags itself. The composed reason answers the question.
    expect(reasonFor("git log --oneline -6")).toBe(
      "Refused: git log --oneline -6. Run: jj log -r ::@ --limit 6 --no-graph",
    );
  });

  it("keeps the catalogue message when no translation exists", () => {
    // `git add` has no equivalent at all — jj tracks files automatically. The
    // catalogue string explains that, and composing over it would replace an
    // explanation with a command that does not exist.
    expect(reasonFor("git add src/a.ts")).toContain("no staging area");
    expect(equivalentOf("git add src/a.ts")).toBeUndefined();
  });

  it("quotes the typed command the way the model typed it", () => {
    // The refusal has to be recognisable as the model's own command, so the
    // message carries the original text with its quoting intact — not a
    // re-joined argv that reads as if the quotes were never there.
    expect(reasonFor("git commit -m 'fix the thing'")).toBe(
      "Refused: git commit -m 'fix the thing'. Run: jj commit -m 'fix the thing'",
    );
  });

  it("does not pretend a substituted command is the one that ran", () => {
    // `$(date)` was expanded before analysis; repeating it back as if it were
    // literal text would describe a command that never existed.
    expect(reasonFor("git log --oneline $(date)")).not.toContain("$(date)");
  });

  it("falls back rather than emitting an over-budget sentence", () => {
    // Copy rule 2 is a hard bound. A pathologically long argument (a 400-char
    // path, a commit message) must not push the reason past it — the refusal
    // would then be truncated by the harness, and a truncated command is worse
    // than a generic one.
    const long = "a".repeat(400);
    const fallback = "Refused: git status. Run: jj status";
    expect(refusalReason(`status ${long}`, "jj status", fallback)).toBe(fallback);
    expect(refusalReason(`status ${long}`, "jj status", fallback).length).toBeLessThanOrEqual(
      MAX_REASON_CHARS,
    );
  });

  it("holds the budget for every row's realistic form", () => {
    // The bound is asserted against the composed strings, not only the
    // transcribed ones: composition is where length is introduced.
    const over = [
      "log --oneline -6",
      "status",
      "diff --staged",
      "branch -d feat",
      "commit -m 'fix'",
      "push origin main",
      "fetch origin",
      "remote add origin https://example.invalid/repo.git",
    ]
      .map((source) => reasonFor(`git ${source}`))
      .filter((reason) => reason.length > MAX_REASON_CHARS);
    expect(over).toEqual([]);
  });
});

describe("revisions are rewritten into jj revsets", () => {
  it("maps HEAD, HEAD~N and HEAD^ onto @", () => {
    // `jj log HEAD~2` is an error — `HEAD` is not a jj revset (verified
    // against jj 0.46: `Error: Revision 'HEAD' doesn't exist`). Passing a Git
    // revision through unchanged is the single most likely way this feature
    // could hand back a command that cannot run.
    expect(equivalentOf("git show HEAD")).toBe("jj show @");
    expect(equivalentOf("git show HEAD~2")).toBe("jj show @--");
    expect(equivalentOf("git show HEAD^")).toBe("jj show @-");
    expect(equivalentOf("git diff HEAD~1")).toBe("jj diff --from @-");
  });

  it("refuses a revision that has no jj spelling", () => {
    // `HEAD^2` addresses the second parent of a merge. Revsets have no
    // positional parent selector, so there is nothing faithful to emit — and
    // emitting `@^2` anyway would be a command jj rejects at run time.
    expect(equivalentOf("git log HEAD^2")).toBeUndefined();
    expect(equivalentOf("git show HEAD^2")).toBeUndefined();
  });

  it("leaves a bookmark or change id alone", () => {
    // `main`, a change id, and a SHA are all valid revset atoms already. The
    // test is that normalization does not damage them.
    expect(equivalentOf("git log --oneline main")).toBe("jj log -r main --no-graph");
    expect(equivalentOf("git show abc123")).toBe("jj show abc123");
  });

  it("reads a bare filename as a path and a version tag as a revision", () => {
    // Git spells revisions and paths identically and decides at run time;
    // static analysis has to pick, and picking wrong costs a failing command.
    // A filename (`README.md`, `package.json`) is a fileset; a dotted tag
    // (`v1.2.3`) is not, because its last segment does not start with a
    // letter. Verified: the fileset guess degrades to a warning that names
    // the fix, the revision guess to a bare error.
    expect(equivalentOf("git diff README.md")).toBe("jj diff README.md");
    expect(equivalentOf("git diff src/main.ts")).toBe("jj diff src/main.ts");
    expect(equivalentOf("git diff main")).toBe("jj diff --from main");
    expect(equivalentOf("git diff v1.2.3")).toBe("jj diff --from v1.2.3");
    expect(equivalentOf("git log --oneline README.md")).toBe("jj log -r ::@ --no-graph README.md");
  });
});

describe("read-only verbs translate their flags", () => {
  it("translates --oneline and a count into --no-graph and --limit", () => {
    // `--oneline` is a flat list, which is `--no-graph`; `-6` is a bound,
    // which is `--limit`. Both are exact; neither exists under these names in
    // `jj log`.
    expect(equivalentOf("git log --oneline")).toBe("jj log -r ::@ --no-graph");
    expect(equivalentOf("git log -6")).toBe("jj log -r ::@ --limit 6");
    expect(equivalentOf("git log -n 3")).toBe("jj log -r ::@ --limit 3");
    expect(equivalentOf("git log --max-count=2")).toBe("jj log -r ::@ --limit 2");
  });

  it("defaults to the ancestry of @, as bare `git log` walks from HEAD", () => {
    // Bare `jj log` shows the configured revsets.log, which in a repository
    // with bookmarks is not the ancestry of the working copy. `::@` is.
    expect(equivalentOf("git log")).toBe("jj log -r ::@");
    expect(equivalentOf("git log --oneline --all")).toBe("jj log -r 'all()' --no-graph");
  });

  it("translates a diff range into --from and --to", () => {
    expect(equivalentOf("git diff")).toBe("jj diff");
    expect(equivalentOf("git diff HEAD~1")).toBe("jj diff --from @-");
    expect(equivalentOf("git diff main..feature")).toBe("jj diff --from main --to feature");
    expect(equivalentOf("git diff --stat")).toBe("jj diff --stat");
  });

  it("refuses a diff that needs the index jj does not have", () => {
    // `--staged` asks what is in the index. There is no index, so any
    // answer — including `jj diff` — would be about different content.
    expect(equivalentOf("git diff --staged")).toBeUndefined();
    expect(equivalentOf("git diff --cached")).toBeUndefined();
  });

  it("drops a flag jj has no spelling for, rather than dropping the command", () => {
    // Broader output than asked for is a surprise the model can see and
    // correct; no output at all is the behaviour this feature replaces.
    expect(equivalentOf("git log --oneline --since=2d")).toBe("jj log -r ::@ --no-graph");
    expect(equivalentOf("git show --pretty=fuller")).toBe("jj show");
  });
});

describe("mutating verbs are all-or-nothing", () => {
  it("translates the forms whose every argument maps", () => {
    expect(equivalentOf("git commit -m 'fix the thing'")).toBe("jj commit -m 'fix the thing'");
    expect(equivalentOf("git branch -d feat")).toBe("jj bookmark delete feat");
    expect(equivalentOf("git branch feat")).toBe("jj bookmark create feat -r @");
    expect(equivalentOf("git push origin main")).toBe(
      "jj git push --remote origin --bookmark main",
    );
    expect(equivalentOf("git fetch origin")).toBe("jj git fetch --remote origin");
    expect(equivalentOf("git remote add origin https://x/y.git")).toBe(
      "jj git remote add origin https://x/y.git",
    );
  });

  it("drops --force from a push, because jj push is already force-with-lease", () => {
    expect(equivalentOf("git push --force origin main")).toBe(
      "jj git push --remote origin --bookmark main",
    );
  });

  it("refuses a mutating form whose flags would have to be dropped", () => {
    // `git commit --amend` and `git status --porcelain` are different
    // commands from their bare forms. Emitting the bare translation would
    // tell the model its command was understood when it was not.
    expect(equivalentOf("git commit")).toBeUndefined();
    expect(equivalentOf("git commit --amend -m x")).toBeUndefined();
    expect(equivalentOf("git status --porcelain")).toBeUndefined();
    expect(equivalentOf("git blame -L 10,20 src/a.ts")).toBeUndefined();
    expect(equivalentOf("git push --tags")).toBeUndefined();
    expect(equivalentOf("git reset --hard")).toBeUndefined();
  });

  it("translates a --soft reset with an explicit target only", () => {
    // `HEAD~1` names a *different* commit the changes are being un-committed
    // to, which is the one form `docs/15` §1 settles. `--soft` alone and
    // `--soft HEAD` are both refusals, and they are the interesting pair:
    // in Git they are no-ops, and the obvious `jj` moves for them
    // (`jj squash --from @-`, `jj squash --from @`) rewrite history. A
    // no-op must never be translated into a rewrite.
    expect(equivalentOf("git reset --soft HEAD~1")).toBe("jj squash --from @-");
    expect(equivalentOf("git reset --soft")).toBeUndefined();
    expect(equivalentOf("git reset --soft HEAD")).toBeUndefined();
    // `--source @-` is a different verb and still works: the revision it
    // names is the target of `jj restore --from`, not of a squash.
    expect(equivalentOf("git restore --source @- src/a.ts")).toBe("jj restore --from @- src/a.ts");
  });

  it("nests the subcommand of -C through -R", () => {
    // `-R` is jj's `-C`. A version that passed the Git subcommand through
    // untranslated would hand back `jj -R dir log --oneline`, which is not a
    // jj command.
    expect(equivalentOf("git -C ../other status")).toBe("jj -R ../other status");
    expect(equivalentOf("git -C ../other log --oneline -3")).toBe(
      "jj -R ../other log -r ::@ --limit 3 --no-graph",
    );
  });

  it("refuses to nest a subcommand it cannot translate", () => {
    expect(equivalentOf("git -C ../other status --porcelain")).toBeUndefined();
  });

  it("spells the two-command checkout as two commands", () => {
    // jj has no branch-switch step: a new change and a bookmark on its parent
    // are two commands, and pretending otherwise would emit a command line
    // with a comma in it.
    // Joined with `&&` so the sentence is itself a runnable command line —
    // "jj new, then jj bookmark create …" is prose the model must take apart.
    expect(equivalentOf("git checkout -b feat")).toBe("jj new && jj bookmark create feat -r @-");
    expect(equivalentOf("git switch -c feat main")).toBe(
      "jj new main && jj bookmark create feat -r @-",
    );
  });
});

describe("the emitted command is shell-safe", () => {
  it("quotes a commit message that contains shell metacharacters", () => {
    // The one translation that carries free text. A message the model typed
    // must not be able to break the command it is told to paste.
    const translated = equivalentOf("git commit -m 'a; rm -rf b'");
    expect(translated).toBe("jj commit -m 'a; rm -rf b'");

    // Round-trip through a real shell: the argument jj receives is the
    // message verbatim, not two commands.
    const out = execFileSync("/bin/sh", [
      "-c",
      `printf '%s\\n' ${(translated ?? "").replace(/^jj commit -m /, "")}`,
    ])
      .toString()
      .trimEnd();
    expect(out).toBe("a; rm -rf b");
  });

  it("quotes a path containing a space", () => {
    expect(equivalentOf("git status 'my dir/'")).toBe("jj status 'my dir/'");
  });

  it("never mentions the project name where a command belongs", () => {
    // The command is `jj`. `jujutsu` is the project, and it is not a program:
    // a refusal that says `Run: jujutsu log` is a refusal that fails with
    // "command not found" when the model pastes it. (The harness surfaces the
    // same confusion as `unknown tool "jujutsu"`.)
    const sources = [
      "log --oneline -6",
      "status",
      "commit -m x",
      "branch -a",
      "push origin main",
      "checkout -b feat",
      "diff HEAD~1",
      "stash",
      "-C ../x status",
    ];
    for (const source of sources) {
      const equivalent = equivalentOf(`git ${source}`);
      if (equivalent === undefined) continue;
      for (const word of equivalent.split(/\s+/)) {
        expect(word.startsWith("jujutsu") && word !== "jujutsu", `in "${equivalent}"`).toBe(false);
      }
      expect(equivalent.split(/\s+/).includes("jujutsu"), `in "${equivalent}"`).toBe(false);
    }
  });
});

describe("coverage against the catalogue", () => {
  /**
   * Verbs the catalogue refuses and static analysis deliberately does not
   * translate, each with the reason it cannot.
   *
   * This list is the feature's bound. A verb added to `VERB_ROWS` without a
   * translation and without an entry here fails the test below, which is the
   * point: the gap should be a decision someone made, not an oversight.
   */
  const NOT_TRANSLATED: Readonly<Record<string, string>> = {
    add: "there is no staging area to add to; jj tracks files automatically",
    rebase: "the source and destination are implied by Git's branch model, which jj does not have",
    pull: "two commands with a conditional second one (jj git fetch, then jj rebase)",
    submodule: "jj has no submodule support",
    bisect: "jj bisect run takes a required --range that git bisect infers",
    clean: "jj has no untracked state to clean",
    lfs: "jj has no LFS integration",
  };

  /** A representative argument list for each verb the catalogue refuses. */
  const EXAMPLES: Readonly<Record<string, string[]>> = {
    status: [],
    diff: [],
    log: [],
    add: ["src/a.ts"],
    commit: ["-m", "x"],
    branch: ["-a"],
    checkout: ["-b", "feat"],
    switch: ["main"],
    merge: ["main"],
    rebase: ["main"],
    reset: ["--soft", "HEAD~1"],
    stash: [],
    "cherry-pick": ["@-"],
    revert: ["@-"],
    tag: [],
    push: ["origin", "main"],
    pull: [],
    fetch: [],
    clone: ["https://x/y.git"],
    remote: ["-v"],
    worktree: ["add", "../x"],
    submodule: ["update"],
    bisect: ["run", "make"],
    blame: ["src/a.ts"],
    show: [],
    clean: ["-fd"],
    restore: ["src/a.ts"],
    init: ["somewhere"],
    "-C": ["../other", "status"],
    config: ["--get", "user.name"],
    lfs: ["pull"],
  };

  it("has an example for every verb the catalogue refuses", () => {
    // A new row with no example would silently skip the check below.
    const covered = new Set(Object.keys(EXAMPLES));
    const missing = [...new Set(VERB_ROWS.map((row) => row.match[0] ?? ""))]
      .filter((verb) => !covered.has(verb))
      .sort();
    expect(missing).toEqual([]);
  });

  it("translates every verb it does not explicitly decline", () => {
    // The two lists together must partition the catalogue. A verb in neither
    // is a verb the model types and gets no help with.
    const undecided = Object.entries(EXAMPLES)
      .filter(([verb]) => !(verb in NOT_TRANSLATED))
      .filter(([verb, args]) => translateEquivalent(verb, args) === undefined)
      .map(([verb]) => verb);
    expect(undecided).toEqual([]);
  });

  it("declines only verbs whose message already explains the gap", () => {
    // The fallback has to be good enough on its own for every declined verb,
    // because it is all the model will get.
    const unhelpful = Object.keys(NOT_TRANSLATED)
      .map((verb) => VERB_ROWS.find((row) => row.match[0] === verb)?.message.reason ?? "")
      .filter((reason) => reason.length < 40);
    expect(unhelpful).toEqual([]);
  });
});

/**
 * The documented examples are the shipped strings.
 *
 * `docs/25` §2.4 and the README both print a table of "you type this, you get
 * that". A table like that is right on the day it is written and wrong after
 * the next tuning of a flag, and it is read by exactly the person deciding
 * whether to trust the feature. So the document is parsed and every row is
 * replayed through the same code the guard uses.
 */
describe("the documented examples are what the code produces", () => {
  /** Rows of a markdown table whose first cell is a `git …` command. */
  function documentedPairs(text: string): { command: string; reason: string }[] {
    const out: { command: string; reason: string }[] = [];
    for (const line of text.split("\n")) {
      const cells = line
        .trim()
        .split("|")
        .map((cell) => cell.trim());
      // `| command | …explanation… | Refused: … |`
      if (cells.length < 5) continue;
      const command = /^`(git [^`]+)`$/.exec(cells[1] ?? "")?.[1];
      if (command === undefined) continue;
      const reason = /^(Refused: .*)$/.exec(cells[3] ?? "")?.[1];
      if (reason === undefined) continue;
      out.push({ command, reason });
    }
    return out;
  }

  it("matches docs/25 §2.4 row for row", () => {
    const doc = readFileSync("docs/25-prompt-copy.md", "utf8");
    const section = doc.slice(doc.indexOf("### 2.4"), doc.indexOf("## 3. Tool descriptions"));
    const pairs = documentedPairs(section);
    expect(
      pairs.length,
      "§2.4 documented at least the five worked examples",
    ).toBeGreaterThanOrEqual(5);
    const wrong = pairs
      .map((pair) => ({ ...pair, actual: reasonFor(pair.command) }))
      .filter((pair) => pair.actual !== pair.reason)
      .map((pair) => `${pair.command}\n  doc:  ${pair.reason}\n  real: ${pair.actual}`);
    expect(wrong).toEqual([]);
  });

  it("matches the README's worked examples", () => {
    const readme = readFileSync("README.md", "utf8");
    const rows = readme
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\|\s*`git /.test(line) && line.includes("Refused:"));
    expect(rows.length, "the README table keeps concrete examples").toBeGreaterThanOrEqual(4);

    const wrong: string[] = [];
    for (const row of rows) {
      const command = /\|\s*`(git [^`]+)`/.exec(row)?.[1];
      const reason = /(Refused: [^`]+?)\s*`/.exec(row)?.[1]?.trim();
      if (command === undefined || reason === undefined) continue;
      const actual = reasonFor(command);
      if (actual !== reason) wrong.push(`${command}\n  README: ${reason}\n  real:   ${actual}`);
    }
    expect(wrong).toEqual([]);
  });
});

/**
 * The installed binary, not a mock.
 *
 * Every translation above is a string this module believes is a `jj`
 * command. Only `jj` can say whether it is one. These run in a fixture
 * repository, one command at a time, and assert a zero exit.
 */
describe.skipIf(!HAS_JJ || !HAS_FIXTURES)("every translation is a jj command that runs", () => {
  /** Run a translated command; return the exit code. */
  function run(command: string, cwd: string): number {
    try {
      execFileSync("/bin/sh", ["-c", command], {
        cwd,
        stdio: "pipe",
        env: { ...process.env, JJ_CONFIG: `${FIXTURES}/jj-config.toml` },
      });
      return 0;
    } catch (error) {
      return typeof (error as { status?: unknown }).status === "number"
        ? ((error as { status: number }).status ?? 1)
        : 1;
    }
  }

  const cwd = `${FIXTURES}/jj-with-changes`;

  it("runs every translation that has one", () => {
    // The fixture is colocated and has one commit plus working-copy changes,
    // so `@`, `@-`, `::@` and `all()` all resolve there.
    //
    // `git fetch` is absent on purpose: the fixture has no remote, so
    // `jj git fetch` exits 1 for a reason that has nothing to do with the
    // translation. Its shape is asserted in the unit tests above instead.
    const commands = [
      "git log --oneline -6",
      "git log",
      "git log -n 3",
      "git log --oneline @-",
      "git log --oneline --all",
      "git status",
      "git diff",
      "git diff @-",
      "git diff --stat",
      "git show",
      "git show @-",
      "git branch",
      "git branch -a",
      "git tag",
      "git remote -v",
      "git config --get user.name",
      "git -C . status",
      "git -C . log --oneline -2",
      // Every command below is one a model types and one that was, at some
      // point, emitted as a `jj` command that exits non-zero:
      //   `git log --oneline --graph` -> `jj log -r ::@ --no-graph --graph`  (rc=2)
      //   `git log --oneline --count` -> `… --no-graph --count`              (rc=2)
      //   `git checkout -- -x`        -> `jj restore -x`                     (rc=2)
      //   `git commit -m --`          -> `jj commit -m --`                   (rc=2)
      //   `git merge --abort`         -> `jj new @ --abort`                  (rc=2)
      // Their assertions are "no translation", so they belong to the second
      // test below; they are listed here to keep the pair adjacent.
      "git log --oneline --stat",
      "git diff --context 3",
      "git restore --source @- a.txt",
      "git switch main",
    ];
    const failures = commands
      .map((command) => ({ command, equivalent: equivalentOf(command) }))
      .filter((entry) => entry.equivalent !== undefined)
      .map((entry) => ({ ...entry, code: run(entry.equivalent ?? "", cwd) }))
      .filter((entry) => entry.code !== 0)
      .map((entry) => `${entry.command} -> ${entry.equivalent} (exit ${entry.code})`);
    expect(failures).toEqual([]);
  });

  it("does not claim a translation for a command jj would reject", () => {
    // The other half: a translation that returns undefined must not be one
    // that jj would have accepted anyway — otherwise the fallback is being
    // used for something that could have been answered concretely.
    for (const command of ["git log HEAD^2", "git status --porcelain"]) {
      expect(equivalentOf(command), command).toBeUndefined();
    }
  });

  it("refuses the flag combinations jj itself refuses", () => {
    // A refusal, not a translation, and the reason is `jj`'s own grammar:
    // `jj log --no-graph --graph` exits 2, as does `--no-graph --count`.
    // Every mapping in the module is per-flag, so nothing but this
    // inspection of the finished argv knows the two cannot sit together.
    //
    // Verified against jj 0.46.0 before being pinned here: each form below
    // was emitted once and then executed, and each exited 2.
    for (const command of [
      "git log --oneline --graph",
      "git log --oneline --count",
      "git log --oneline --stat --count",
      "git checkout -- -x",
      "git commit -m --",
      "git merge --abort",
    ]) {
      expect(equivalentOf(command), command).toBeUndefined();
    }
    // And the pair must not be over-refused: `--oneline` alone, and
    // `--stat` with it, are exactly what the module promises.
    expect(equivalentOf("git log --oneline")).toBe("jj log -r ::@ --no-graph");
    expect(equivalentOf("git log --oneline --stat")).toBe("jj log -r ::@ --no-graph --stat");
  });
});
