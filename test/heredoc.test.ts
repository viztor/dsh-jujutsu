/**
 * Heredoc bodies: data is not a command.
 *
 * The resolver has no heredoc state, so before the masking rule every line of a
 * heredoc body was analysed as if it were a command. Writing a paragraph of
 * documentation through `python3 - <<'EOF'` was denied because the prose said
 * `` `git clone` `` in a code span; the guard answered for a Git invocation
 * that would never run.
 *
 * These tests hold both directions of the narrow fix: a quoted body with no
 * shell named on the opener line is data and is blanked before analysis, while
 * everything a shell really executes — `bash <<'EOF'`, `cat <<'EOF' | zsh`,
 * `ssh host <<'EOF'` — stays scanned. `docs/21-guard-evasion.md` records the
 * residuals that remain (unquoted bodies, executors on later lines).
 */

import { describe, expect, it } from "vitest";

import { classifyInvocation } from "../src/invocation.ts";
import { destructiveTargetsVcs } from "../src/paths.ts";

const classify = (lines: readonly string[]) => classifyInvocation(lines.join("\n"));

describe("a quoted heredoc body", () => {
  it("is data for an interpreter, even when it reads like Git commands", () => {
    const r = classify([
      "python3 - <<'EOF'",
      "The docs tell you to run `git clone URL` and then `git status`.",
      "git commit -m x",
      "EOF",
    ]);
    expect(r.gitInvocations).toEqual([]);
    expect(
      r.notes.some((note) => note.startsWith("info: quoted heredoc body treated as data")),
    ).toBe(true);
  });

  it("is data when the heredoc appends a file (the live failure)", () => {
    // This is the shape that refused a real edit: `cat >> <file> <<'EOF'` with a
    // test body that mentions `git clone`. The body is the file's new content.
    const r = classify([
      "cat >> test/parse.test.ts <<'TESTEOF'",
      "// Run `git clone <url>` first, then `git status`.",
      "TESTEOF",
    ]);
    expect(r.gitInvocations).toEqual([]);
  });

  it("is data for a `jj` command that reads a message from stdin", () => {
    const r = classify([
      "jj describe --stdin <<'EOF'",
      "fix: `git clone` now works; see `git status`",
      "EOF",
    ]);
    expect(r.gitInvocations).toEqual([]);
    expect(r.jjInvocations).toEqual(["jj describe --stdin <<'EOF'"]);
  });

  it("is data whichever way the delimiter is quoted, and `<<-` strips tabs", () => {
    for (const opener of [
      `python3 - <<'EOF'`,
      `python3 - <<"EOF"`,
      `python3 - <<\\EOF`,
      `python3 - <<-'EOF'`,
    ]) {
      expect(classify([opener, "\tgit status", "EOF"]).gitInvocations, opener).toEqual([]);
    }
  });

  it("ends at the right delimiter when one line opens two of them", () => {
    const r = classify(["python3 - <<'A' <<'B'", "git clone A", "A", "git clone B", "B"]);
    expect(r.gitInvocations).toEqual([]);
  });
});

describe("a heredoc body a shell may execute", () => {
  it("is still scanned when the opener line names an executor", () => {
    for (const lines of [
      ["bash <<'EOF'", "git status", "EOF"],
      ["sh -s <<'EOF'", "git commit -m x", "EOF"],
      ["cat <<'EOF' | zsh", "git push", "EOF"],
      ["ssh host <<'EOF'", "git log", "EOF"],
      ["make -f - <<'EOF'", "all:", "\tgit status", "EOF"],
      ["source /dev/stdin <<'EOF'", "git status", "EOF"],
    ]) {
      expect(classify(lines).gitInvocations.length, lines[0]).toBeGreaterThan(0);
    }
  });

  it("is still scanned when the executor follows a trailing pipe", () => {
    expect(
      classify(["python3 - <<'EOF' |", "  zsh", "git push", "EOF"]).gitInvocations.length,
    ).toBeGreaterThan(0);
  });

  it("is still scanned when the delimiter is unquoted, so expansions run", () => {
    expect(classify(["cat <<EOF", "$(git status)", "EOF"]).gitInvocations.length).toBeGreaterThan(
      0,
    );
  });
});

describe("the destructive-path rule", () => {
  it("ignores a quoted body that merely talks about deleting a store", () => {
    // The guard's refusal for `rm -rf .git` scans the command text; a paragraph
    // being written is not an operand, and refusing it would make the guard
    // deny documentation about itself.
    const command = [
      "python3 - <<'EOF'",
      "Never run `rm -rf .git` or `rm -rf .jj`; that is unrecoverable.",
      "EOF",
    ].join("\n");
    expect(destructiveTargetsVcs(command)).toBeUndefined();
  });

  it("still sees a body a shell will execute", () => {
    expect(destructiveTargetsVcs(["bash <<'EOF'", "rm -rf .git", "EOF"].join("\n"))).toBe("git");
    expect(destructiveTargetsVcs(["cat <<'EOF' | zsh", "rm -rf .jj", "EOF"].join("\n"))).toBe("jj");
  });
});
