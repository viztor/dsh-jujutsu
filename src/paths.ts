/**
 * The destructive-path predicate: `.jj` and `.git` as *path components*.
 *
 * This is deliberately **not** part of the Git-verb rule. That rule's entire
 * correctness argument is "resolve the invoked *program*, never scan for a
 * token" (`docs/15-verb-mapping.md` §4), and `rm -rf .git` invokes no Git
 * program at all — the resolver correctly reports `programs: ["rm"]` and the
 * verb rule is blind to it by design.
 *
 * The hole is real and unrecoverable (`docs/21-guard-evasion.md` §e):
 *
 * ```
 * $ rm -rf .git            exit 0, no git process
 * $ jj status              Internal error: The repository appears broken
 * $ jj op log              same error
 * $ jj git init --colocate Error: The target repo already exists
 * ```
 *
 * `.jj/repo/` holds the operation store, but the **commit objects live in
 * `.git`**. Deleting it deletes the object store the backend reads, and the
 * recovery command cannot run because the op log is unreadable. In a
 * **non-colocated** repo the same command is a no-op.
 *
 * @module dsh-jujutsu/paths
 */

import { isOp, isWord, type WordToken, tokenize } from "./parse.ts";

export type DestructiveTarget = "git" | "jj" | "unresolvable";

/** Verbs that destroy their path arguments. */
const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set(["rm", "rmdir", "mv", "truncate", "shred"]);

/** Unquoted tokens that separate one command from the next. */
const OPERATORS: ReadonlySet<string> = new Set([";", "&&", "||", "|", "&", "\n"]);

/** The exact components that matter. Never a prefix — see the module doc. */
const TARGETS: Readonly<Record<string, DestructiveTarget>> = {
  ".git": "git",
  ".jj": "jj",
};

/**
 * Does this command destroy a `.git` or `.jj` directory?
 *
 * Triggers on a destructive verb whose path argument names the **exact
 * component** `.git` or `.jj` (a trailing slash is allowed). Never a prefix:
 * `.gitignore`, `.gitattributes`, `.gitkeep` and `.github/` are not targets, and
 * matching them would refuse ordinary work.
 *
 * When a path argument contains an expansion — `rm -rf "$PWD/.git"`,
 * `rm -rf $(jj workspace root)/.git` — the path is **unresolvable**, and the
 * caller must **ask, never allow**. Note the program resolver reports those at
 * *high* confidence, because it judges program resolution, not path resolution;
 * this predicate needs its own resolvability notion.
 *
 * A definite hit outranks an unresolvable one: `rm -rf .git "$OTHER"` is a
 * refusal about `.git`, not a question.
 *
 * @param command - the raw `bash` command text.
 * @returns the targeted component, `'unresolvable'`, or `undefined` to allow.
 */
export function destructiveTargetsVcs(command: string): DestructiveTarget | undefined {
  let unresolvable = false;

  for (const segment of segmentsOf(command)) {
    const head = segment[0]?.value ?? "";
    const isDestructive =
      DESTRUCTIVE_VERBS.has(head) ||
      (head === "find" && segment.some((token) => token.value === "-delete"));
    if (!isDestructive) continue;

    for (const token of segment.slice(1)) {
      if (token.value.startsWith("-")) continue;
      const component = componentOf(token.value);
      if (component === undefined) {
        // An expansion is only *unresolvable* when its literal text still names
        // `.git` or `.jj` somewhere — `rm -rf "$PWD/.git"`,
        // `rm -rf $(jj workspace root)/.git`. An expansion on its own
        // (`rm -rf $BUILD_DIR`) says nothing about version control, and
        // treating it as suspicious refuses ordinary work in every `jj`
        // repository. Measured live: a scratch `rm -rf $R` was refused.
        if (hasExpansion(token.value) && namesVcsComponent(token.value)) {
          unresolvable = true;
        }
        continue;
      }
      return TARGETS[component];
    }
  }

  return unresolvable ? "unresolvable" : undefined;
}

/**
 * The final path component, when it is exactly `.git` or `.jj`.
 *
 * Trailing slashes are stripped, so `rm -rf .git/` triggers while
 * `rm -rf .gitignore` does not.
 */
function componentOf(path: string): string | undefined {
  let trimmed = path;
  while (trimmed.length > 1 && trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  const at = trimmed.lastIndexOf("/");
  const base = at < 0 ? trimmed : trimmed.slice(at + 1);
  return base === ".git" || base === ".jj" ? base : undefined;
}

/**
 * Does this token's path get computed at run time?
 *
 * The tokenizer reports `quoted` but not *which* quote was used, so
 * `rm -rf '$X'` — where the shell would not expand anything — is reported as
 * unresolvable too. That errs toward asking rather than allowing, which is the
 * documented posture.
 */
function hasExpansion(value: string): boolean {
  return value.includes("$") || value.includes("`");
}

/**
 * Does this token name `.git` or `.jj` as a path component, despite an expansion?
 *
 * The check is on components, not substrings, so `$PWD/.gitignore` is not a hit
 * and `$PWD/.git` is. The expansion itself is never resolved — it cannot be —
 * so this asks "could this still be the version-control directory?" rather than
 * "is it?", which is the only question answerable before the command runs.
 */
function namesVcsComponent(value: string): boolean {
  return value.split("/").some((part) => part === ".git" || part === ".jj");
}

/** Split a command into simple-command segments on unquoted shell operators. */
function segmentsOf(command: string): readonly (readonly WordToken[])[] {
  const segments: WordToken[][] = [];
  let current: WordToken[] = [];

  for (const token of tokenize(command)) {
    if (!isWord(token)) {
      if (isOp(token, "\n") || OPERATORS.has(token.op)) {
        if (current.length > 0) segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}
