/**
 * Static analysis: the concrete `jj` command for a refused Git invocation.
 *
 * ## What this module is for
 *
 * The catalogue in `messages.ts` names the replacement for a *shape* of
 * command — `git log` → `jj log`. It cannot name the replacement for the
 * command the model actually typed: `git log --oneline -6` and `git log`
 * are the same shape and different commands, and only one of them can be
 * pasted without editing. This module closes that gap. Given the verb and
 * the arguments as typed, it either produces the exact `jj` command line
 * that means the same thing — flags translated, revisions rewritten,
 * placeholders filled — or it returns `undefined` and the catalogue
 * message stands.
 *
 * The composition lives in {@link refusalReason}: when an equivalent
 * exists, the reason is `Refused: <invocation as typed>. Run: <command>`,
 * which fits the `docs/25` §2 copy-rule-2 budget and needs no reasoning
 * from the model. When it does not, the refusal is the transcribed
 * catalogue string, unchanged.
 *
 * ## Three rules, each with a way to be wrong
 *
 * 1. **A translation is all-or-nothing per command.** Half a translation
 *    is worse than none: a model that pastes `jj log --limit 6` when it
 *    typed `git log --oneline --since=2d` has been actively misled. So a
 *    mutating verb translates only when *every* argument is accounted
 *    for; anything it cannot map exactly yields `undefined`. Read-only
 *    verbs (`log`, `show`, `diff`) are best-effort instead: a flag `jj`
 *    does not have (`--since`, `--author`) is dropped, because broader
 *    output is a surprise and narrower output is a silent lie.
 * 2. **Revisions are rewritten, never passed through.** `git log HEAD~2`
 *    and `jj log HEAD~2` are different commands: `HEAD` is not a `jj`
 *    revset (verified: `Error: Revision 'HEAD' doesn't exist`). Every
 *    revision a translation emits runs through {@link normalizeRev}.
 * 3. **The emitted command must run verbatim.** Translations are built
 *    as argv and quoted once, at the edge, by {@link quoteArg} — which
 *    leaves safe tokens bare and sends everything else to `shellQuote`,
 *    the same quoter `shell.ts` uses to actually run `jj`. A command
 *    that would not survive the shell never reaches the model.
 *
 * What this module deliberately does **not** do: parse the shell. The
 * resolver has already split the command and stripped wrappers; what
 * arrives here is one Git argv. Command substitutions the resolver could
 * not expand make the invocation unanalyzable, and any argv containing
 * one returns `undefined` — a refusal that cannot be translated is a
 * refusal that says so.
 *
 * @module dsh-jujutsu/translate
 */

import { MAX_REASON_CHARS } from "./messages.ts";
import { shellQuote } from "./shell.ts";

/**
 * The refusal reason for a Git invocation, composed.
 *
 * @param source - the Git invocation as typed, including the `git` word
 *   and its quoting, e.g. `git log --oneline -6`.
 * @param equivalent - the concrete `jj` command, when one exists.
 * @param fallback - the catalogue message's `reason`.
 * @returns `Refused: <source>. Run: <equivalent>` when an equivalent
 *   exists and the composition fits the budget; `fallback` otherwise.
 */
export function refusalReason(
  source: string,
  equivalent: string | undefined,
  fallback: string,
): string {
  if (equivalent === undefined || source === "") return fallback;
  const composed = `Refused: ${source}. Run: ${equivalent}`;
  return composed.length <= MAX_REASON_CHARS ? composed : fallback;
}

/**
 * The concrete `jj` command for this Git invocation, or `undefined`.
 *
 * `undefined` means "the catalogue message is the best answer available"
 * — either because no faithful mechanical translation exists for these
 * arguments, or because the invocation contains something static analysis
 * cannot resolve (a command substitution).
 */
export function translateEquivalent(verb: string, args: readonly string[]): string | undefined {
  // A substitution the resolver could not expand means the argv is not
  // what it appears to be. No translation, no guess. The resolver marks
  // what it found as `$(…)`; a `$(` it did not catch is the same hazard.
  if (args.some((arg) => arg.includes("\u0000") || arg.includes("$("))) return undefined;

  // The verbs whose translation is two commands, or a command whose shape
  // depends on arguments in a way argv cannot express. Composed here.
  if (verb === "checkout" || verb === "switch") {
    return verb === "checkout" ? translateCheckout(args) : translateSwitch(args);
  }

  const parts = translateCommand(verb, args);
  return parts === undefined ? undefined : parts.map(quoteArg).join(" ");
}

/**
 * The translated command as argv, unquoted. Every translator returns this
 * shape so {@link translateEquivalent} can quote once at the edge and
 * `translateDashC` can splice one translation inside another. The first
 * element is always `jj`.
 *
 * `checkout` is absent: its translation is two commands, which is not an
 * argv. {@link translateEquivalent} handles it directly.
 */
function translateCommand(verb: string, args: readonly string[]): readonly string[] | undefined {
  switch (verb) {
    case "log":
      return translateLog(args);
    case "status":
      return translateStatus(args);
    case "diff":
      return translateDiff(args);
    case "show":
      return translateShow(args);
    case "blame":
      return translateBlame(args);
    case "branch":
      return translateBranch(args);
    case "tag":
      return translateTag(args);
    case "remote":
      return translateRemote(args);
    case "config":
      return translateConfig(args);
    case "commit":
      return translateCommit(args);
    case "clone":
      return translateClone(args);
    case "fetch":
      return translateFetch(args);
    case "push":
      return translatePush(args);
    case "cherry-pick":
      return translateCherryPick(args);
    case "revert":
      return translateRevert(args);
    case "merge":
      return translateMerge(args);
    case "worktree":
      return translateWorktree(args);
    case "restore":
      return translateRestore(args);
    case "reset":
      return translateReset(args);
    case "stash":
      return translateStash(args);
    case "init":
      return translateInit(args);
    case "-C":
      return translateDashC(args);
    default:
      return undefined;
  }
}

/**
 * Characters that survive a POSIX shell unquoted: letters, digits, and
 * the punctuation that occurs in flags, revsets, and paths. Everything
 * else — spaces, quotes, `*`, `?`, `~`, `$`, `;`, `|`, `&`, `<`, `>`,
 * `(`, `)`, `#` — goes through `shellQuote`.
 *
 * `*` and `?` are excluded because they glob; `~` because it expands at
 * a word start; `$` because it expands everywhere. A `jj` command that
 * the shell rewrites on the way to `jj` is not the command we analyzed.
 */
const SAFE_UNQUOTED = /^[A-Za-z0-9_.,:+\-@/=]+$/;

/** Leave a safe token bare; quote everything else. Verbatim-safe output. */
function quoteArg(arg: string): string {
  return SAFE_UNQUOTED.test(arg) ? arg : shellQuote(arg);
}

/**
 * Rewrite a Git revision as a `jj` revset.
 *
 * `HEAD` → `@`, `HEAD~N` → `@` plus N dashes, `HEAD^` → `@-`. Anything
 * else is rejected **unless it is provably also `jj` revset syntax** —
 * a much smaller set than "looks like a revision".
 *
 * The permissive version of this function was a real defect, and its
 * shape is worth recording because it is the obvious way to write it.
 * `return rev` for the unrecognised case read as "pass a bookmark name
 * through", and it did — but it also passed through every token Git
 * accepts that `jj` does not spell the same way:
 *
 * - `HEAD@{u}` and `@{upstream}`: `jj` rejects both with
 *   `Failed to parse revset: Syntax error`.
 * - `origin/<branch>`: the Git remote-tracking spelling. `jj` spells the
 *   same thing `<branch>@<remote>` and answers
 *   `Revision 'origin/main' doesn't exist`.
 *
 * Those are precisely the tokens a model types after `git fetch`, so the
 * permissive version failed exactly where a translation is most likely to
 * be used. The safe rule is the inverse: a token passes only when it is
 * known-valid `jj` revset syntax, and everything else aborts the
 * translation so the catalogue message answers instead.
 *
 * Aborting is cheap and always correct — the model gets a worse but true
 * message. Emitting is the failure that costs: a command that looks
 * analysed, is pasted, and fails on the user's next call. This module's
 * own header makes that trade explicitly ("all-or-nothing"), and rule 2
 * ("revisions are rewritten, never passed through") is the instance of it.
 */
function normalizeRev(rev: string): string | undefined {
  if (rev === "HEAD") return "@";
  const tilde = /^HEAD~(\d+)$/.exec(rev);
  if (tilde !== null && tilde[1] !== undefined) return "@" + "-".repeat(Number(tilde[1]));
  if (rev === "HEAD^" || rev === "HEAD^1") return "@-";
  if (/^HEAD\^\d+$/.test(rev)) return undefined; // HEAD^2 and beyond: no `jj` spelling

  // A path is not a revset at all. Reaching here means a positional landed in
  // a revision slot, which for `git blame` is expected and handled there.
  if (isFileset(rev)) return undefined;

  // Revset syntax `jj` shares with Git. Each pattern is an *allowance*, so an
  // unrecognised token falls through to the reject rather than out.
  if (CHANGE_ID_RE.test(rev)) return rev; // `jj`'s own stable id: 32 letters k-z
  if (COMMIT_ID_RE.test(rev)) return rev; // any hex, `jj` resolves uniquely
  if (FUNCTIONAL_RE.test(rev)) return rev; // `all()`, `::@`, `@-`-style atoms
  if (SYMBOL_RE.test(rev)) return rev; // a bookmark, or a bare symbol
  return undefined;
}

/**
 * A change ID: `jj`'s own stable identifier, 32 letters from k-z. The one
 * identifier class that survives `jj` rewrites, which is why the tool
 * descriptions tell the model to address revisions by it.
 */
const CHANGE_ID_RE = /^[k-z]{32}$/;

/** A commit ID: hex, any length `jj` accepts (four or more). */
const COMMIT_ID_RE = /^[0-9a-fA-F]{4,}$/;

/**
 * A functional revset atom: `all()`, `::@`, `x|y`, `~@`.
 *
 * These are unambiguously `jj`'s own syntax — a revset expression rather
 * than a name — so a token reaching here that is a well-formed one is safe
 * to pass through untouched. The grammar is kept deliberately tight:
 * optional leading `:`/`~`/`<`/`>` sigils, then a symbol, `@`-form or
 * parenthesised group, then arbitrary revset operators.
 *
 * The `@`-leading forms matter for the *input* side as well as the output.
 * `git restore --source @-` and `git diff @-` are things a user types after
 * reading a `jj` prompt, and `@-` is exactly as valid in a revset as
 * `HEAD~1`. Rejecting them made those translations fall back to the
 * catalogue message, which the suite caught.
 */
const FUNCTIONAL_RE = /^[~<>]*[A-Za-z_@(][A-Za-z0-9_\-.)(@|&+:/\\ -]*$/;
const SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_\-.]*$/;

/**
 * Normalize one positional revision onto `revs`. Returns false when the
 * revision has no `jj` spelling (`HEAD^2`), which aborts the translation
 * rather than emitting a command `jj` will reject.
 */
function pushRev(revs: string[], rev: string): boolean {
  const normalized = normalizeRev(rev);
  if (normalized === undefined) return false;
  revs.push(normalized);
  return true;
}

/**
 * Is this positional a revision or a fileset?
 *
 * `jj log` and `jj diff` take revisions through flags and filesets as
 * positionals, and the two are not interchangeable — but Git spells both
 * the same way and decides at runtime by whether the name resolves.
 * Static analysis has to guess from shape:
 *
 * - **A path** if it contains `/`, or looks like a filename (a dot
 *   followed by a letter-initial extension: `README.md`, `package.json`).
 * - **A revision** otherwise — `main`, `@-`, an abbreviated change ID.
 *
 * The asymmetry is deliberate, because the two wrong guesses fail
 * differently (verified against jj 0.46):
 *
 *     $ jj log -r README.md    Error: Revision `README.md` doesn't exist
 *     $ jj log README.md       Warning: No matching entries for paths
 *                              (…being interpreted as a fileset expression.
 *                               To specify a revset, pass -r "README.md".)
 *
 * A wrong fileset guess produces a warning that names the remedy; a wrong
 * revision guess produces a bare error. So a token that could plausibly be
 * a filename is treated as one. `v1.2.3` stays a revision: its last dot
 * segment does not start with a letter.
 */
function isFileset(token: string): boolean {
  // A remote-tracking ref (`origin/main`) contains a slash but is not a
  // path. Git's remote-tracking form is the one token shaped like a
  // fileset that is unambiguously a revision, and `jj` rejects it:
  // `Revision 'origin/main' doesn't exist`. Letting it through as a
  // fileset produced `jj diff origin/main`, which fails on the model's
  // next call — and it bypassed the revision check entirely, because
  // filesets are not revisions.
  // The test is the *shape of the head*, not the slash. A remote ref's
  // head is one plain name with no dot-extension and nothing after it a
  // path would have (`origin/main`); a path's head is a directory name
  // (`src/main.ts`), an anchor (`./x`, `../x`), or a dotted file.
  // Matching on the slash alone was the first attempt and it was wrong:
  // it swallowed `src/main.ts`, which is a path, and the suite said so.
  if (token.includes("/")) {
    const head = token.slice(0, token.indexOf("/"));
    const rest = token.slice(token.indexOf("/") + 1);
    const plainName = /^[A-Za-z0-9_-]+$/.test(head);
    const oneMoreSegment = /^[A-Za-z0-9_-]+$/.test(rest);
    if (plainName && oneMoreSegment && !head.startsWith(".")) return false;
  }
  if (token.includes("/")) return true;
  return /^[^.]*\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(token);
}

/**
 * Read one value-taking flag at position `i`: either `--flag value` or
 * `--flag=value`. Returns the replacement flag, the value, and the next
 * index — or `undefined` when the flag is not in the table or its value
 * is missing.
 */
function takeValueFlag(
  args: readonly string[],
  i: number,
  table: Readonly<Record<string, string>>,
): { readonly flag: string; readonly value: string; readonly next: number } | undefined {
  const arg = args[i];
  if (arg === undefined) return undefined;
  const eq = /^([^=]+)=(.*)$/.exec(arg);
  if (eq !== null) {
    const flag = eq[1];
    const value = eq[2];
    const mapped = flag === undefined ? undefined : table[flag];
    if (mapped === undefined || value === undefined) return undefined;
    return { flag: mapped, value, next: i + 1 };
  }
  const mapped = table[arg];
  if (mapped === undefined) return undefined;
  const value = args[i + 1];
  if (value === undefined) return undefined;
  return { flag: mapped, value, next: i + 2 };
}

/**
 * The diff-formatting flags `jj log`, `jj show`, and `jj diff` share.
 * `-s` is `--summary` in both; the rest are identical.
 */
const DIFF_FORMAT_FLAGS: Readonly<Record<string, string>> = {
  "--stat": "--stat",
  "--summary": "-s",
  "-s": "-s",
  "--name-only": "--name-only",
  "--types": "--types",
  "--git": "--git",
  "--color-words": "--color-words",
  "--ignore-all-space": "--ignore-all-space",
  "--ignore-space-change": "--ignore-space-change",
};

/** Value-taking flags shared by the diff-formatting verbs. */
const DIFF_VALUE_FLAGS: Readonly<Record<string, string>> = {
  "--context": "--context",
  "--tool": "--tool",
};

/**
 * Value-taking flags the read verbs must recognise but do not translate.
 *
 * This table is not a mapping; it is a **register**. An unknown flag in a
 * read verb is dropped, because dropping a filter produces output that is a
 * superset — a surprise, not a lie. But a flag that *takes a value* cannot
 * simply be dropped: its value is then read as the next positional and
 * parsed as a revision.
 *
 * That was a real defect, and it looked like this:
 *
 *     git log --format=%h %s   →  jj log -r '%s'      (revset syntax error)
 *     git log -T %h            →  jj log -r '%h' -T '%h'
 *     git diff --no-index a b  →  jj diff --from a --to b   (paths, not revs)
 *
 * Each emitted a command that fails, which is the failure this module
 * exists to prevent. Listing the value-taking flags here means the drop
 * consumes the value with it, and the translation stays a `jj` command
 * that runs — it just ignores the filter, which the read-only best-effort
 * rule already accepts.
 *
 * `-T` is listed for a second reason: it is *`jj`'s own* template flag, so a
 * dropped `-T` also collides with what the translator emits.
 */
const UNTRANSLATED_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--format",
  "-T",
  "--since",
  "--until",
  "--after",
  "--before",
  "--author",
  "--committer",
  "--grep",
  "--ignore-rev",
  "--no-index",
  "--unified",
  "-U",
  "--word-diff",
  "-O",
  "--output",
  "--date-order",
  "--decorate",
  "-S",
  "-G",
  "--relative",
]);

/**
 * Flag pairs `jj` refuses to take together.
 *
 * `jj log --no-graph --graph` exits 2 (`unexpected argument '--graph'`);
 * `jj log --no-graph --count` exits 2 (the two "cannot be used together").
 * Git accepts every combination of the same flags, so a per-flag mapping
 * table that knows nothing about `jj`'s own exclusions will happily build
 * all four: `git log --oneline --graph` → `jj log -r ::@ --no-graph --graph`.
 *
 * Those are the two most natural "show me history" forms a model types, so
 * the collision was not an obscure edge — it was the common case. Rather
 * than teach every table about every exclusion, the *emitted* argv is
 * checked once here, and the translation refuses when it would be illegal.
 *
 * A refusal is correct: the model gets the catalogue message, which is
 * true, instead of a replacement that fails on the next call.
 */
const MUTUALLY_EXCLUSIVE: readonly (readonly [string, string])[] = [
  ["--graph", "--no-graph"],
  ["--no-graph", "--count"],
  ["--graph", "--count"],
];

/**
 * Would `jj` refuse this argv because two flags in it are exclusive?
 *
 * Checked against the translated argv, not the Git one, because it is
 * `jj`'s exclusions that matter and only the translated argv has `jj`'s
 * flag names.
 */
function hasExclusiveConflict(argv: readonly string[]): boolean {
  for (const [left, right] of MUTUALLY_EXCLUSIVE) {
    if (argv.includes(left) && argv.includes(right)) return true;
  }
  return false;
}

/**
 * Walk a diff-format argv, pushing mapped flags onto `out` in order.
 *
 * Unknown flags are dropped — these verbs are read-only, and the
 * alternative (refusing to translate) leaves the model with the generic
 * message this module exists to replace. `--` is left for the caller,
 * which decides what it separates.
 */
function walkDiffFormat(
  args: readonly string[],
  out: string[],
  extra: Readonly<Record<string, string>>,
  extraValues: Readonly<Record<string, string>>,
): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined || arg === "--") return;
    const mapped = extra[arg] ?? DIFF_FORMAT_FLAGS[arg];
    if (mapped !== undefined) {
      out.push(mapped);
      continue;
    }
    const taken = takeValueFlag(args, i, extraValues) ?? takeValueFlag(args, i, DIFF_VALUE_FLAGS);
    if (taken !== undefined) {
      out.push(taken.flag, taken.value);
      i = taken.next - 1;
      continue;
    }
    const eq = /^([^=]+)=(.*)$/.exec(arg);
    if (eq !== null) {
      const flag = eq[1];
      const value = eq[2];
      if (flag === undefined || value === undefined) return;
      const valueEq = extraValues[flag] ?? DIFF_VALUE_FLAGS[flag];
      if (valueEq !== undefined) {
        out.push(valueEq, value);
        continue;
      }
      const boolEq = extra[flag] ?? DIFF_FORMAT_FLAGS[flag];
      if (boolEq !== undefined) {
        out.push(boolEq);
        continue;
      }
    }
    // Unknown flag: dropped, per the read-only best-effort rule.
  }
}

/**
 * Consume a flag that is neither translated nor understood, for the
 * read-only best-effort rule.
 *
 * Two callers matter — {@link translateLog}, {@link translateDiff} and
 * {@link translateShow} — and they must use this rather than a bare
 * `continue`, because a bare drop is not neutral when the flag takes a
 * value. The value then sits in argv looking like a positional, and the
 * revision parser accepts it: `git log --grep fix` became
 * `jj log -r fix`. {@link UNTRANSLATED_VALUE_FLAGS} is the register that
 * makes the drop safe.
 *
 * `i` is passed by value and the advanced index returned, so the caller's
 * loop stays a `for` with a plain skip. The function is total: it always
 * says "not a flag" rather than refusing, because the caller's next test
 * decides what a non-flag positional means.
 *
 * It takes the position rather than `args` because nothing beyond `i` is
 * needed: an inline `--flag=value` carries its own value, and a separate
 * value is the token at `i + 1` that the caller's loop will skip next.
 */
function skipUnknownFlag(arg: string, i: number): { readonly next: number } {
  if (!arg.startsWith("-")) return { next: i };
  // A diff-format flag that *is* translated elsewhere (`--stat` → `--stat`)
  // still takes no value, so it needs no registration. Only the untranslated
  // value-takers must be consumed with their value.
  const eq = arg.indexOf("=");
  const name = eq === -1 ? arg : arg.slice(0, eq);
  const table = DIFF_VALUE_FLAGS[name];
  if (table === undefined && !UNTRANSLATED_VALUE_FLAGS.has(name)) return { next: i };
  if (eq !== -1) return { next: i };
  return { next: i + 1 };
}

/**
 * `git log` → `jj log`.
 *
 * `--oneline` becomes `--no-graph` (one revision per line, which is what
 * `--oneline` means); a count (`-6`, `-n 6`, `--max-count=6`) becomes
 * `--limit`; a revision the user named is passed through `-r`, and when
 * they named none the default is `-r ::@` — `jj log` with no revision
 * shows the configured `revsets.log`, which in a repository with
 * bookmarks is *not* the ancestry `git log` walks from HEAD.
 */
function translateLog(args: readonly string[]): readonly string[] | undefined {
  const out = ["jj", "log"];
  const revs: string[] = [];
  const filesets: string[] = [];
  let limit: string | undefined;
  let sawRev = false;
  let afterDashDash = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return undefined;
    if (afterDashDash) {
      filesets.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashDash = true;
      continue;
    }
    if (arg === "-n" || arg === "--max-count") {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      limit = value;
      i += 1;
      continue;
    }
    if (/^--max-count=\d+$/.test(arg)) {
      limit = arg.slice("--max-count=".length);
      continue;
    }
    const bareCount = /^-(\d+)$/.exec(arg);
    if (bareCount !== null) {
      limit = bareCount[1];
      continue;
    }
    if (arg === "--all") {
      revs.push("all()");
      sawRev = true;
      continue;
    }
    if (arg.startsWith("-")) {
      // Diff-format flags are mapped by walkDiffFormat below; anything else
      // is dropped (read-only best effort), and `skipUnknownFlag` is what
      // makes the drop safe — it takes the flag's value with it, so the
      // value cannot be read as a revision.
      i = skipUnknownFlag(arg, i).next;
      continue;
    }
    if (arg.includes(":")) return undefined; // `rev:path` is a file, not a revision
    if (isFileset(arg)) {
      filesets.push(arg);
      continue;
    }
    if (!pushRev(revs, arg)) return undefined;
    sawRev = true;
  }

  if (revs.length === 0 && !sawRev) revs.push("::@");
  if (revs.length > 0) out.push("-r", revs.join(" | "));
  if (limit !== undefined) out.push("--limit", limit);
  const flags: string[] = [];
  walkDiffFormat(
    args,
    flags,
    {
      "--oneline": "--no-graph",
      "--patch": "-p",
      "--graph": "--graph",
      "--reversed": "--reversed",
      "--count": "--count",
    },
    // **No `-T` entry, deliberately.** `-T` is `jj`'s own template flag, and
    // passing it through here used to re-emit the very flag the loop above
    // dropped: `git log -T %h` produced `jj log -r '%h' -T '%h'`, which both
    // collided with the translator's own `-T` and resurrected a value the
    // flag-thief fix had already removed. A translated command must not
    // carry an argument the analysis decided to ignore, and must not carry
    // two flags `jj` refuses together — `--oneline --graph` maps to
    // `--no-graph --graph`, which exits 2.
    {},
  );
  out.push(...flags, ...filesets);
  // Checked on the finished argv, not on the collected flags: the flags are
  // pushed onto `out` by this same statement, so checking before it inspects
  // a prefix that never contains the conflict.
  if (hasExclusiveConflict(out)) return undefined;
  return out;
}

/**
 * `git status` → `jj status`.
 *
 * `jj status` has no porcelain mode and no short form, so any flag makes
 * the translation unfaithful and yields `undefined`; bare paths pass
 * through as the filesets `jj status` takes.
 */
function translateStatus(args: readonly string[]): readonly string[] | undefined {
  const out = ["jj", "status"];
  for (const arg of args) {
    if (arg.startsWith("-")) return undefined;
    out.push(arg);
  }
  return out;
}

/**
 * `git diff` → `jj diff`.
 *
 * One positional compares it to the working copy (`--from <rev>`), two
 * compare to each other (`--from A --to B`), and a `A..B` range is the
 * same comparison in Git's spelling. `--staged` has no equivalent — `jj`
 * has no index to diff against — and refuses the translation rather than
 * emitting a command that answers a different question.
 */
function translateDiff(args: readonly string[]): readonly string[] | undefined {
  const out = ["jj", "diff"];
  const revs: string[] = [];
  const filesets: string[] = [];
  let afterDashDash = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return undefined;
    if (afterDashDash) {
      filesets.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashDash = true;
      continue;
    }
    if (arg === "--staged" || arg === "--cached") return undefined;
    // `--no-index` diffed two *paths*, not two revisions: there is nothing in
    // `jj` that means it, and the "broaden the output" best-effort rule
    // cannot widen a command whose arguments were files. Being in
    // UNTRANSLATED_VALUE_FLAGS only stops the value being read as a rev;
    // the verb still has to refuse the whole form.
    if (arg === "--no-index") return undefined;
    if (arg.startsWith("-")) {
      // Diff-format flags are mapped by walkDiffFormat below; anything else
      // is dropped (read-only best effort), and `skipUnknownFlag` is what
      // makes the drop safe — it takes the flag's value with it, so the
      // value cannot be read as a revision.
      i = skipUnknownFlag(arg, i).next;
      continue;
    }
    if (arg.includes(":")) return undefined;
    if (arg.includes("...")) return undefined; // merge-base diff has no spelling
    if (arg.includes("..")) {
      const [from, to] = arg.split("..");
      if (from === undefined || to === undefined || from === "" || to === "") return undefined;
      if (!pushRev(revs, from) || !pushRev(revs, to)) return undefined;
      continue;
    }
    if (isFileset(arg)) filesets.push(arg);
    else if (!pushRev(revs, arg)) return undefined;
  }

  if (revs.length > 2) return undefined;
  if (revs.length === 2) {
    const [from, to] = revs;
    if (from === undefined || to === undefined) return undefined;
    out.push("--from", from, "--to", to);
  } else if (revs.length === 1) {
    const [from] = revs;
    if (from === undefined) return undefined;
    out.push("--from", from);
  }
  if (filesets.length > 1) return undefined;
  const flags: string[] = [];
  walkDiffFormat(args, flags, {}, {});
  out.push(...flags, ...filesets);
  return out;
}

/**
 * `git show` → `jj show`.
 *
 * `jj show` takes revisions as positionals and defaults to `@`, so the
 * translation is direct — after the revisions pass through
 * {@link normalizeRev}, since `HEAD~2` is not a `jj` revset.
 */
function translateShow(args: readonly string[]): readonly string[] | undefined {
  const out = ["jj", "show"];
  const revs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return undefined;
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      // Dropped, read-only best effort — but `skipUnknownFlag` carries the
      // value with it, so `git show --format=x` cannot leave `x` behind
      // for the revision parser.
      i = skipUnknownFlag(arg, i).next;
      continue;
    }
    if (arg.includes(":")) return undefined; // `rev:path` is a file, not a revision
    if (!pushRev(revs, arg)) return undefined;
  }
  out.push(...revs);
  return out;
}

/**
 * Could this bare token be Git's optional revision rather than a path?
 *
 * The inverse question to {@link isFileset}, and it exists only for
 * `git blame`, where a leading revision is the one case a token's *meaning*
 * has to be guessed from shape. A path is a path; a `HEAD`-form, a
 * remote-tracking ref, or a name with no dot-extensions is a revision.
 *
 * Returning `true` means "drop it" rather than "emit it", so a wrong guess
 * loses the revision — the same best-effort widening a read-only verb
 * already accepts — while a wrong guess the other way would emit a command
 * `jj` rejects.
 */
function isRevisionShaped(token: string): boolean {
  if (isFileset(token)) return false;
  if (token === "HEAD" || token.startsWith("HEAD^") || /^HEAD~\d+$/.test(token)) return true;
  if (/^@\{[^}]*\}$/.test(token)) return true;
  if (/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-./]+$/.test(token)) return true; // origin/main
  return !token.includes(".");
}

/**
 * `git blame <path>` → `jj file annotate <path>`.
 *
 * `jj file annotate` takes **one path and nothing else**. Git's `blame`
 * takes an optional revision first — `git blame HEAD a.txt` — and a
 * revision is not dropped silently: passing it through produced
 * `jj file annotate HEAD a.txt`, which `jj` rejects with
 * `error: unexpected argument 'a.txt' found`. So exactly one positional
 * may remain, and it must be a path.
 */
function translateBlame(args: readonly string[]): readonly string[] | undefined {
  const paths: string[] = [];
  let sawDashDash = false;
  for (const arg of args) {
    if (arg === "--") {
      sawDashDash = true;
      continue;
    }
    if (arg.startsWith("-")) return undefined;
    if (sawDashDash || !isRevisionShaped(arg)) {
      paths.push(arg);
      continue;
    }
    // A bare token that looks like a revision is Git's optional `<rev>`.
    // `jj` has no place to put it, and `git blame HEAD` means the current
    // change anyway, so it is dropped rather than refused.
  }
  if (paths.length !== 1) return undefined;
  return ["jj", "file", "annotate", paths[0] ?? ""];
}

/**
 * `git branch` → the `jj bookmark` family.
 *
 * Every argument must be accounted for: a branch name becomes the
 * bookmark's name, and `branch <name>` (Git's create-at-current-HEAD)
 * becomes `bookmark create <name> -r @` because a new bookmark in `jj`
 * needs an explicit target.
 */
function translateBranch(args: readonly string[]): readonly string[] | undefined {
  if (args.length === 0) return ["jj", "bookmark", "list"];
  const [first, ...rest] = args;
  if (first === undefined) return undefined;
  if ((first === "-a" || first === "--all") && rest.length === 0) {
    return ["jj", "bookmark", "list", "--all-remotes"];
  }
  if (
    (first === "-v" || first === "--verbose" || first === "-l" || first === "--list") &&
    rest.length === 0
  ) {
    return ["jj", "bookmark", "list"];
  }
  if (first === "-d" && rest.length > 0) {
    return ["jj", "bookmark", "delete", ...rest];
  }
  if (first.startsWith("-")) return undefined;
  if (rest.length !== 0) return undefined;
  return ["jj", "bookmark", "create", first, "-r", "@"];
}

/**
 * `git tag` → `jj tag list`.
 *
 * The listing form only; `jj tag list` takes an optional glob, so
 * `git tag -l 'v*'` translates and `git tag -n` (annotate lines) does not.
 */
function translateTag(args: readonly string[]): readonly string[] | undefined {
  if (args.length === 0) return ["jj", "tag", "list"];
  const [first, ...rest] = args;
  if (first === undefined) return undefined;
  if ((first === "-l" || first === "--list") && rest.length <= 1) {
    return ["jj", "tag", "list", ...rest];
  }
  return undefined;
}

/**
 * `git remote` → the `jj git remote` family.
 *
 * The subcommands `jj git remote` has, translated one-to-one.
 * `get-url` has no `jj` equivalent and stays on the catalogue message.
 */
function translateRemote(args: readonly string[]): readonly string[] | undefined {
  const [sub, ...rest] = args;
  if (sub === undefined) return undefined;
  if ((sub === "-v" || sub === "--verbose") && rest.length === 0) {
    return ["jj", "git", "remote", "list"];
  }
  const verbs: Readonly<Record<string, string>> = {
    add: "add",
    "set-url": "set-url",
    rename: "rename",
    remove: "remove",
  };
  const mapped = verbs[sub];
  if (mapped === undefined) return undefined;
  if (rest.length !== 2) return undefined;
  const [a, b] = rest;
  if (a === undefined || b === undefined) return undefined;
  return ["jj", "git", "remote", mapped, a, b];
}

/**
 * `git config` → `jj config list`.
 *
 * The read-only forms. A write (`git config user.name X`) is a silent
 * no-op for `jj` — it reads identity from its own config — so it stays
 * on the catalogue message rather than translating to a command that
 * appears to work.
 */
function translateConfig(args: readonly string[]): readonly string[] | undefined {
  if (args.length === 0) return ["jj", "config", "list"];
  const [first, ...rest] = args;
  if (first === undefined) return undefined;
  if ((first === "--get" || first === "--get-all") && rest.length === 1) {
    const [key] = rest;
    if (key === undefined) return undefined;
    return ["jj", "config", "list", key];
  }
  if ((first === "--list" || first === "-l") && rest.length === 0) {
    return ["jj", "config", "list"];
  }
  return undefined;
}

/**
 * `git commit -m <msg>` → `jj commit -m <msg>`.
 *
 * The one translation that carries user text, so the message is the one
 * argument that must be quoted for the shell — a denial the model pastes
 * must survive the paste. Everything else about `git commit` (bare,
 * `--amend`, `--file`) stays on the catalogue message.
 */
function translateCommit(args: readonly string[]): readonly string[] | undefined {
  if (args.length !== 2) return undefined;
  const [flag, message] = args;
  if (flag === undefined || message === undefined) return undefined;
  if (flag !== "-m") return undefined;
  // The one translation that carries free text must defend that text
  // against looking like a flag. `git commit -m --` is a legal (if odd)
  // invocation — the message is the two characters `--` — and the obvious
  // translation `jj commit -m --` exits 2 with "a value is required for
  // '--message <MESSAGE>' but none was supplied". Same for `git commit -m -x`.
  //
  // The catalogue message is the honest answer here, and there is nothing
  // surprising about needing it: a message that is exactly a flag is not a
  // message a model is trying to send.
  if (message.startsWith("-")) return undefined;
  return ["jj", "commit", "-m", message];
}

/**
 * `git clone <url> [<dir>]` → `jj git clone <url> [<dir>]`.
 *
 * The flags `jj git clone` shares with Git (`--colocate`, `--no-colocate`,
 * `--remote`) pass through; anything else refuses the translation,
 * because a clone flag that changes *what* is cloned must not be dropped
 * from a command the model is told is equivalent.
 */
function translateClone(args: readonly string[]): readonly string[] | undefined {
  const out = ["jj", "git", "clone"];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return undefined;
    if (arg === "--colocate" || arg === "--no-colocate") {
      out.push(arg);
      continue;
    }
    if (arg === "--remote") {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      out.push(arg, value);
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) return undefined;
    positionals.push(arg);
  }
  if (positionals.length === 0 || positionals.length > 2) return undefined;
  out.push(...positionals);
  return out;
}

/**
 * `git fetch` → `jj git fetch`.
 *
 * The bare form, `--remote <name>`, `--all-remotes`, and a single remote
 * positional (`git fetch origin` → `jj git fetch --remote origin`).
 * Refspecs and `--prune` have no `jj` equivalent.
 */
function translateFetch(args: readonly string[]): readonly string[] | undefined {
  if (args.length === 0) return ["jj", "git", "fetch"];
  const [first, ...rest] = args;
  if (first === undefined) return undefined;
  if (first === "--all-remotes" && rest.length === 0) {
    return ["jj", "git", "fetch", "--all-remotes"];
  }
  if (first === "--remote" && rest.length === 1) {
    const [remote] = rest;
    if (remote === undefined) return undefined;
    return ["jj", "git", "fetch", "--remote", remote];
  }
  if (!first.startsWith("-") && rest.length === 0) {
    return ["jj", "git", "fetch", "--remote", first];
  }
  return undefined;
}

/**
 * `git push` → `jj git push`.
 *
 * `jj git push` is already force-with-lease, so `--force` is dropped
 * (the catalogue message says why). `git push origin main` names both
 * the remote and the bookmark, which `jj` needs as `--remote`/`--bookmark`;
 * a refspec (`main:feat`) has no single-flag spelling and refuses.
 */
function translatePush(args: readonly string[]): readonly string[] | undefined {
  const out = ["jj", "git", "push"];
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") continue;
    if (arg === "--all" && positionals.length === 0) {
      out.push("--all");
      continue;
    }
    if (arg.startsWith("-")) return undefined;
    positionals.push(arg);
  }
  if (positionals.length === 1) return undefined; // `git push origin` is not a bookmark push
  if (positionals.length === 2) {
    const [remote, ref] = positionals;
    if (remote === undefined || ref === undefined) return undefined;
    if (ref.includes(":")) return undefined;
    out.push("--remote", remote, "--bookmark", ref);
    return out;
  }
  if (positionals.length > 2) return undefined;
  if (!out.includes("--all")) return undefined;
  return out;
}

/**
 * Does this argv hold exactly one positional, with no flags at all?
 *
 * Four mutating translators (`cherry-pick`, `revert`, `merge`, `squash`)
 * documented "flags refuse the translation" and then only checked the
 * length — so `git cherry-pick -n <rev>` (one argument, a flag) was emitted
 * as `jj duplicate -n -o @`, and `git merge --abort` (one argument, a flag)
 * as `jj new @ --abort`. Both are commands `jj` rejects: `error: unexpected
 * argument '-n' found`.
 *
 * The asymmetry that makes this worth a guard rather than a comment is in
 * the header's own rule 1: a mutating verb translates only when *every*
 * argument is accounted for. An unaccounted flag is a refusal, and on a
 * verb that rewrites history that refusal is the safe answer.
 */
function soleRevision(args: readonly string[]): { readonly rev: string } | undefined {
  if (args.length !== 1) return undefined;
  const [rev] = args;
  if (rev === undefined) return undefined;
  if (rev.startsWith("-")) return undefined;
  return { rev };
}

/**
 * `git cherry-pick <rev>` → `jj duplicate <rev> -o @`.
 *
 * The single-revision form. Flags (`-n`, `-x`, `--no-commit`) change what
 * the command does and refuse the translation.
 */
function translateCherryPick(args: readonly string[]): readonly string[] | undefined {
  const only = soleRevision(args);
  if (only === undefined) return undefined;
  return ["jj", "duplicate", only.rev, "-o", "@"];
}

/**
 * `git revert <rev>` → `jj revert -r <rev> -B @`.
 *
 * The single-revision form, inserted before the working copy.
 */
function translateRevert(args: readonly string[]): readonly string[] | undefined {
  const only = soleRevision(args);
  if (only === undefined) return undefined;
  return ["jj", "revert", "-r", only.rev, "-B", "@"];
}

/**
 * `git merge <rev>` → `jj new @ <rev>`.
 *
 * A merge is a change with two parents; the working copy is one of them.
 */
function translateMerge(args: readonly string[]): readonly string[] | undefined {
  const only = soleRevision(args);
  if (only === undefined) return undefined;
  return ["jj", "new", "@", only.rev];
}

/**
 * `git checkout` → one of three things, because Git's `checkout` is three
 * commands wearing one name.
 *
 * - `checkout -- <paths>` restores paths → `jj restore <paths>`.
 * - `checkout -b <name>` starts a branch → two commands, see
 *   {@link translateCheckoutBranch}.
 * - `checkout <rev>` moves the working tree → `jj new <rev>`, the `jj`
 *   idiom for starting work on top of a revision.
 *
 * Only the `--` form can be told from a revision unambiguously: Git itself
 * errors on `git checkout foo` when `foo` is both. Where the heuristic in
 * {@link isFileset} cannot decide, the translation is withheld.
 */
function translateCheckout(args: readonly string[]): string | undefined {
  if (args[0] === "-b" || args[0] === "-B") return translateCheckoutBranch(args);
  const dashDash = args.indexOf("--");
  if (dashDash !== -1) {
    const paths = args.slice(dashDash + 1);
    if (paths.length === 0) return undefined;
    if (args.slice(0, dashDash).length > 0) return undefined; // `checkout <rev> -- <paths>`
    // A path after `--` that begins with `-` is still refused. The user can
    // name such a file (`git checkout -- -x` is legal), but the emitted
    // command would be `jj restore -x`, and `jj` re-parses a bare positional
    // as a flag: `error: unexpected argument '-x' found`. `quoteArg` is right
    // to leave `-` alone — flags are spelled that way — so the only way to
    // keep the "must run verbatim" promise is to not emit it.
    if (paths.some((path) => path.startsWith("-"))) return undefined;
    return `jj restore ${paths.map(quoteArg).join(" ")}`;
  }
  if (args.length !== 1) return undefined;
  const [rev] = args;
  if (rev === undefined || rev.startsWith("-") || isFileset(rev)) return undefined;
  const normalized = normalizeRev(rev);
  if (normalized === undefined) return undefined;
  return `jj new ${quoteArg(normalized)}`;
}

/**
 * `git checkout -b <name>` → `jj new` + `jj bookmark create <name> -r @-`.
 *
 * Two commands, because `jj` has no branch-switch step: `jj new` starts
 * the change and the bookmark is created on the commit it started from.
 * A start revision (`git checkout -b feat main`) is passed to `jj new`.
 *
 * Returns the finished text rather than argv: the two-command form cannot
 * be a `jj` argv, and `-R` cannot span both commands, so this is the one
 * translation that is never nestable — see {@link translateEquivalent}.
 */
function translateCheckoutBranch(args: readonly string[]): string | undefined {
  const name = args[1];
  const start = args[2];
  if (name === undefined || name.startsWith("-")) return undefined;
  if (args.length > 3) return undefined;
  const bookmark = `jj bookmark create ${quoteArg(name)} -r @-`;
  // Joined with `&&`, not described in prose: the point of this module is a
  // command the model can run as typed, and "jj new, then jj bookmark create"
  // is a sentence the model has to take apart before pasting.
  if (start === undefined) return `jj new && ${bookmark}`;
  if (start.startsWith("-")) return undefined;
  const normalized = normalizeRev(start);
  if (normalized === undefined) return undefined;
  return `jj new ${quoteArg(normalized)} && ${bookmark}`;
}

/**
 * `git switch <rev>` → `jj new <rev>`, and `switch -c <name>` → the same
 * two-command form as `checkout -b`.
 *
 * `switch` is `checkout` without the path mode, so it inherits the same
 * reasoning. `switch -` (the previous branch) has no `jj` spelling and is
 * withheld.
 */
function translateSwitch(args: readonly string[]): string | undefined {
  if (args[0] === "-c" || args[0] === "-C") {
    return translateCheckoutBranch(["-b", ...args.slice(1)]);
  }
  if (args.length !== 1) return undefined;
  const [rev] = args;
  if (rev === undefined || rev.startsWith("-")) return undefined;
  if (isFileset(rev)) return undefined;
  const normalized = normalizeRev(rev);
  if (normalized === undefined) return undefined;
  return `jj new ${quoteArg(normalized)}`;
}

/**
 * `git worktree add <path>` → `jj workspace add <path>`.
 *
 * The destination-only form. The flags Git and `jj` share for this
 * command do not overlap (`-b`, `--detach` vs `--name`, `-r`), so any
 * flag refuses the translation.
 */
function translateWorktree(args: readonly string[]): readonly string[] | undefined {
  if (args[0] !== "add") return undefined;
  const [path] = args.slice(1);
  if (path === undefined || path.startsWith("-")) return undefined;
  if (args.length > 2) return undefined;
  return ["jj", "workspace", "add", path];
}

/**
 * `git restore <paths>` → `jj restore <paths>`.
 *
 * `--source <rev>` becomes `--from <rev>`; `--staged` has no equivalent
 * (no index) and refuses the translation rather than emitting a restore
 * that reads from the parent.
 *
 * A path that begins with `-` is refused rather than emitted, even though
 * the user *can* disambiguate it with `--`. `quoteArg` leaves `-x` bare
 * (the SAFE set admits a leading dash, correctly — it is how flags are
 * spelled), but `jj` re-parses a bare positional as a flag and answers
 * `error: unexpected argument '-x' found`. So the emitted command would
 * not run, which is the one property this module promises.
 */
function translateRestore(args: readonly string[]): readonly string[] | undefined {
  const out = ["jj", "restore"];
  const paths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return undefined;
    if (arg === "--source" || arg === "-s") {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      const normalized = normalizeRev(value);
      if (normalized === undefined) return undefined;
      out.push("--from", normalized);
      i += 1;
      continue;
    }
    if (arg === "--") continue; // the separator itself is not a path
    if (arg.startsWith("-")) return undefined;
    paths.push(arg);
  }
  if (paths.length === 0) return undefined;
  out.push(...paths);
  return out;
}

/**
 * `git reset --soft <rev>` → `jj squash --from <rev>`.
 *
 * Folding the parent's diff into the working copy is the `jj` move for
 * "uncommit, keep the changes". `--hard`, `--mixed` and the bare form all
 * refuse — the bare form for a reason the first version got backwards.
 *
 * `git reset --soft` with no revision is a **no-op** in Git: `HEAD` already
 * names `HEAD`, so there is nothing to move. The obvious translation was
 * `jj squash --from @-`, which folds the parent's diff into the working
 * copy — a history-rewriting command handed back for a setup step that
 * changes nothing. Verified in a real repository: the parent's change
 * collapsed into `@`. `--soft HEAD` was worse, emitting
 * `jj squash --from @`, which folds the working copy into itself and fails.
 *
 * `jj squash --from <rev>` is the equivalent only when `<rev>` names a
 * *different* commit the changes are being un-committed *to*, and the one
 * such form `docs/15` §1 settles is `git reset --soft HEAD~1`. So the
 * stand-in for a no-op is the refuse.
 */
function translateReset(args: readonly string[]): readonly string[] | undefined {
  if (args[0] !== "--soft") return undefined;
  if (args.length !== 2) return undefined;
  const [rev] = args.slice(1);
  if (rev === undefined) return undefined;
  if (rev.startsWith("-")) return undefined;
  // A target that is the working copy itself is not an un-commit. It folds
  // the working copy into itself (`jj squash --from @` exits 1 on the git
  // backend) and in Git it is what makes the bare form a no-op, so it is
  // the other half of the refusal above.
  if (rev === "HEAD" || rev === "@") return undefined;
  const normalized = normalizeRev(rev);
  if (normalized === undefined) return undefined;
  return ["jj", "squash", "--from", normalized];
}

/**
 * `git stash` → `jj new @-`.
 *
 * The bare form only. `jj` has no stash to list or pop, so the catalogue
 * message carries those forms.
 */
function translateStash(args: readonly string[]): readonly string[] | undefined {
  if (args.length !== 0) return undefined;
  return ["jj", "new", "@-"];
}

/**
 * `git init [<dir>]` → `jj git init [<dir>]`.
 *
 * Colocated by default, which is what the catalogue message says.
 */
function translateInit(args: readonly string[]): readonly string[] | undefined {
  // The bare form is withheld on purpose. The guard only ever fires inside a
  // working `jj` workspace, where `jj git init` answers
  // `Error: The target repo already exists` — so the honest answer is the
  // catalogue message ("there is nothing to initialise"), not a command that
  // cannot work. A destination argument is the real use case and translates.
  if (args.length === 0) return undefined;
  if (args.length === 1) {
    const [dir] = args;
    if (dir === undefined || dir.startsWith("-")) return undefined;
    return ["jj", "git", "init", dir];
  }
  return undefined;
}

/**
 * `git -C <dir> <sub>…` → `jj -R <dir> <sub>…`.
 *
 * `-R` is `jj`'s `-C`, and the subcommand is translated too — `git -C dir
 * log --oneline -3` becomes `jj -R dir log -r ::@ --limit 3 --no-graph`,
 * not a `jj log` that still speaks Git. When the subcommand has no
 * translation, this returns `undefined` rather than passing Git flags
 * through: `jj -R dir status --porcelain` is not a command, and emitting
 * it would be the half-translation rule 1 exists to prevent.
 */
function translateDashC(args: readonly string[]): readonly string[] | undefined {
  const [dir, sub, ...rest] = args;
  if (dir === undefined || dir.startsWith("-")) return undefined;
  if (sub === undefined) return undefined;
  const nested = translateCommand(sub, rest);
  if (nested === undefined || nested[0] !== "jj") return undefined;
  return ["jj", "-R", dir, ...nested.slice(1)];
}
