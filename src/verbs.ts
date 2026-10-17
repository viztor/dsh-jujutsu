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
