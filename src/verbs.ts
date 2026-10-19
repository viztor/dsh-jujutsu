/**
 * Turning a parsed invocation into a decision.
 *
 * The messages live in `messages.ts` (transcribed from `docs/25` §2); the rows
 * are the 46-row table from `docs/15` §1. This module is the matching and the
 * read-only logic, and it deliberately holds **no policy**: it says *what* the
 * command is, and `guard.ts` decides what to do about it. That split is what
 * makes the read-only posture (`readOnlyGit`) and the general bypass (`bypass`)
 * independently testable.
 *
 * ## Three properties, each of which has a way to be wrong
 *
 * 1. **First match wins.** `VERB_ROWS` is ordered specific-first within a family
 *    — `["commit","--amend"]` before `["commit","-m"]` before `["commit"]` — so
 *    the first matching row is the most specific one.
 * 2. **An unmatched `git` form is still a refusal.** Falling through to `allow`
 *    because a subcommand is unrecognised would make the whole guard bypassable
 *    by inventing a verb (`docs/14-decision-log.md` §R3–R5).
 * 3. **Flags win over the verb.** `branch` is read-only only in its listing form;
 *    `branch -d feat` mutates, and `readOnlyGit: 'allow'` must not open that hole
 *    (§R6). Anything not positively identified as a listing form is treated as
 *    mutating.
 *
 * @module dsh-jujutsu/verbs
 */

import {
  type Classification,
  GENERIC_FALLBACK,
  LISTING_FORMS,
  type Message,
  READ_ONLY_VERBS,
  VERB_ROWS,
} from "./messages.ts";
import { type Invocation, isWord, tokenize } from "./parse.ts";
import { translateEquivalent } from "./translate.ts";

/**
 * Verbs that are read-only in *every* form.
 *
 * Deliberately separate from `READ_ONLY_VERBS` in `messages.ts`, which holds only
 * the verbs whose read-only-ness depends on their arguments. These need no form
 * check: `git log` has no mutating variant.
 */
const ALWAYS_READ_ONLY: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "describe",
]);

export interface Refusal {
  readonly kind: "refuse";
  /** The Git subcommand, for logging and for the explanation channel. */
  readonly verb: string;
  readonly classification: Classification;
  readonly message: Message;
  /** True when the command only reads. Drives which config posture applies. */
  readonly readOnly: boolean;
  /**
   * The concrete `jj` command for the arguments as typed, when static
   * analysis found a faithful one (`translate.ts`). Absent means the
   * catalogue message is the answer.
   */
  readonly equivalent?: string;
  /** The Git arguments as typed, e.g. `log --oneline -6`. Composes the reason. */
  readonly source?: string;
}

export type Decision = { readonly kind: "allow" } | Refusal;

/**
 * Decide what a command that invokes Git actually is.
 *
 * @param invocation - the parsed invocation. A non-Git one returns `allow`.
 * @returns a refusal carrying the message and the read-only flag, or `allow`.
 */
export function classifyGitInvocation(invocation: Invocation): Decision {
  if (invocation.gitInvocations.length === 0) return { kind: "allow" };

  // One refusal is enough. A command that runs Git twice is refused for the
  // first Git invocation; the model corrects the whole line.
  const first = invocation.gitInvocations[0];
  if (first === undefined) return { kind: "allow" };

  const argv = tokenize(first)
    .filter(isWord)
    .map((token) => token.value)
    .filter((value) => value.length > 0);
  const args = argv[0] === "git" ? argv.slice(1) : argv;

  const row = VERB_ROWS.find((candidate) => matchesPrefix(candidate.match, args));
  const verb = args[0] ?? "";
  const rest = args.slice(1);
  const equivalent = translateEquivalent(verb, rest);

  return {
    kind: "refuse",
    verb,
    classification: row?.classification ?? "deny",
    message: row?.message ?? GENERIC_FALLBACK,
    readOnly: isReadOnly(verb, rest),
    source: typedCommand(first, args),
    ...(equivalent === undefined ? {} : { equivalent }),
  };
}

/**
 * The `jj` subcommands that run without a workspace.
 *
 * Determined empirically against `jj` 0.46.0 (`docs/13` §1): `config`, `help`,
 * `util` and `version` answer outside a repository, and `--version` / `--help` /
 * bare `jj` never reach a subcommand at all. Everything else this module sees is
 * treated as needing a workspace, because `jj` itself would fail with
 * `There is no jj repo in "."`.
 */
const JJ_REPO_FREE: ReadonlySet<string> = new Set(["config", "help", "util", "version"]);

/**
 * Global `jj` flags that take their value as the next word, so the walk below
 * does not mistake that value for a subcommand.
 *
 * `-R`/`--repository` is handled separately: naming a repository is itself a way
 * to satisfy the workspace requirement (`jj -R ../repo log` works from anywhere).
 */
const JJ_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--at-operation",
  "--color",
  "--config",
  "--config-toml",
]);

/** What the workspace rule found. */
export type JjDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "refuse"; readonly verb: string };

/** How one `jj` fragment relates to the workspace rule. */
interface JjFragment {
  /** True for `jj git init` / `jj git clone`, which create the workspace. */
  readonly creates: boolean;
  /** The subcommand that needs a workspace, when the fragment has one. */
  readonly verb?: string;
}

/**
 * Decide whether a `jj` invocation needs a workspace it does not have.
 *
 * Only the first offending fragment is reported: the model corrects the whole
 * command line, and a second refusal adds nothing.
 *
 * A fragment that *creates* a workspace (`jj git init`, `jj git clone`) clears
 * the rule for later fragments on the same line — `jj git init --colocate && jj
 * log` works, so refusing it would be wrong — and it is never itself refused,
 * which is what keeps the refusal message from naming a command the guard then
 * blocks.
 *
 * @param invocation - the parsed invocation. A command that never runs `jj`
 *   returns `allow`.
 */
export function classifyJjInvocation(invocation: Invocation): JjDecision {
  let creates = false;
  for (const raw of invocation.jjInvocations) {
    const argv = tokenize(raw)
      .filter(isWord)
      .map((token) => token.value)
      .filter((value) => value.length > 0);
    const at = argv.findIndex(isJjProgram);
    if (at === -1) continue;
    const fragment = describeJjFragment(argv.slice(at + 1));
    if (fragment.creates) {
      creates = true;
      continue;
    }
    if (fragment.verb !== undefined && !creates) {
      return { kind: "refuse", verb: fragment.verb };
    }
  }
  return { kind: "allow" };
}

/** Is this argv word the `jj` binary, under either of its names? */
function isJjProgram(word: string): boolean {
  const base = (word.replaceAll("\\", "/").split("/").pop() ?? word).replace(/\.exe$/i, "");
  return base === "jj" || base === "jujutsu";
}

/**
 * Classify one `jj` fragment's subcommand.
 *
 * The first positional word is the subcommand. Walking to it has to skip the
 * global flags, and `-R`/`--repository` is special: naming a repository is
 * itself a way to satisfy the workspace requirement (`jj -R ../repo log` works
 * from anywhere), so it makes the fragment workspace-free.
 */
function describeJjFragment(args: readonly string[]): JjFragment {
  let i = 0;
  while (i < args.length) {
    const value = args[i];
    if (value === undefined) return { creates: false };
    // `--` ends the options; nothing after it can name a subcommand.
    if (value === "--") return { creates: false };
    if (value === "-R" || value === "--repository") return { creates: false };
    if ((value.startsWith("-R") && value.length > 2) || value.startsWith("--repository=")) {
      return { creates: false };
    }
    if (JJ_VALUE_FLAGS.has(value)) {
      i += 2;
      continue;
    }
    if (value.startsWith("-")) {
      i += 1;
      continue;
    }
    if (JJ_REPO_FREE.has(value)) return { creates: false };
    if (value !== "git") return { creates: false, verb: value };
    const sub = nextPositional(args, i + 1);
    if (sub === undefined) return { creates: false };
    if (sub === "init" || sub === "clone") return { creates: true };
    return { creates: false, verb: `git ${sub}` };
  }
  return { creates: false };
}

/** The first word after `from` that is not a flag. */
function nextPositional(args: readonly string[], from: number): string | undefined {
  for (let i = from; i < args.length; i += 1) {
    const value = args[i];
    if (value === undefined) return undefined;
    if (value.startsWith("-")) continue;
    return value;
  }
  return undefined;
}

/**
 * The Git invocation as the model wrote it, for the composed reason.
 *
 * The resolver already hands back the fragment's original text, quotes
 * and all, which is what the model recognises as its own command:
 * `git commit -m 'fix the thing'`, not `git commit -m fix the thing`.
 *
 * Two things disqualify the raw text: a substitution the resolver had to
 * replace with a sentinel (`git log $(date)` does not read as the command
 * that ran), and anything multi-line. Both fall back to the re-joined
 * argv, which is lossy but honest.
 */
function typedCommand(raw: string, args: readonly string[]): string {
  const clean = !raw.includes("\u0000") && !raw.includes("$(…)") && !raw.includes("\n");
  return clean && raw.length > 0 ? raw.trim() : `git ${args.join(" ")}`.trim();
}

/**
 * Does an argv prefix match this row?
 *
 * `"<name>"` matches exactly one non-flag argument — the convention
 * `messages.ts` uses for `git branch <name>`, which would otherwise be
 * indistinguishable from the bare listing form.
 */
export function matchesPrefix(prefix: readonly string[], args: readonly string[]): boolean {
  if (prefix.length > args.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    const expected = prefix[i];
    const actual = args[i];
    if (expected === undefined || actual === undefined) return false;
    if (expected === "<name>") {
      if (actual.startsWith("-")) return false;
      continue;
    }
    if (expected !== actual) return false;
  }
  return true;
}

/** Is this command read-only, in the form given? */
export function isReadOnly(verb: string, args: readonly string[]): boolean {
  if (ALWAYS_READ_ONLY.has(verb)) return true;
  if (!READ_ONLY_VERBS.has(verb)) return false;
  return isReadOnlyForm(verb, args);
}

/**
 * Is this a positively identified listing form?
 *
 * `""` in `LISTING_FORMS` means the bare invocation, so `git branch` is a listing
 * while `git branch -d feat` is not.
 */
export function isReadOnlyForm(verb: string, args: readonly string[]): boolean {
  const forms = LISTING_FORMS[verb];
  if (forms === undefined) return false;
  const form = args[0] ?? "";
  return forms.includes(form);
}
