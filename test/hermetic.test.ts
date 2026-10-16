/**
 * The suite must be hermetic: it may write only inside `/tmp` and the workspace.
 *
 * `test/e2e.test.ts` used `jj config set --repo user.name …` to give its fixture
 * an identity. That writes `~/.config/jj/repos/<id>/config.toml` — outside both
 * writable roots — so under the DSH file sandbox the suite was **red** on the
 * very machines the plugin ships to, with
 *
 *   Cannot access ~/.config/jj/repos/<id>: Operation not permitted
 *
 * and green only where `HOME` happened to be writable. It also left a file in
 * the user's own config. `docs/20-test-plan.md` §b already stated the contract —
 * `JJ_CONFIG="/dev/null:<generated file>"` — and said explicitly not to use
 * `jj config set --repo`.
 *
 * Fixing one call site does not fix the class. The next contributor adding an
 * identity, a cache, or a scratch file reaches for the same habits this scan
 * bans, so the rule is a check rather than a paragraph. The same class is why
 * `~/.config` paths must never be hard-coded: a test that depends on the
 * author's home directory passes for the author and nobody else.
 */

import { globSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** One pattern no test file may contain, and the failure it caused. */
interface Rule {
  /** How the offender is named in the failure. Never the matched text. */
  readonly what: string;
  readonly pattern: RegExp;
  readonly why: string;
}

const RULES: readonly Rule[] = [
  {
    what: "a repo-scoped jj config write (`--repo`)",
    // Both spellings: the shell string `jj config set --repo …` and the argv
    // array `["config", "set", "--repo", …]`. The bare flag is the thing that
    // writes outside the sandbox, so matching it covers both without guessing
    // at quoting. jj's own path option is `-R`/`--repository`, not `--repo`.
    pattern: /--repo\b/,
    why:
      "`jj config set --repo` writes ~/.config/jj/repos/<id>/config.toml, which " +
      "the DSH file sandbox does not permit — the suite goes red on the machines " +
      "the plugin ships to. Generate the identity inside the test's own /tmp root " +
      "and pass it as JJ_CONFIG instead (docs/20-test-plan.md §b).",
  },
  {
    what: "a read of $HOME",
    pattern: /process\.env\.HOME\b/,
    why:
      "A test that reads the author's home directory passes for the author and " +
      "fails for everyone else, and it is the first step towards writing there. " +
      "Use a directory the test creates under /tmp.",
  },
  {
    what: "a read of the home directory (`homedir()`)",
    pattern: /\bhomedir\s*\(/,
    why:
      "Same class as $HOME: the path exists on the author's machine and may not " +
      "exist, or may not be writable, on a sandboxed one. `tmpdir()` is the seam " +
      "that is guaranteed writable.",
  },
  {
    what: "a path literal starting at the home directory",
    pattern: /["']~\//,
    why:
      "`~/…` expands against whoever runs the suite, so the path is machine-" +
      "specific by construction. Prose may mention it; a string literal may not.",
  },
  {
    what: "a hard-coded absolute home path (/Users/)",
    pattern: /\/Users\//,
    why:
      "An absolute path from a development machine leaks a username, an OS and a " +
      "directory layout into a public repository, and it is worthless to the " +
      "reader. It is also unrunnable anywhere else.",
  },
  {
    what: "a hard-coded absolute home path (/home/)",
    pattern: /\/home\//,
    why:
      "The Linux half of the same leak. A neutral placeholder or a /tmp path is " +
      "what the test actually means.",
  },
];

/**
 * This file, which necessarily contains the patterns it bans.
 *
 * Exempt by name rather than by assembling the patterns from fragments: a
 * fragment-built rule hides the very text a reader needs to see.
 */
const SELF = "hermetic.test.ts";

/** Every test source, TypeScript and shell alike. */
function testSources(): string[] {
  return [...globSync("test/**/*.ts"), ...globSync("test/**/*.sh")]
    .filter((file) => !file.endsWith(SELF))
    .sort();
}

describe("the suite writes only where the sandbox allows", () => {
  it("scans the sources it claims to scan", () => {
    // A glob that silently matches nothing would make the scan below vacuous,
    // and a vacuous guard is worse than none: it reads as protection.
    const sources = testSources();
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(sources.some((file) => file.endsWith("e2e.test.ts"))).toBe(true);
    expect(sources.some((file) => file.endsWith("build-fixtures.sh"))).toBe(true);
  });

  it("gives every banned pattern a reason", () => {
    // A bare regex is a rule nobody can evaluate or safely remove. The reason is
    // the part that tells the next contributor whether their case is the one it
    // was written for.
    for (const rule of RULES) {
      expect(rule.why.length, rule.what).toBeGreaterThan(40);
    }
  });

  it("contains none of them", () => {
    const offenders: string[] = [];
    for (const file of testSources()) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        for (const rule of RULES) {
          if (rule.pattern.test(line)) offenders.push(`${file}:${index + 1} — ${rule.what}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
